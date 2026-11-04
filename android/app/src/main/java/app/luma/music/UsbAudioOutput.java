package app.luma.music;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioMixerAttributes;
import android.media.AudioRouting;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** USB routing through Android's public audio API. This is not a proprietary USB Host driver. */
public final class UsbAudioOutput implements AutoCloseable {
    public interface Listener {
        void onRouteLost(String reason);
        void onStatusChanged(String description);
    }
    public static final class Device {
        public final int id;
        public final String name, detail;
        public final boolean usb, bitPerfectCapable;
        private Device(AudioDeviceInfo d, boolean capable) {
            id = d.getId(); name = label(d); usb = isUsb(d); bitPerfectCapable = capable;
            StringBuilder rates = new StringBuilder();
            for (int r : d.getSampleRates()) {
                if (rates.length() > 55) { rates.append("…"); break; }
                if (rates.length() > 0) rates.append(" / ");
                rates.append(String.format(Locale.US, "%.1f", r / 1000.0));
            }
            detail = (usb ? "USB DAC" : routeType(d)) + (rates.length() == 0 ? "" : " · " + rates + " kHz")
                    + (capable ? " · Android có BIT_PERFECT" : "");
        }
    }
    public static final class Plan {
        public final int encoding;
        public final AudioDeviceInfo device;
        public final boolean bitPerfect;
        public final String description;
        private final AudioAttributes attributes;
        private final Object mixer;
        private Plan(int encoding, AudioDeviceInfo device, boolean bitPerfect, String description,
                     AudioAttributes attributes, Object mixer) {
            this.encoding = encoding; this.device = device; this.bitPerfect = bitPerfect;
            this.description = description; this.attributes = attributes; this.mixer = mixer;
        }
    }

    private final AudioManager manager;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Plan active;
    private AudioTrack track;
    private AudioRouting.OnRoutingChangedListener routingListener;
    private Object mixerListener;
    private boolean deviceCallbackRegistered, closed, failed;
    private int routeChecks;
    private String lastStatus = "";
    private final AudioDeviceCallback deviceCallback = new AudioDeviceCallback() {
        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
            synchronized (UsbAudioOutput.this) {
                if (active == null || active.device == null) return;
                for (AudioDeviceInfo d : removed) if (d.getId() == active.device.getId()) {
                    routeLost("Thiết bị âm thanh đã ngắt kết nối. Luma đã dừng để tránh chuyển tiếng sang loa."); break;
                }
            }
        }
    };
    private final Runnable monitor = new Runnable() {
        @Override public void run() {
            synchronized (UsbAudioOutput.this) {
                if (closed || active == null || track == null || failed) return;
                verifyRoute();
                if (!closed && !failed) main.postDelayed(this, 300);
            }
        }
    };

    public UsbAudioOutput(Context context, Listener listener) {
        this.manager = context.getApplicationContext().getSystemService(AudioManager.class);
        this.listener = listener;
    }

    public static List<Device> devices(Context context) {
        AudioManager manager = context.getSystemService(AudioManager.class);
        if (manager == null) return Collections.emptyList();
        List<Device> result = new ArrayList<>();
        for (AudioDeviceInfo d : manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            boolean capable = false;
            if (isUsb(d) && Build.VERSION.SDK_INT >= 34) {
                try { capable = Api34.hasBitPerfect(manager, d); } catch (RuntimeException ignored) {}
            }
            result.add(new Device(d, capable));
        }
        return result;
    }

    public static String capabilitySummary(Context context) {
        if (Build.VERSION.SDK_INT < 34)
            return "Android " + Build.VERSION.RELEASE + ": USB PCM thông thường dùng được khi hệ thống nhận DAC. USB BIT_PERFECT cần Android 14+ và hỗ trợ từ máy/DAC; APK này không có driver USB riêng của HiBy.";
        List<Device> devices = devices(context); int usb = 0, bit = 0;
        for (Device d : devices) if (d.usb) { usb++; if (d.bitPerfectCapable) bit++; }
        if (usb == 0) return "Chưa thấy USB DAC. Cắm DAC/OTG rồi quét lại. BIT_PERFECT chỉ bật được nếu Android công bố cấu hình phù hợp với bài hát.";
        if (bit == 0) return "Đã thấy USB DAC nhưng máy chưa công bố BIT_PERFECT. Có thể dùng PCM + PEQ qua Android; chế độ USB bit-perfect sẽ không tự chuyển về loa khi không được hỗ trợ.";
        return "Android công bố BIT_PERFECT cho " + bit + " USB DAC. Luma sẽ kiểm tra từng bài: sample rate, kênh, bit depth và đường ra; PEQ/preamp/balance bị bỏ qua trong chế độ này.";
    }

    /** Must run BEFORE constructing AudioTrack: a preferred mixer is a stream-opening preference. */
    public synchronized Plan plan(AudioSettings settings, AudioAttributes attributes,
                                  int sampleRate, int channels, int sourceBits, int decoderEncoding) throws IOException {
        clearCurrent(); closed = false; failed = false; routeChecks = 0; lastStatus = "";
        if (manager == null) throw new IOException("Máy không cung cấp AudioManager.");
        if (channels != 1 && channels != 2) throw new IOException("Bộ phát PCM hiện hỗ trợ FLAC mono/stereo.");
        AudioDeviceInfo selected = null;
        AudioDeviceInfo[] outputs = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
        if (settings.outputDeviceId != 0) {
            for (AudioDeviceInfo d : outputs) if (d.getId() == settings.outputDeviceId) selected = d;
            if (selected == null) throw new IOException("Thiết bị âm thanh đã thay đổi. Vào Âm thanh → quét lại và chọn lại đường ra.");
        }
        boolean dsp = settings.eqEnabled || settings.balance != 0;
        int encoding = settings.pcmEncoding == 0 ? (!settings.usbBitPerfect && dsp ? AudioFormat.ENCODING_PCM_FLOAT : decoderEncoding) : settings.pcmEncoding;
        if (UsbPcmRules.precisionBits(encoding) == 0) encoding = AudioFormat.ENCODING_PCM_16BIT;
        if (Build.VERSION.SDK_INT < 31 && (encoding == 21 || encoding == 22))
            throw new IOException("PCM 24/32-bit integer qua AudioTrack cần Android 12+. Hãy chọn PCM tự động hoặc float.");

        Object mixer = null;
        if (settings.usbBitPerfect) {
            if (Build.VERSION.SDK_INT < 34)
                throw new IOException("USB BIT_PERFECT của Android cần Android 14+. Bản Android hiện tại chưa có API này; không giả lập chế độ exclusive.");
            if (selected == null) {
                int usbCount = 0;
                for (AudioDeviceInfo d : outputs) if (isUsb(d)) { selected = d; usbCount++; }
                if (usbCount != 1) throw new IOException(usbCount == 0 ? "Cắm USB DAC trước khi bật USB bit-perfect." : "Có nhiều USB DAC. Hãy chọn đường ra cụ thể.");
            }
            if (!isUsb(selected)) throw new IOException("USB bit-perfect cần chọn USB DAC, không dùng loa/Bluetooth.");
            if (!UsbPcmRules.lossless(sourceBits, decoderEncoding, decoderEncoding))
                throw new IOException("Bộ giải mã Android chưa trả PCM đủ độ sâu bit của file này. Luma đã dừng thay vì báo bit-perfect sai.");
            try {
                mixer = Api34.choose(manager, selected, sampleRate, channels, sourceBits, decoderEncoding, settings.pcmEncoding);
                if (mixer == null) throw new IOException("Máy/DAC không công bố USB BIT_PERFECT cho " + sampleRate + " Hz · " + channels + " kênh · " + sourceBits + "-bit. Chọn chế độ PCM thường để nghe qua Android.");
                encoding = Api34.encoding(mixer);
            } catch (IOException e) { throw e; }
            catch (RuntimeException e) { throw new IOException("Android từ chối cấu hình USB bit-perfect: " + e.getMessage(), e); }
        }
        String format = String.format(Locale.US, "%.1f kHz · %s · %s", sampleRate / 1000.0, encodingName(encoding), channels == 1 ? "mono" : "stereo");
        if (!settings.usbBitPerfect && sourceBits > 0 && UsbPcmRules.precisionBits(encoding) < sourceBits)
            format += " · đầu ra giảm độ sâu bit so với nguồn " + sourceBits + "-bit";
        if (!settings.usbBitPerfect && sourceBits > 0 && UsbPcmRules.precisionBits(decoderEncoding) < sourceBits)
            format += " · decoder Android giảm độ sâu bit của nguồn";
        String route = selected == null ? "Đường ra tự động của Android" : label(selected);
        Plan p = new Plan(encoding, selected, settings.usbBitPerfect,
                (settings.usbBitPerfect ? "Đã yêu cầu USB BIT_PERFECT · " : "Luồng ứng dụng PCM · ") + format + " · " + route
                        + (settings.usbBitPerfect ? "" : " · Android có thể resample"), attributes, mixer);
        active = p;
        if (p.bitPerfect) {
            try {
                mixerListener = Api34.listen(manager, main, (changedAttributes, changedDevice, changedMixer) -> {
                    synchronized (UsbAudioOutput.this) {
                        if (closed || active != p || failed || changedDevice.getId() != p.device.getId() || !changedAttributes.equals(p.attributes)) return;
                        if (!Api34.matches(changedMixer, p.mixer)) routeLost("Android đã thay đổi/hủy cấu hình USB bit-perfect. Luma đã dừng phát.");
                        else verifyRoute();
                    }
                });
                if (!Api34.set(manager, attributes, selected, mixer)) throw new IOException("Android không chấp nhận USB BIT_PERFECT cho cấu hình này.");
            } catch (RuntimeException | IOException e) {
                clearCurrent();
                if (e instanceof IOException) throw (IOException) e;
                throw new IOException("Không bật được USB bit-perfect: " + e.getMessage(), e);
            }
        }
        return p;
    }

    public synchronized void configure(AudioTrack audioTrack, Plan plan) throws IOException {
        if (closed || active != plan) throw new IOException("Cấu hình âm thanh đã hết hiệu lực.");
        if (plan.bitPerfect && !Api34.trackMatches(audioTrack, plan.mixer)) {
            clearCurrent(); throw new IOException("Định dạng AudioTrack không khớp cấu hình USB bit-perfect. Luma không phát luồng sai định dạng.");
        }
        track = audioTrack;
        if (plan.device != null && !track.setPreferredDevice(plan.device)) {
            clearCurrent(); throw new IOException("Android không chấp nhận đường ra đã chọn. Không tự chuyển sang loa.");
        }
        routingListener = routing -> { synchronized (UsbAudioOutput.this) { if (!closed && active == plan) verifyRoute(); } };
        track.addOnRoutingChangedListener(routingListener, main);
        manager.registerAudioDeviceCallback(deviceCallback, main); deviceCallbackRegistered = true;
        status(plan.description + (plan.device == null ? "" : " · chờ xác nhận đường ra"));
        main.removeCallbacks(monitor); main.post(monitor);
    }

    private void verifyRoute() {
        if (track == null || active == null || failed || closed) return;
        AudioDeviceInfo routed;
        try { routed = track.getRoutedDevice(); } catch (RuntimeException ignored) { return; }
        if (active.device != null) {
            boolean playing;
            try { playing = track.getPlayState() == AudioTrack.PLAYSTATE_PLAYING; } catch (RuntimeException e) { return; }
            if (routed != null && routed.getId() != active.device.getId()) {
                routeLost("Đường âm thanh đã chuyển khỏi thiết bị được chọn. Luma đã dừng để tránh phát sang loa."); return;
            }
            if (routed == null) {
                if (playing && ++routeChecks >= 10) routeLost("Android chưa xác nhận đường ra đã chọn. Luma đã dừng; kiểm tra DAC rồi phát lại.");
                return;
            }
            routeChecks = 0;
        }
        if (active.bitPerfect) {
            try {
                if (!Api34.matches(Api34.get(manager, active.attributes, active.device), active.mixer)) {
                    routeLost("Android không còn giữ cấu hình USB bit-perfect. Luma đã dừng phát."); return;
                }
            } catch (RuntimeException e) { routeLost("Không kiểm tra được cấu hình USB bit-perfect. Luma đã dừng phát."); return; }
            status(active.description.replace("Đã yêu cầu USB BIT_PERFECT", "USB BIT_PERFECT · Android nhận cấu hình") + " · đường ra đã xác nhận");
        } else if (routed != null) {
            status(active.description + (active.device == null ? " → " + label(routed) : " · đường ra đã xác nhận"));
        }
    }

    private void routeLost(String reason) {
        if (failed || closed) return;
        failed = true;
        final Plan p = active;
        Runnable notify = () -> { synchronized (UsbAudioOutput.this) { if (closed || active != p) return; } if (listener != null) listener.onRouteLost(reason); };
        // Device/routing/mixer callbacks run on main. Notify the decoder's stop flag before
        // pausing AudioTrack, so its worker cannot observe a paused track and restart it.
        if (Looper.myLooper() == main.getLooper()) notify.run(); else main.post(notify);
        if (track != null) try { track.pause(); track.flush(); } catch (RuntimeException ignored) {}
    }
    private void status(String value) {
        if (value.equals(lastStatus)) return; lastStatus = value; final Plan p = active;
        main.post(() -> { synchronized (UsbAudioOutput.this) { if (closed || active != p) return; } if (listener != null) listener.onStatusChanged(value); });
    }
    private void clearCurrent() {
        main.removeCallbacks(monitor);
        if (track != null && routingListener != null) try { track.removeOnRoutingChangedListener(routingListener); } catch (RuntimeException ignored) {}
        routingListener = null; track = null;
        if (deviceCallbackRegistered) { try { manager.unregisterAudioDeviceCallback(deviceCallback); } catch (RuntimeException ignored) {} deviceCallbackRegistered = false; }
        if (Build.VERSION.SDK_INT >= 34) {
            if (mixerListener != null) { try { Api34.unlisten(manager, mixerListener); } catch (RuntimeException ignored) {} mixerListener = null; }
            if (active != null && active.bitPerfect) try { Api34.clear(manager, active.attributes, active.device); } catch (RuntimeException ignored) {}
        }
        active = null;
    }
    @Override public synchronized void close() { closed = true; clearCurrent(); }

    public static String encodingName(int encoding) {
        if (encoding == 2) return "PCM 16-bit";
        if (encoding == 4) return "PCM float 32-bit";
        if (encoding == 21) return "PCM 24-bit";
        if (encoding == 22) return "PCM 32-bit";
        return "PCM không xác định";
    }
    private static boolean isUsb(AudioDeviceInfo d) { return d.getType() == AudioDeviceInfo.TYPE_USB_DEVICE || d.getType() == AudioDeviceInfo.TYPE_USB_HEADSET || d.getType() == AudioDeviceInfo.TYPE_USB_ACCESSORY; }
    private static String label(AudioDeviceInfo d) { String label = d.getProductName() == null ? "" : d.getProductName().toString().trim(); return label.isEmpty() ? routeType(d) : label; }
    private static String routeType(AudioDeviceInfo d) {
        switch (d.getType()) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "Loa điện thoại";
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "Loa thoại";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP: case AudioDeviceInfo.TYPE_BLE_HEADSET: return "Bluetooth";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "Tai nghe có dây";
            default: return isUsb(d) ? "USB DAC" : "Thiết bị âm thanh";
        }
    }

    /** API-34 types stay inside this class so older Android runtimes never resolve their methods. */
    @android.annotation.TargetApi(34)
    private static final class Api34 {
        interface MixerChange { void changed(AudioAttributes attrs, AudioDeviceInfo device, Object mixer); }
        static boolean hasBitPerfect(AudioManager manager, AudioDeviceInfo device) {
            for (AudioMixerAttributes a : manager.getSupportedMixerAttributes(device))
                if (a.getMixerBehavior() == AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT) return true;
            return false;
        }
        static Object choose(AudioManager manager, AudioDeviceInfo device, int rate, int channels, int bits, int decoded, int requested) {
            AudioMixerAttributes best = null; int score = Integer.MAX_VALUE;
            int mask = channels == 1 ? AudioFormat.CHANNEL_OUT_MONO : AudioFormat.CHANNEL_OUT_STEREO;
            for (AudioMixerAttributes a : manager.getSupportedMixerAttributes(device)) {
                AudioFormat f = a.getFormat();
                if (a.getMixerBehavior() != AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT || f.getSampleRate() != rate
                        || f.getChannelMask() != mask || (requested != 0 && f.getEncoding() != requested)
                        || !UsbPcmRules.lossless(bits, decoded, f.getEncoding())) continue;
                int next = UsbPcmRules.encodingScore(bits, f.getEncoding());
                if (next < score) { score = next; best = a; }
            }
            return best;
        }
        static int encoding(Object mixer) { return ((AudioMixerAttributes) mixer).getFormat().getEncoding(); }
        static boolean trackMatches(AudioTrack track, Object mixer) {
            AudioFormat actual = track.getFormat(), expected = ((AudioMixerAttributes) mixer).getFormat();
            return actual.getEncoding() == expected.getEncoding() && actual.getSampleRate() == expected.getSampleRate()
                    && actual.getChannelMask() == expected.getChannelMask();
        }
        static Object listen(AudioManager manager, Handler handler, MixerChange callback) {
            AudioManager.OnPreferredMixerAttributesChangedListener l = (attrs, device, mixer) -> callback.changed(attrs, device, mixer);
            manager.addOnPreferredMixerAttributesChangedListener(handler::post, l); return l;
        }
        static void unlisten(AudioManager manager, Object l) { manager.removeOnPreferredMixerAttributesChangedListener((AudioManager.OnPreferredMixerAttributesChangedListener) l); }
        static boolean set(AudioManager manager, AudioAttributes attrs, AudioDeviceInfo device, Object mixer) { return manager.setPreferredMixerAttributes(attrs, device, (AudioMixerAttributes) mixer); }
        static Object get(AudioManager manager, AudioAttributes attrs, AudioDeviceInfo device) { return manager.getPreferredMixerAttributes(attrs, device); }
        static void clear(AudioManager manager, AudioAttributes attrs, AudioDeviceInfo device) { manager.clearPreferredMixerAttributes(attrs, device); }
        static boolean matches(Object actual, Object expected) { return actual != null && actual.equals(expected); }
    }
}
