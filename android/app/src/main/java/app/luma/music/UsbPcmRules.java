package app.luma.music;

/** Exact integer precision rules shared by USB negotiation and host-side tests. */
final class UsbPcmRules {
    private UsbPcmRules() {}
    static int precisionBits(int encoding) {
        if (encoding == 2) return 16;
        if (encoding == 4 || encoding == 21) return 24; // IEEE-754 float exactly represents a 24-bit PCM word.
        if (encoding == 22) return 32;
        return 0;
    }
    static boolean lossless(int sourceBits, int decoderEncoding, int outputEncoding) {
        return sourceBits > 0 && sourceBits <= 32
                && precisionBits(decoderEncoding) >= sourceBits && precisionBits(outputEncoding) >= sourceBits;
    }
    static int encodingScore(int sourceBits, int encoding) {
        int precision = precisionBits(encoding);
        if (precision < sourceBits || sourceBits <= 0) return Integer.MAX_VALUE;
        // Prefer an integer format of the source's precision; float is still exact for <=24-bit source.
        return (precision - sourceBits) * 10 + (encoding == 4 ? 3 : encoding == 22 ? 2 : encoding == 21 ? 1 : 0);
    }
}
