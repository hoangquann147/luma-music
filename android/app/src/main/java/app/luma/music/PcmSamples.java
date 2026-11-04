package app.luma.music;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** PCM numeric conversion, independent of Android so precision can be regression-tested. */
public final class PcmSamples {
    public static final int PCM_16 = 2, PCM_FLOAT = 4, PCM_24 = 21, PCM_32 = 22;
    private PcmSamples() {}
    public static int bytesPerSample(int encoding) {
        switch (encoding) {
            case PCM_16: return 2;
            case PCM_24: return 3;
            case PCM_FLOAT: case PCM_32: return 4;
            default: throw new IllegalArgumentException("Định dạng PCM không được hỗ trợ: " + encoding);
        }
    }
    public static boolean preservesBits(int encoding, int sourceBits) {
        return sourceBits <= (encoding == PCM_FLOAT ? 24 : bytesPerSample(encoding) * 8);
    }
    public static void decode(ByteBuffer input, int encoding, double[] samples, int count) {
        input.order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < count; i++) {
            switch (encoding) {
                case PCM_16: samples[i] = input.getShort() / 32768.0; break;
                case PCM_24: {
                    int v = (input.get() & 255) | ((input.get() & 255) << 8) | (input.get() << 16);
                    samples[i] = v / 8388608.0; break;
                }
                case PCM_32: samples[i] = input.getInt() / 2147483648.0; break;
                case PCM_FLOAT: {
                    float v = input.getFloat();
                    samples[i] = Float.isFinite(v) ? v : 0; break;
                }
                default: throw new IllegalArgumentException("PCM không được hỗ trợ.");
            }
        }
    }
    public static void encode(double[] samples, int count, int encoding, ByteBuffer output) {
        output.clear(); output.order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < count; i++) {
            double value = Double.isFinite(samples[i]) ? samples[i] : 0;
            switch (encoding) {
                case PCM_16: output.putShort((short) quantize(value, 32768.0, -32768, 32767)); break;
                case PCM_24: {
                    int v = (int) quantize(value, 8388608.0, -8388608, 8388607);
                    output.put((byte) v).put((byte) (v >> 8)).put((byte) (v >> 16)); break;
                }
                case PCM_32: output.putInt((int) quantize(value, 2147483648.0, Integer.MIN_VALUE, Integer.MAX_VALUE)); break;
                case PCM_FLOAT: output.putFloat((float) Math.max(-1, Math.min(1, value))); break;
                default: throw new IllegalArgumentException("PCM không được hỗ trợ.");
            }
        }
        output.flip();
    }
    private static long quantize(double value, double scale, long min, long max) {
        return Math.max(min, Math.min(max, Math.round(value * scale)));
    }
}
