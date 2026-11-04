package app.luma.music;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Random;
import org.junit.Test;
import static org.junit.Assert.*;

public class PcmSamplesTest {
    @Test public void integerPcmRoundTripsEveryBitIncludingExtremes() {
        for(int encoding:new int[]{PcmSamples.PCM_16,PcmSamples.PCM_24,PcmSamples.PCM_32}) {
            int bytes=PcmSamples.bytesPerSample(encoding),count=10000;
            byte[] input=new byte[count*bytes];new Random(42).nextBytes(input);
            for(int i=0;i<bytes;i++){input[i]=(byte)(i==bytes-1?128:0);input[bytes+i]=(byte)(i==bytes-1?127:255);}
            double[] decoded=new double[count];PcmSamples.decode(ByteBuffer.wrap(input),encoding,decoded,count);
            ByteBuffer result=ByteBuffer.allocate(input.length);PcmSamples.encode(decoded,count,encoding,result);
            assertArrayEquals("PCM "+encoding,input,result.array());
        }
    }
    @Test public void twentyFourBitFloatCanRepackLosslesslyTo24Or32Bits() {
        int[] raw={-8388608,-8388607,-1,0,1,8388606,8388607};
        ByteBuffer floats=ByteBuffer.allocate(raw.length*4).order(ByteOrder.LITTLE_ENDIAN);
        for(int x:raw)floats.putFloat(x/8388608f);floats.flip();
        double[] samples=new double[raw.length];PcmSamples.decode(floats,PcmSamples.PCM_FLOAT,samples,raw.length);
        ByteBuffer packed=ByteBuffer.allocate(raw.length*4);PcmSamples.encode(samples,raw.length,PcmSamples.PCM_32,packed);
        packed.order(ByteOrder.LITTLE_ENDIAN);for(int x:raw)assertEquals(x<<8,packed.getInt());
        ByteBuffer twentyFour=ByteBuffer.allocate(raw.length*3);PcmSamples.encode(samples,raw.length,PcmSamples.PCM_24,twentyFour);
        double[] result=new double[raw.length];PcmSamples.decode(twentyFour,PcmSamples.PCM_24,result,raw.length);
        assertArrayEquals(samples,result,0);
    }
    @Test public void floatingPointIsNotMisrepresentedAs32BitIntegerPrecision() {
        assertTrue(PcmSamples.preservesBits(PcmSamples.PCM_FLOAT,24));
        assertFalse(PcmSamples.preservesBits(PcmSamples.PCM_FLOAT,25));
        assertFalse(PcmSamples.preservesBits(PcmSamples.PCM_16,24));
        assertTrue(PcmSamples.preservesBits(PcmSamples.PCM_32,32));
    }
    @Test public void overrangeAndInvalidDspSamplesAreSaturated() {
        double[] samples={-2,-1,0,1,2,Double.NaN,Double.POSITIVE_INFINITY};
        ByteBuffer result=ByteBuffer.allocate(samples.length*2);PcmSamples.encode(samples,samples.length,PcmSamples.PCM_16,result);
        result.order(ByteOrder.LITTLE_ENDIAN);
        assertEquals(-32768,result.getShort());assertEquals(-32768,result.getShort());assertEquals(0,result.getShort());
        assertEquals(32767,result.getShort());assertEquals(32767,result.getShort());assertEquals(0,result.getShort());assertEquals(0,result.getShort());
    }
}
