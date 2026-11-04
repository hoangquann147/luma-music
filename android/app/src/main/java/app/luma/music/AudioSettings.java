package app.luma.music;

import android.content.Context;
import android.content.SharedPreferences;

/** A validated snapshot of the user's audio controls. Stored locally, independently of Drive. */
public final class AudioSettings {
    public static final String BAND_PEAK = "peak";
    public static final String BAND_LOW_SHELF = "low_shelf";
    public static final String BAND_HIGH_SHELF = "high_shelf";
    public static final int BAND_COUNT = 10;
    private static final String PREFS = "luma_audio_v1";
    private static final double[] FREQUENCIES = {31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000};

    public static final class Band {
        public final String type;
        public final double frequencyHz, gainDb, q;
        public final boolean enabled;

        public Band(String type, double frequencyHz, double gainDb, double q, boolean enabled) {
            this.type = BAND_LOW_SHELF.equals(type) ? BAND_LOW_SHELF
                    : BAND_HIGH_SHELF.equals(type) ? BAND_HIGH_SHELF : BAND_PEAK;
            this.frequencyHz = bounded(frequencyHz, 20, 20000, 1000);
            this.gainDb = bounded(gainDb, -12, 12, 0);
            this.q = bounded(q, .1, 10, 1);
            this.enabled = enabled;
        }
    }

    public final boolean eqEnabled, autoHeadroom, usbBitPerfect;
    public final double preampDb, balance;
    /** 0 follows Android routing. Explicit device IDs are valid for the current attachment only. */
    public final int outputDeviceId, pcmEncoding;
    /** A defensive copy of immutable bands; consumers should take their own snapshot before use. */
    public final Band[] bands;

    public AudioSettings(boolean eqEnabled, double preampDb, double balance, boolean autoHeadroom,
                         Band[] bands, int outputDeviceId, boolean usbBitPerfect, int pcmEncoding) {
        this.eqEnabled = eqEnabled;
        this.preampDb = bounded(preampDb, -24, 0, 0);
        this.balance = bounded(balance, -1, 1, 0);
        this.autoHeadroom = autoHeadroom;
        this.usbBitPerfect = usbBitPerfect;
        this.outputDeviceId = Math.max(0, outputDeviceId);
        // AudioFormat constants are compile-time values, allowing validation in JVM tests.
        this.pcmEncoding = pcmEncoding == 2 || pcmEncoding == 4 || pcmEncoding == 21 || pcmEncoding == 22 ? pcmEncoding : 0;
        this.bands = new Band[BAND_COUNT];
        for (int i = 0; i < BAND_COUNT; i++) {
            Band input = bands != null && i < bands.length ? bands[i] : null;
            this.bands[i] = input == null ? new Band(BAND_PEAK, FREQUENCIES[i], 0, 1, true)
                    : new Band(input.type, input.frequencyHz, input.gainDb, input.q, input.enabled);
        }
    }

    public static AudioSettings defaults() { return new AudioSettings(false, 0, 0, true, null, 0, false, 0); }

    public AudioSettings snapshot() {
        return new AudioSettings(eqEnabled, preampDb, balance, autoHeadroom, bands, outputDeviceId, usbBitPerfect, pcmEncoding);
    }

    public static AudioSettings load(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            Band[] bands = new Band[BAND_COUNT];
            for (int i = 0; i < BAND_COUNT; i++) {
                String key = "band_" + i + "_";
                bands[i] = new Band(p.getString(key + "type", BAND_PEAK),
                        p.getFloat(key + "frequency", (float) FREQUENCIES[i]),
                        p.getFloat(key + "gain", 0), p.getFloat(key + "q", 1), p.getBoolean(key + "enabled", true));
            }
            return new AudioSettings(p.getBoolean("eq", false), p.getFloat("preamp", 0),
                    p.getFloat("balance", 0), p.getBoolean("headroom", true), bands,
                    p.getInt("device", 0), p.getBoolean("bit_perfect", false), p.getInt("pcm", 0));
        } catch (ClassCastException ignored) { return defaults(); }
    }

    public void save(Context context) {
        AudioSettings safe = snapshot();
        SharedPreferences.Editor e = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("eq", safe.eqEnabled).putFloat("preamp", (float) safe.preampDb)
                .putFloat("balance", (float) safe.balance).putBoolean("headroom", safe.autoHeadroom)
                .putInt("device", safe.outputDeviceId).putBoolean("bit_perfect", safe.usbBitPerfect)
                .putInt("pcm", safe.pcmEncoding);
        for (int i = 0; i < BAND_COUNT; i++) {
            String key = "band_" + i + "_"; Band b = safe.bands[i];
            e.putString(key + "type", b.type).putFloat(key + "frequency", (float) b.frequencyHz)
                    .putFloat(key + "gain", (float) b.gainDb).putFloat(key + "q", (float) b.q).putBoolean(key + "enabled", b.enabled);
        }
        e.apply();
    }

    private static double bounded(double value, double min, double max, double fallback) {
        return Double.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    }
}
