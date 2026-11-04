package app.luma.music;

import org.junit.Test;
import static org.junit.Assert.*;

public final class AudioSettingsTest {
    @Test public void defaultsDoNotEnableSignalProcessingOrUsbOwnership() {
        AudioSettings s = AudioSettings.defaults();
        assertFalse(s.eqEnabled); assertFalse(s.usbBitPerfect);
        assertTrue(s.autoHeadroom); assertEquals(0, s.outputDeviceId); assertEquals(0, s.pcmEncoding);
        assertEquals(10, s.bands.length);
        assertEquals(31, s.bands[0].frequencyHz, 0); assertEquals(16000, s.bands[9].frequencyHz, 0);
    }

    @Test public void invalidOrNonFinitePresetValuesCannotReachDsp() {
        AudioSettings.Band extreme = new AudioSettings.Band("unexpected", Double.NaN, 99, Double.POSITIVE_INFINITY, true);
        AudioSettings.Band negative = new AudioSettings.Band(AudioSettings.BAND_LOW_SHELF, -50, -99, 0, false);
        AudioSettings s = new AudioSettings(true, Double.NEGATIVE_INFINITY, 99, true,
                new AudioSettings.Band[]{extreme, negative}, -12, true, 999);
        assertEquals(0, s.preampDb, 0); assertEquals(1, s.balance, 0); assertEquals(0, s.outputDeviceId); assertEquals(0, s.pcmEncoding);
        assertEquals(AudioSettings.BAND_PEAK, s.bands[0].type); assertEquals(1000, s.bands[0].frequencyHz, 0);
        assertEquals(12, s.bands[0].gainDb, 0); assertEquals(1, s.bands[0].q, 0);
        assertEquals(20, s.bands[1].frequencyHz, 0); assertEquals(-12, s.bands[1].gainDb, 0); assertEquals(.1, s.bands[1].q, 0);
        assertFalse(s.bands[1].enabled); assertNotNull(s.bands[9]);
    }

    @Test public void presetSnapshotsCannotBeChangedByOriginalArray() {
        AudioSettings.Band[] input = {new AudioSettings.Band(AudioSettings.BAND_HIGH_SHELF, 4200, -3, .7, true)};
        AudioSettings s = new AudioSettings(true, -7.5, -.2, false, input, 42, false, 4);
        input[0] = null;
        assertEquals(4200, s.bands[0].frequencyHz, 0);
        AudioSettings copy = s.snapshot(); s.bands[0] = null;
        assertEquals(-3, copy.bands[0].gainDb, 0);
        assertEquals(42, copy.outputDeviceId); assertEquals(4, copy.pcmEncoding);
    }

    @Test public void usbBypassPreservesUserPresetForReturningToPcm() {
        AudioSettings s = new AudioSettings(true, -4, .3, true, null, 1, true, 21);
        // The engine bypasses these controls; saving must not erase the user's normal-mode preset.
        assertTrue(s.eqEnabled); assertTrue(s.usbBitPerfect); assertEquals(-4, s.preampDb, 0); assertEquals(.3, s.balance, 0);
        assertEquals(21, s.pcmEncoding);
    }
}
