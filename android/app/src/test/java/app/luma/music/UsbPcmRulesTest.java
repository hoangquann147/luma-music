package app.luma.music;

import org.junit.Test;
import static org.junit.Assert.*;

public final class UsbPcmRulesTest {
    @Test public void decoderTruncationMustNeverBeCalledBitPerfect() {
        assertFalse(UsbPcmRules.lossless(24, 2, 21)); // Source24 already lost bits in16-bit decoder.
        assertFalse(UsbPcmRules.lossless(32, 4, 22)); // Float32 has24-bit significant precision.
        assertFalse(UsbPcmRules.lossless(24, 4, 2)); // Output16 discards source24 detail.
        assertFalse(UsbPcmRules.lossless(0, 2, 2)); // Unknown source depth cannot be proved lossless.
        assertFalse(UsbPcmRules.lossless(33, 22, 22));
    }
    @Test public void exactRepackingIsAllowedWithoutDsp() {
        assertTrue(UsbPcmRules.lossless(16, 2, 21));
        assertTrue(UsbPcmRules.lossless(16, 2, 4));
        assertTrue(UsbPcmRules.lossless(24, 4, 21));
        assertTrue(UsbPcmRules.lossless(24, 4, 22));
        assertTrue(UsbPcmRules.lossless(32, 22, 22));
    }
    @Test public void matchingSourceIntegerFormatIsPreferredToFloatOrPadding() {
        assertTrue(UsbPcmRules.encodingScore(16, 2) < UsbPcmRules.encodingScore(16, 21));
        assertTrue(UsbPcmRules.encodingScore(24, 21) < UsbPcmRules.encodingScore(24, 4));
        assertTrue(UsbPcmRules.encodingScore(24, 4) < UsbPcmRules.encodingScore(24, 22));
        assertEquals(Integer.MAX_VALUE, UsbPcmRules.encodingScore(24, 2));
    }
}
