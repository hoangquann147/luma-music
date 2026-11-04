package app.luma.music;

import java.io.File;
import java.io.RandomAccessFile;
import java.io.IOException;
import org.junit.Test;
import static org.junit.Assert.*;

public class FlacStreamInfoTest {
    @Test public void nativeStreamInfoReadsOriginalDepthRateChannelsAndDuration() throws Exception {
        for(int bits:new int[]{16,24,32}) {
            File file=File.createTempFile("luma-streaminfo-", ".flac");
            try {
                try(RandomAccessFile out=new RandomAccessFile(file,"rw")){
                    out.writeInt(0x664c6143);out.write(new byte[]{(byte)128,0,0,34});out.write(new byte[10]);
                    out.writeLong((192000L<<44)|(1L<<41)|((bits-1L)<<36)|384000L);out.write(new byte[16]);
                }
                FlacStreamInfo info=FlacStreamInfo.read(file.getPath());
                assertEquals(192000,info.sampleRate);assertEquals(2,info.channels);assertEquals(bits,info.bitsPerSample);assertEquals(2000,info.durationMs());
            }finally{file.delete();}
        }
    }
    @Test public void truncatedStreamInfoIsRejectedBeforeDecoderOpens() throws Exception {
        File file=File.createTempFile("luma-truncated-", ".flac");
        try {
            try(RandomAccessFile out=new RandomAccessFile(file,"rw")){out.writeInt(0x664c6143);out.write(new byte[]{(byte)128,0,0,34});out.write(new byte[18]);}
            assertThrows(IOException.class,()->FlacStreamInfo.read(file.getPath()));
        }finally{file.delete();}
    }
}
