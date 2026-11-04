package app.luma.music;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

/** Streaming FLAC -> actual decoder PCM -> optional PEQ -> AudioTrack.
 * All codec/track/USB lifetime operations are serialized on one worker. prepare() cancels
 * the previous run before its successor can acquire mixer attributes or an audio route.
 */
public final class PcmPlayer {
    public interface Listener {
        void onPrepared(long durationMs);
        void onCompletion();
        void onError(String message);
        void onOutputChanged(String information);
    }
    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> new Thread(r, "Luma-PCM"));
    private final Object control = new Object();
    private volatile int generation;
    private volatile boolean closed, wantPlay, playing;
    private volatile long positionMs, durationMs;
    private volatile AudioSettings settings;
    private volatile float volume = 1;
    private long pendingSeek = -1;

    public PcmPlayer(Context context, Listener listener) {
        this.context = context.getApplicationContext(); this.listener = listener;
    }
    public void prepare(String path, AudioSettings settings) {
        if (closed) throw new IllegalStateException("Bộ phát đã đóng.");
        final AudioSettings safe=settings.snapshot();
        final int token;
        synchronized (control) {
            token = ++generation; this.settings = safe;
            wantPlay = false; playing = false; positionMs = 0; durationMs = 0; pendingSeek = -1;
            control.notifyAll();
        }
        executor.execute(() -> run(token, path, safe));
    }
    public void start() { synchronized (control) { if (!closed) { wantPlay=true; control.notifyAll(); } } }
    public void pause() { synchronized (control) { wantPlay=false; playing=false; control.notifyAll(); } }
    public void seekTo(long milliseconds) {
        synchronized (control) {
            pendingSeek = Math.max(0, durationMs > 0 ? Math.min(milliseconds, Math.max(0,durationMs-1)) : milliseconds);
            positionMs = pendingSeek; control.notifyAll();
        }
    }
    public long getCurrentPosition() { return positionMs; }
    public long getDuration() { return durationMs; }
    public boolean isPlaying() { return playing; }
    public void setVolume(float requested) {
        AudioSettings current = settings;
        if (current != null && current.usbBitPerfect && requested < .99999f) {
            pause();
            int token=generation;
            dispatch(token, () -> listener.onOutputChanged("USB bit-perfect tạm dừng vì ứng dụng khác cần âm thanh. Dữ liệu PCM không bị giảm âm lượng."));
            return;
        }
        volume = Math.max(0,Math.min(1,requested));
    }
    /** Route, encoding and bit-perfect changes require prepare(); DSP changes crossfade live. */
    public void updateDsp(AudioSettings settings) { this.settings=settings.snapshot(); synchronized (control) { control.notifyAll(); } }
    public void release() {
        synchronized (control) { if (closed) return; closed=true; ++generation; wantPlay=false; playing=false; control.notifyAll(); }
        executor.shutdown();
    }
    private boolean alive(int token) { return !closed && generation == token; }
    private void dispatch(int token, Runnable action) { main.post(() -> { if (alive(token)) action.run(); }); }
    private void waitBriefly(int token) throws InterruptedException {
        synchronized (control) { if (alive(token)) control.wait(5); }
    }
    private void waitPaused(int token) throws InterruptedException {
        synchronized(control){if(alive(token)&&!wantPlay&&pendingSeek<0)control.wait(1000);}
    }
    private long takeSeek(int token) {
        synchronized (control) { if (!alive(token)) return -1; long value=pendingSeek; pendingSeek=-1; return value; }
    }
    private boolean hasSeek() { synchronized (control) { return pendingSeek >= 0; } }

    private void run(int token, String path, AudioSettings initialSettings) {
        if (!alive(token)) return;
        MediaExtractor extractor=null; MediaCodec codec=null; AudioTrack track=null;
        UsbAudioOutput usb=null;
        PowerManager.WakeLock wake=null;
        try {
            FlacStreamInfo source=FlacStreamInfo.read(path);
            if(source.channels>2)throw new IOException("Bộ phát PCM/PEQ hiện hỗ trợ FLAC mono và stereo.");
            extractor=new MediaExtractor(); extractor.setDataSource(path);
            int stream=-1;
            for(int i=0;i<extractor.getTrackCount();i++) {
                String mime=extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
                if(mime!=null && mime.startsWith("audio/")) { stream=i;break; }
            }
            if(stream<0)throw new IOException("Không tìm thấy luồng âm thanh FLAC.");
            extractor.selectTrack(stream);
            MediaFormat input=extractor.getTrackFormat(stream);
            String mime=input.getString(MediaFormat.KEY_MIME);
            if (!"audio/flac".equals(mime)) throw new IOException("Luồng này không phải FLAC.");
            long sourceDuration=source.durationMs();
            if(sourceDuration==0 && input.containsKey(MediaFormat.KEY_DURATION))sourceDuration=input.getLong(MediaFormat.KEY_DURATION)/1000;
            synchronized(control){if(!alive(token))return;durationMs=sourceDuration;}
            int desiredDecoder=source.bitsPerSample>24 && Build.VERSION.SDK_INT>=31 ? PcmSamples.PCM_32 : source.bitsPerSample>16 ? PcmSamples.PCM_FLOAT : PcmSamples.PCM_16;
            try { codec=openDecoder(mime,input,desiredDecoder); }
            catch(RuntimeException error) {
                if(initialSettings.usbBitPerfect || desiredDecoder==PcmSamples.PCM_16)throw error;
                // Some vendor decoders reject float/32 requests. In ordinary PCM mode only,
                // retry a supported representation and report its actual depth below.
                if(desiredDecoder==PcmSamples.PCM_32) {
                    try {codec=openDecoder(mime,input,PcmSamples.PCM_FLOAT);}
                    catch(RuntimeException unsupportedFloat){codec=openDecoder(mime,input,PcmSamples.PCM_16);}
                }else codec=openDecoder(mime,input,PcmSamples.PCM_16);
            }
            PowerManager power=context.getSystemService(PowerManager.class);
            wake=power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"Luma:PCM"); wake.setReferenceCounted(false);
            final String[] routeFailure={null};
            final AtomicReference<String> signalPath=new AtomicReference<>("");
            usb=new UsbAudioOutput(context,new UsbAudioOutput.Listener(){
                @Override public void onRouteLost(String message){ synchronized(control){if(alive(token)){routeFailure[0]=message;wantPlay=false;playing=false;control.notifyAll();}} }
                @Override public void onStatusChanged(String message){String prefix=signalPath.get();String text=prefix.isEmpty()?message:prefix+" · "+message;dispatch(token,()->listener.onOutputChanged(text));}
            });
            UsbAudioOutput.Plan plan=null;
            MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();
            boolean inputEnded=false,outputEnded=false,prepared=false;
            int rate=source.sampleRate,channels=source.channels,decoderEncoding=0;
            long writtenFrames=0,baseUs=0,seekTargetUs=-1,lastRawHead=0,headWraps=0,lastWake=0,lastAudioProgress=SystemClock.elapsedRealtime(),lastDecodeProgress=SystemClock.elapsedRealtime();
            float appliedVolume=-1;
            AudioSettings activeSettings=initialSettings;
            PeqProcessor processor=null,previousProcessor=null;
            int crossfadeFrames=0,crossfadeAt=0;
            double[] samples=new double[4096*channels],previousSamples=new double[4096*channels];
            ByteBuffer converted=ByteBuffer.allocateDirect(4096*channels*4).order(ByteOrder.LITTLE_ENDIAN);
            while(alive(token)) {
                synchronized(control){if(routeFailure[0]!=null)throw new IOException(routeFailure[0]);}
                long seek=takeSeek(token);
                if(seek>=0) {
                    if(track!=null){track.pause();track.flush();}
                    codec.flush();extractor.seekTo(seek*1000,MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
                    inputEnded=false;outputEnded=false;writtenFrames=0;lastRawHead=0;headWraps=0;
                    baseUs=seek*1000;seekTargetUs=seek*1000;positionMs=seek;
                    if(processor!=null)processor.reset();previousProcessor=null;crossfadeFrames=0;
                    playing=false;lastDecodeProgress=SystemClock.elapsedRealtime();
                }
                if(prepared && !wantPlay) {
                    if(track!=null && track.getPlayState()==AudioTrack.PLAYSTATE_PLAYING)track.pause();
                    playing=false;if(wake.isHeld())wake.release();waitPaused(token);lastDecodeProgress=SystemClock.elapsedRealtime();continue;
                }
                if(prepared && wantPlay && track!=null) {
                    if(!wake.isHeld() || SystemClock.elapsedRealtime()-lastWake>5*60*1000) {
                        if(wake.isHeld())wake.release();wake.acquire(10*60*1000L);lastWake=SystemClock.elapsedRealtime();
                    }
                    if(track.getPlayState()!=AudioTrack.PLAYSTATE_PLAYING){track.play();lastAudioProgress=SystemClock.elapsedRealtime();lastDecodeProgress=lastAudioProgress;}
                    playing=true;
                    float targetVolume=plan!=null && plan.bitPerfect ? 1 : volume;
                    if(appliedVolume!=targetVolume){track.setVolume(targetVolume);appliedVolume=targetVolume;}
                }
                if(!inputEnded && !outputEnded) {
                    int inputIndex=codec.dequeueInputBuffer(0);
                    if(inputIndex>=0) {
                        ByteBuffer buffer=codec.getInputBuffer(inputIndex);
                        if(buffer==null)throw new IOException("Bộ giải mã không cung cấp bộ đệm đầu vào.");
                        int size=extractor.readSampleData(buffer,0);
                        if(size<0){codec.queueInputBuffer(inputIndex,0,0,0,MediaCodec.BUFFER_FLAG_END_OF_STREAM);inputEnded=true;}
                        else{codec.queueInputBuffer(inputIndex,0,size,extractor.getSampleTime(),0);extractor.advance();}
                        lastDecodeProgress=SystemClock.elapsedRealtime();
                    }
                }
                int outputIndex=outputEnded ? MediaCodec.INFO_TRY_AGAIN_LATER : codec.dequeueOutputBuffer(info,10000);
                if(outputIndex==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    lastDecodeProgress=SystemClock.elapsedRealtime();
                    MediaFormat output=codec.getOutputFormat();
                    int newRate=output.getInteger(MediaFormat.KEY_SAMPLE_RATE),newChannels=output.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    int newEncoding=output.containsKey(MediaFormat.KEY_PCM_ENCODING)?output.getInteger(MediaFormat.KEY_PCM_ENCODING):PcmSamples.PCM_16;
                    PcmSamples.bytesPerSample(newEncoding);
                    if(newRate!=source.sampleRate||newChannels!=source.channels)throw new IOException("Bộ giải mã thay đổi tần số/kênh của file; dừng để tránh đổi định dạng ngoài ý muốn.");
                    if(track!=null && (rate!=newRate||channels!=newChannels||decoderEncoding!=newEncoding))throw new IOException("Định dạng PCM thay đổi giữa bài hát.");
                    rate=newRate;channels=newChannels;decoderEncoding=newEncoding;
                    if(track==null) {
                        AudioAttributes attrs=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
                        plan=usb.plan(initialSettings,attrs,rate,channels,source.bitsPerSample,decoderEncoding);
                        int mask=channels==1?AudioFormat.CHANNEL_OUT_MONO:AudioFormat.CHANNEL_OUT_STEREO;
                        int min=AudioTrack.getMinBufferSize(rate,mask,plan.encoding);
                        if(min<=0)throw new IOException("Điện thoại không mở được định dạng PCM đã chọn.");
                        int frameBytes=channels*PcmSamples.bytesPerSample(plan.encoding);
                        int capacity=Math.max(min*2,rate*frameBytes/10);capacity=(capacity+frameBytes-1)/frameBytes*frameBytes;
                        track=new AudioTrack.Builder().setAudioAttributes(attrs).setAudioFormat(new AudioFormat.Builder().setSampleRate(rate).setChannelMask(mask).setEncoding(plan.encoding).build()).setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(capacity).build();
                        if(track.getState()!=AudioTrack.STATE_INITIALIZED)throw new IOException("Không khởi tạo được đầu ra PCM.");
                        usb.configure(track,plan);
                        activeSettings=settings;
                        processor=new PeqProcessor(settingsForPlan(activeSettings,plan.bitPerfect),rate,channels);
                        String detail="FLAC "+source.bitsPerSample+" bit / "+formatRate(rate)+" kHz → PCM "+encodingName(decoderEncoding)+" → "+encodingName(plan.encoding);
                        if(!PcmSamples.preservesBits(decoderEncoding,source.bitsPerSample))detail+=" · Bộ giải mã của máy giảm độ sâu bit nguồn";
                        if(!plan.bitPerfect && !PcmSamples.preservesBits(plan.encoding,source.bitsPerSample))detail+=" · Đầu ra đã chọn giảm độ sâu bit";
                        signalPath.set(detail);final String description=detail+" · "+plan.description;dispatch(token,()->listener.onOutputChanged(description));
                        prepared=true;final long duration=durationMs;dispatch(token,()->listener.onPrepared(duration));
                    }
                } else if(outputIndex>=0) {
                    lastDecodeProgress=SystemClock.elapsedRealtime();
                    try {
                        if(info.size>0 && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG)==0) {
                            if(track==null || decoderEncoding==0)throw new IOException("Bộ giải mã chưa báo định dạng PCM.");
                            ByteBuffer decoded=codec.getOutputBuffer(outputIndex);
                            if(decoded==null)throw new IOException("Bộ giải mã không có PCM.");
                            decoded.position(info.offset);decoded.limit(info.offset+info.size);
                            int inputFrameBytes=channels*PcmSamples.bytesPerSample(decoderEncoding);
                            if(info.size%inputFrameBytes!=0)throw new IOException("Khung PCM không đầy đủ.");
                            int totalFrames=info.size/inputFrameBytes,trim=0;
                            if(seekTargetUs>=0){trim=(int)Math.min(totalFrames,Math.max(0,((seekTargetUs-info.presentationTimeUs)*rate+999999)/1000000));decoded.position(decoded.position()+trim*inputFrameBytes);}
                            if(trim<totalFrames && writtenFrames==0)baseUs=info.presentationTimeUs+trim*1000000L/rate;
                            int consumedFrames=trim;
                            while(decoded.hasRemaining() && alive(token) && !hasSeek()) {
                                synchronized(control){if(routeFailure[0]!=null)throw new IOException(routeFailure[0]);}
                                if(!wantPlay){if(track.getPlayState()==AudioTrack.PLAYSTATE_PLAYING)track.pause();playing=false;if(wake.isHeld())wake.release();waitPaused(token);lastDecodeProgress=SystemClock.elapsedRealtime();continue;}
                                if(track.getPlayState()!=AudioTrack.PLAYSTATE_PLAYING){track.play();lastAudioProgress=SystemClock.elapsedRealtime();lastDecodeProgress=lastAudioProgress;}playing=true;
                                if(!wake.isHeld()){wake.acquire(10*60*1000L);lastWake=SystemClock.elapsedRealtime();}
                                float targetVolume=plan.bitPerfect?1:volume;
                                if(appliedVolume!=targetVolume){track.setVolume(targetVolume);appliedVolume=targetVolume;}
                                AudioSettings latest=settings;
                                if(latest!=activeSettings){previousProcessor=processor;processor=new PeqProcessor(settingsForPlan(latest,plan.bitPerfect),rate,channels);activeSettings=latest;crossfadeFrames=plan.bitPerfect?0:Math.max(1,rate/100);crossfadeAt=0;if(plan.bitPerfect)previousProcessor=null;}
                                int count=Math.min(samples.length,decoded.remaining()/inputFrameBytes*channels);
                                PcmSamples.decode(decoded,decoderEncoding,samples,count);
                                if(previousProcessor!=null && crossfadeAt<crossfadeFrames){
                                    System.arraycopy(samples,0,previousSamples,0,count);previousProcessor.process(previousSamples,count);processor.process(samples,count);
                                    for(int i=0;i<count;i++){double mix=Math.min(1,(crossfadeAt+i/channels)/(double)crossfadeFrames);samples[i]=previousSamples[i]*(1-mix)+samples[i]*mix;}
                                    crossfadeAt+=count/channels;if(crossfadeAt>=crossfadeFrames)previousProcessor=null;
                                }else processor.process(samples,count);
                                PcmSamples.encode(samples,count,plan.encoding,converted);
                                int bytesWritten=0;
                                while(converted.hasRemaining() && alive(token) && !hasSeek()) {
                                    synchronized(control){if(routeFailure[0]!=null)throw new IOException(routeFailure[0]);}
                                    if(!wantPlay){if(track.getPlayState()==AudioTrack.PLAYSTATE_PLAYING)track.pause();playing=false;if(wake.isHeld())wake.release();waitPaused(token);lastDecodeProgress=SystemClock.elapsedRealtime();continue;}
                                    if(track.getPlayState()!=AudioTrack.PLAYSTATE_PLAYING){track.play();lastAudioProgress=SystemClock.elapsedRealtime();lastDecodeProgress=lastAudioProgress;}playing=true;
                                    if(!wake.isHeld()){wake.acquire(10*60*1000L);lastWake=SystemClock.elapsedRealtime();}
                                    int wrote=track.write(converted,converted.remaining(),AudioTrack.WRITE_NON_BLOCKING);
                                    if(wrote<0)throw new IOException("Đầu ra PCM bị ngắt (mã "+wrote+").");
                                    if(wrote>0)lastAudioProgress=SystemClock.elapsedRealtime();
                                    else if(SystemClock.elapsedRealtime()-lastAudioProgress>12000)throw new IOException("Đầu ra PCM không nhận dữ liệu. Kiểm tra DAC và phát lại.");
                                    bytesWritten+=wrote;
                                    if(wrote==0)waitBriefly(token);
                                    long raw=track.getPlaybackHeadPosition() & 0xffffffffL;
                                    if(raw!=lastRawHead)lastAudioProgress=SystemClock.elapsedRealtime();
                                    if(raw<lastRawHead && lastRawHead-raw>0x80000000L)headWraps++;
                                    lastRawHead=raw;
                                    long head=raw+(headWraps<<32);
                                    long accepted=writtenFrames+bytesWritten/(channels*PcmSamples.bytesPerSample(plan.encoding));
                                    if(alive(token)&&!hasSeek())positionMs=Math.min(durationMs>0?durationMs:Long.MAX_VALUE,Math.max(0,baseUs/1000+Math.min(head,accepted)*1000/rate));
                                }
                                writtenFrames+=bytesWritten/(channels*PcmSamples.bytesPerSample(plan.encoding));
                                consumedFrames+=count/channels;seekTargetUs=-1;
                            }
                        }
                    } finally {codec.releaseOutputBuffer(outputIndex,false);}
                    if((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0)outputEnded=true;
                }
                if(track!=null) {
                    long raw=track.getPlaybackHeadPosition() & 0xffffffffL;
                    if(raw!=lastRawHead)lastAudioProgress=SystemClock.elapsedRealtime();
                    if(raw<lastRawHead && lastRawHead-raw>0x80000000L)headWraps++;
                    lastRawHead=raw;
                    long head=raw+(headWraps<<32);
                    if(alive(token) && !hasSeek())positionMs=Math.min(durationMs>0?durationMs:Long.MAX_VALUE,Math.max(0,baseUs/1000+Math.min(head,writtenFrames)*1000/rate));
                    if(outputEnded && !hasSeek() && head>=writtenFrames) {
                        if(alive(token)){playing=false;wantPlay=false;dispatch(token,listener::onCompletion);}break;
                    }
                    if(wantPlay && writtenFrames>head && SystemClock.elapsedRealtime()-lastAudioProgress>12000)throw new IOException("Đầu ra PCM không tiến triển. Kiểm tra kết nối âm thanh rồi phát lại.");
                }
                if(outputEnded && track==null)throw new IOException("File FLAC không có dữ liệu PCM để phát.");
                if(!outputEnded && (!prepared||wantPlay) && SystemClock.elapsedRealtime()-lastDecodeProgress>15000)throw new IOException("Bộ giải mã FLAC không trả dữ liệu. Hãy kiểm tra file rồi phát lại.");
                if(outputEnded)waitBriefly(token);
            }
        } catch (Exception error) {
            if(alive(token)){playing=false;wantPlay=false;String message=error.getMessage();dispatch(token,()->listener.onError(message==null?"Không phát được FLAC này.":message));}
        } finally {
            if(track!=null){try{track.pause();track.flush();}catch(Exception ignored){}try{track.release();}catch(Exception ignored){}}
            if(usb!=null)try{usb.close();}catch(Exception ignored){}
            if(codec!=null){try{codec.stop();}catch(Exception ignored){}try{codec.release();}catch(Exception ignored){}}
            if(extractor!=null)try{extractor.release();}catch(Exception ignored){}
            if(wake!=null && wake.isHeld())wake.release();
        }
    }
    private static MediaCodec openDecoder(String mime,MediaFormat input,int encoding) throws IOException {
        MediaCodec decoder=MediaCodec.createDecoderByType(mime);
        try {
            input.setInteger(MediaFormat.KEY_PCM_ENCODING,encoding);
            decoder.configure(input,null,null,0);decoder.start();return decoder;
        }catch(RuntimeException error){try{decoder.release();}catch(Exception ignored){}throw error;}
    }
    private static AudioSettings settingsForPlan(AudioSettings settings,boolean bitPerfect) {
        if(settings.usbBitPerfect==bitPerfect)return settings;
        return new AudioSettings(settings.eqEnabled,settings.preampDb,settings.balance,settings.autoHeadroom,settings.bands,settings.outputDeviceId,bitPerfect,settings.pcmEncoding);
    }
    private static String encodingName(int encoding) {
        switch(encoding){case PcmSamples.PCM_16:return "16 bit";case PcmSamples.PCM_24:return "24 bit";case PcmSamples.PCM_32:return "32 bit";case PcmSamples.PCM_FLOAT:return "float 32";default:return String.valueOf(encoding);}
    }
    private static String formatRate(int rate) {return rate%1000==0?String.valueOf(rate/1000):String.format(java.util.Locale.US,"%.1f",rate/1000.0);}
}
