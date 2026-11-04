package app.luma.music;

import org.junit.Test;
import static org.junit.Assert.*;

public class PeqProcessorTest {
    private static AudioSettings settings(String type,double frequency,double gain,double q,boolean headroom) {
        return new AudioSettings(true,0,0,headroom,new AudioSettings.Band[]{new AudioSettings.Band(type,frequency,gain,q,true)},0,false,0);
    }
    private static double measure(AudioSettings settings,int rate,double frequency) {
        int count=rate*2;double[] data=new double[count];
        for(int i=0;i<count;i++)data[i]=.01*Math.sin(2*Math.PI*frequency*i/rate);
        new PeqProcessor(settings,rate,1).process(data,count);
        double sum=0;for(int i=rate;i<count;i++)sum+=data[i]*data[i];
        return 20*Math.log10(Math.sqrt(sum/rate)/(.01/Math.sqrt(2)));
    }
    @Test public void peakGainMatchesMeasuredSineAndResponseAtCenter() {
        AudioSettings s=settings(AudioSettings.BAND_PEAK,1000,9,2,false);
        assertEquals(9,PeqProcessor.responseDb(s,1000.0,48000),1e-7);
        assertEquals(9,measure(s,48000,1000),.005);
        assertEquals(-7,measure(settings(AudioSettings.BAND_PEAK,4000,-7,4,false),96000,4000),.005);
    }
    @Test public void shelvesReachSpecifiedBassOrTrebleGain() {
        AudioSettings low=settings(AudioSettings.BAND_LOW_SHELF,300,6,.707,false);
        AudioSettings high=settings(AudioSettings.BAND_HIGH_SHELF,3000,-8,.707,false);
        assertEquals(6,measure(low,48000,20),.02);
        assertEquals(0,measure(low,48000,10000),.01);
        assertEquals(-8,measure(high,48000,18000),.02);
        assertEquals(0,measure(high,48000,30),.01);
    }
    @Test public void bypassAndUsbBitPerfectIgnoreAllDspSettings() {
        double[] source={-1,-.1111111111,0,.0000000001,.999999999};double[] actual=source.clone();
        new PeqProcessor(AudioSettings.defaults(),48000,1).process(actual,actual.length);assertArrayEquals(source,actual,0);
        AudioSettings modified=new AudioSettings(true,-24,-1,true,new AudioSettings.Band[]{new AudioSettings.Band(AudioSettings.BAND_PEAK,1000,18,18,true)},0,true,0);
        new PeqProcessor(modified,48000,1).process(actual,actual.length);assertArrayEquals(source,actual,0);
    }
    @Test public void independentChannelHistoriesNeverLeakAcrossStereo() {
        double[] data=new double[4000];data[0]=.1;
        new PeqProcessor(settings(AudioSettings.BAND_PEAK,200,12,5,false),48000,2).process(data,data.length);
        double energy=0;for(int i=0;i<data.length;i+=2){energy+=data[i]*data[i];assertEquals(0,data[i+1],0);}
        assertTrue(energy>0);
    }
    @Test public void automaticHeadroomAccountsForOverlappingBands() {
        AudioSettings.Band[] bands={new AudioSettings.Band(AudioSettings.BAND_PEAK,1000,6,2,true),new AudioSettings.Band(AudioSettings.BAND_PEAK,1000,7,1,true)};
        AudioSettings s=new AudioSettings(true,-2,0,true,bands,0,false,0);
        PeqProcessor p=new PeqProcessor(s,48000,2);
        assertTrue(p.effectivePreampDb<=-15.49);
        assertEquals(-2.5,measure(s,48000,1000),.03);
    }
    @Test public void balanceAttenuatesOnlyOppositeChannelAndFlatHasNoHeadroomPenalty() {
        AudioSettings s=new AudioSettings(false,0,1,true,null,0,false,0);
        double[] data={.4,.4,-.4,-.4};new PeqProcessor(s,48000,2).process(data,data.length);
        assertArrayEquals(new double[]{0,.4,0,-.4},data,0);
        assertEquals(0,new PeqProcessor(new AudioSettings(true,0,0,true,null,0,false,0),48000,2).effectivePreampDb,1e-8);
    }
    @Test public void lowRateSkipsInaudibleBandsAndHighQRemainsFinite() {
        AudioSettings s=settings(AudioSettings.BAND_PEAK,16000,18,18,false);
        assertEquals(0,PeqProcessor.responseDb(s,1000.0,22050),1e-8);
        double[] impulse=new double[48000];impulse[0]=1;
        new PeqProcessor(settings(AudioSettings.BAND_HIGH_SHELF,20,18,18,false),48000,1).process(impulse,impulse.length);
        for(double value:impulse)assertTrue(Double.isFinite(value));
    }
}
