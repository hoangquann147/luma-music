package app.luma.music;

import java.io.IOException;
import java.io.RandomAccessFile;

/** Reads the native FLAC STREAMINFO rather than guessing precision from file size. */
public final class FlacStreamInfo {
    public final int sampleRate, channels, bitsPerSample;
    public final long totalSamples;
    private FlacStreamInfo(int rate, int channels, int bits, long samples) {
        this.sampleRate = rate; this.channels = channels; this.bitsPerSample = bits; this.totalSamples = samples;
    }
    public static FlacStreamInfo read(String path) throws IOException {
        try (RandomAccessFile file = new RandomAccessFile(path, "r")) {
            if(file.length()<42)throw new IOException("FLAC thiếu dữ liệu STREAMINFO.");
            if (file.readInt() != 0x664c6143) throw new IOException("File không có đầu FLAC hợp lệ.");
            int header = file.readUnsignedByte();
            int size = (file.readUnsignedByte() << 16) | (file.readUnsignedByte() << 8) | file.readUnsignedByte();
            if ((header & 0x7f) != 0 || size != 34) throw new IOException("FLAC thiếu STREAMINFO.");
            file.skipBytes(10);
            long packed = file.readLong();
            int rate = (int) ((packed >>> 44) & 0xfffff);
            int channels = (int) ((packed >>> 41) & 7) + 1;
            int bits = (int) ((packed >>> 36) & 31) + 1;
            long samples = packed & 0xfffffffffL;
            if (rate < 1 || bits < 4 || bits > 32) throw new IOException("STREAMINFO không hợp lệ.");
            return new FlacStreamInfo(rate, channels, bits, samples);
        }
    }
    public long durationMs() { return totalSamples * 1000L / sampleRate; }
}
