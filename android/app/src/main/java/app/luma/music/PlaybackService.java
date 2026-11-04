package app.luma.music;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.*;
import android.media.session.*;
import android.os.*;
import java.util.List;

/** FLAC -> MediaCodec PCM -> app DSP -> AudioTrack, with background transport controls. */
public final class PlaybackService extends Service {
    public static final String ACTION_CHANGED = "app.luma.music.PLAYBACK_CHANGED";
    private static final String CHANNEL = "luma-playback";
    private static final int NOTIFICATION = 201;
    private static PlaybackService instance;

    public static final class State {
        public String trackId = "", title = "Chưa phát nhạc", artist = "", error = "";
        public String outputInfo = "Chưa mở luồng PCM. Chọn một bài FLAC để xem đầu ra thực tế.";
        public long durationMs, positionMs;
        public boolean playing;
    }

    private PcmPlayer player;
    private MediaSession session;
    private AudioManager audio;
    private AudioFocusRequest focus;
    private PowerManager.WakeLock wake;
    private AudioSettings settings;
    private final State state = new State();
    private boolean ready, foreground, resumeAfterFocus, playWhenReady, destroyed;
    private long pendingSeek;
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { pause(); }
    };

    private static void send(Context c, String action, String id, long position) {
        Intent i = new Intent(c, PlaybackService.class).setAction(action);
        if (id != null) i.putExtra("id", id);
        i.putExtra("position", position);
        if (instance == null && !"play".equals(action)) {
            if ("toggle".equals(action) || "next".equals(action) || "previous".equals(action)) {
                List<LibraryRepository.Track> tracks = LibraryRepository.get(c).list();
                if (!tracks.isEmpty()) play(c, tracks.get(0).id);
            }
            return;
        }
        if ("play".equals(action) && Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }
    public static void play(Context c, String id) { send(c, "play", id, 0); }
    public static void toggle(Context c) { send(c, "toggle", null, 0); }
    public static void next(Context c) { send(c, "next", null, 0); }
    public static void previous(Context c) { send(c, "previous", null, 0); }
    public static void seekTo(Context c, long ms) { send(c, "seek", null, ms); }
    public static void applyAudioSettings(Context c) { send(c, "audio-settings", null, 0); }
    public static void stopTrack(Context c, String id) {
        if (instance != null && instance.state.trackId.equals(id)) send(c, "stop", null, 0);
    }
    public static State getState(Context c) {
        State copy = new State(); PlaybackService service = instance;
        if (service == null) return copy;
        copy.trackId = service.state.trackId; copy.title = service.state.title;
        copy.artist = service.state.artist; copy.error = service.state.error;
        copy.outputInfo = service.state.outputInfo; copy.durationMs = service.state.durationMs;
        copy.positionMs = service.ready ? service.player.getCurrentPosition() : service.pendingSeek;
        copy.playing = service.playWhenReady;
        return copy;
    }

    @Override public void onCreate() {
        super.onCreate(); instance = this; settings = AudioSettings.load(this);
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Phát nhạc", NotificationManager.IMPORTANCE_LOW));
        audio = getSystemService(AudioManager.class);
        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Luma:PCM");
        wake.setReferenceCounted(false);
        player = new PcmPlayer(this, new PcmPlayer.Listener() {
            @Override public void onPrepared(long durationMs) {
                if (destroyed) return;
                ready = true; state.durationMs = durationMs;
                MediaMetadata prior = session.getController().getMetadata();
                if (prior != null) session.setMetadata(new MediaMetadata.Builder(prior)
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs).build());
                if (pendingSeek > 0) player.seekTo(pendingSeek);
                if (playWhenReady) resume(); else publish();
            }
            @Override public void onCompletion() { if (!destroyed) advance(1); }
            @Override public void onError(String message) {
                if (destroyed) return;
                pendingSeek = player.getCurrentPosition(); ready = false;
                state.error = message; state.outputInfo = "Đầu ra đã dừng: " + message;
                playWhenReady = false; state.playing = false; resumeAfterFocus = false;
                releaseWake(); audio.abandonAudioFocusRequest(focus); publish(); detachForeground();
            }
            @Override public void onOutputChanged(String description) {
                if (!destroyed) { state.outputInfo = description; publish(); }
            }
        });
        AudioAttributes attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes)
            .setWillPauseWhenDucked(true).setOnAudioFocusChangeListener(change -> {
                if (change == AudioManager.AUDIOFOCUS_LOSS) { resumeAfterFocus = false; pause(); }
                else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ||
                         (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK && settings.usbBitPerfect)) {
                    resumeAfterFocus = playWhenReady; pauseInternal(false);
                } else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) player.setVolume(.2f);
                else if (change == AudioManager.AUDIOFOCUS_GAIN) {
                    player.setVolume(1f);
                    if (resumeAfterFocus) { resumeAfterFocus = false; resume(); }
                }
            }).build();
        session = new MediaSession(this, "Luma");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { resume(); }
            @Override public void onPause() { pause(); }
            @Override public void onSkipToNext() { advance(1); }
            @Override public void onSkipToPrevious() { previousOrRestart(); }
            @Override public void onSeekTo(long pos) { seek(pos); }
            @Override public void onStop() { pause(); stopSelf(); }
        });
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setActive(true);
        IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisy, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(noisy, filter);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        String action = intent.getAction();
        if ("play".equals(action)) { ensureForeground(); load(intent.getStringExtra("id"), 0, true); }
        else if ("toggle".equals(action)) { if (playWhenReady) pause(); else resume(); }
        else if ("next".equals(action)) advance(1);
        else if ("previous".equals(action)) previousOrRestart();
        else if ("seek".equals(action)) seek(intent.getLongExtra("position", 0));
        else if ("audio-settings".equals(action)) applySettings();
        else if ("stop".equals(action)) { pause(); stopSelf(); }
        return START_NOT_STICKY;
    }

    private void load(String id, long position, boolean shouldPlay) {
        LibraryRepository.Track track = LibraryRepository.get(this).get(id);
        if (track == null) { state.error = "Bài hát không còn trong thư viện."; publish(); stopSelf(); return; }
        ready = false; playWhenReady = shouldPlay; pendingSeek = Math.max(0, position);
        state.trackId = track.id; state.title = track.title; state.artist = track.artist;
        state.durationMs = track.durationMs; state.error = ""; state.positionMs = pendingSeek;
        state.playing = false; state.outputInfo = "Đang mở và kiểm tra luồng PCM…";
        if (shouldPlay) acquireWake(); else releaseWake();
        session.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, track.title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, track.artist).putString(MediaMetadata.METADATA_KEY_ALBUM, track.album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, track.durationMs).build());
        player.prepare(track.path, settings); publish();
    }
    private void applySettings() {
        AudioSettings next = AudioSettings.load(this);
        boolean reopen = next.outputDeviceId != settings.outputDeviceId || next.usbBitPerfect != settings.usbBitPerfect || next.pcmEncoding != settings.pcmEncoding;
        boolean oldDsp = settings.eqEnabled || settings.balance != 0;
        boolean newDsp = next.eqEnabled || next.balance != 0;
        // Auto chooses float for DSP, retaining the decoder's precision on the bypass path.
        if (!next.usbBitPerfect && next.pcmEncoding == 0 && oldDsp != newDsp) reopen = true;
        long position = ready ? player.getCurrentPosition() : pendingSeek;
        boolean wasPlaying = playWhenReady; settings = next;
        if (reopen && !state.trackId.isEmpty()) load(state.trackId, position, wasPlaying);
        else { player.updateDsp(next); publish(); }
    }
    private void resume() {
        if (!ready) {
            if (!state.error.isEmpty() && !state.trackId.isEmpty()) {
                ensureForeground(); load(state.trackId, pendingSeek, true);
            } else { playWhenReady = true; acquireWake(); }
            return;
        }
        ensureForeground();
        if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            playWhenReady = false; state.error = "Âm thanh đang được ứng dụng khác sử dụng.";
            releaseWake(); publish(); detachForeground(); return;
        }
        playWhenReady = true; acquireWake(); player.setVolume(1f); player.start(); state.playing = true; state.error = ""; publish();
    }
    private void pause() { resumeAfterFocus = false; pauseInternal(true); }
    private void pauseInternal(boolean abandon) {
        playWhenReady = false; player.pause(); state.playing = false; releaseWake();
        if (abandon) audio.abandonAudioFocusRequest(focus);
        publish(); detachForeground();
    }
    private void seek(long ms) {
        pendingSeek = Math.max(0, Math.min(ms, state.durationMs));
        if (ready) player.seekTo(pendingSeek);
        publish();
    }
    private void previousOrRestart() { if (ready && player.getCurrentPosition() > 3000) seek(0); else advance(-1); }
    private void advance(int delta) {
        List<LibraryRepository.Track> tracks = LibraryRepository.get(this).list();
        if (tracks.isEmpty()) { pause(); return; }
        int index = 0;
        for (int i = 0; i < tracks.size(); i++) if (tracks.get(i).id.equals(state.trackId)) { index = i; break; }
        ensureForeground(); settings = AudioSettings.load(this);
        load(tracks.get((index + delta + tracks.size()) % tracks.size()).id, 0, true);
    }
    private void acquireWake() { if (wake != null && !wake.isHeld()) wake.acquire(); }
    private void releaseWake() { if (wake != null && wake.isHeld()) wake.release(); }
    private void detachForeground() { if (foreground) { stopForeground(STOP_FOREGROUND_DETACH); foreground = false; } }
    private PendingIntent action(String name, int code) {
        return PendingIntent.getService(this, code, new Intent(this, PlaybackService.class).setAction(name), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_luma).setContentTitle(state.title)
            .setContentText(state.artist.isEmpty() ? "Luma · PCM / FLAC offline" : state.artist)
            .setContentIntent(open).setOnlyAlertOnce(true).setOngoing(state.playing).setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous, "Trước", action("previous", 1)).build())
            .addAction(new Notification.Action.Builder(state.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, state.playing ? "Tạm dừng" : "Phát", action("toggle", 2)).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next, "Tiếp", action("next", 3)).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2)).build();
    }
    private void ensureForeground() {
        if (!foreground) {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NOTIFICATION, notification());
            foreground = true;
        }
    }
    private void publish() {
        long position = ready ? player.getCurrentPosition() : pendingSeek;
        PlaybackState.Builder playback = new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP)
            .setState(!state.error.isEmpty() ? PlaybackState.STATE_ERROR : state.playing ? PlaybackState.STATE_PLAYING : ready ? PlaybackState.STATE_PAUSED : PlaybackState.STATE_BUFFERING, position, state.playing ? 1 : 0);
        if (!state.error.isEmpty()) playback.setErrorMessage(state.error);
        session.setPlaybackState(playback.build());
        getSystemService(NotificationManager.class).notify(NOTIFICATION, notification());
        sendBroadcast(new Intent(ACTION_CHANGED).setPackage(getPackageName()));
    }
    @Override public void onDestroy() {
        destroyed = true; instance = null;
        try { unregisterReceiver(noisy); } catch (Exception ignored) { }
        if (player != null) player.release();
        releaseWake(); if (session != null) session.release();
        if (audio != null && focus != null) audio.abandonAudioFocusRequest(focus);
        stopForeground(STOP_FOREGROUND_REMOVE); getSystemService(NotificationManager.class).cancel(NOTIFICATION);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
