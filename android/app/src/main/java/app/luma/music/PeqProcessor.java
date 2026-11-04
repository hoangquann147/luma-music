package app.luma.music;

/** Ten cascaded double-precision RBJ biquads, independent channel histories, no resampling.
 * Coefficient equations: https://www.w3.org/TR/audio-eq-cookbook/ (RBJ/W3C).
 * Shelf Q is damping Q, not a shelf-slope percentage. Auto headroom estimates the combined
 * frequency-response maximum; it is not a promise that arbitrary transients never clip.
 */
public final class PeqProcessor {
    private final int channels;
    private final Biquad[] filters;
    private final double leftGain, rightGain;
    public final double effectivePreampDb;
    public final boolean bypass;

    public PeqProcessor(AudioSettings settings, int sampleRate, int channels) {
        if (channels < 1 || channels > 2 || sampleRate < 1) throw new IllegalArgumentException("PEQ chỉ nhận mono/stereo.");
        this.channels = channels;
        bypass = settings.usbBitPerfect || (!settings.eqEnabled && settings.balance == 0);
        filters = new Biquad[settings.eqEnabled && !settings.usbBitPerfect ? settings.bands.length : 0];
        for (int i = 0; i < filters.length; i++) filters[i] = new Biquad(coefficients(settings.bands[i], sampleRate), channels);
        double attenuation = 0;
        if (settings.eqEnabled && settings.autoHeadroom && !settings.usbBitPerfect) {
            double max = 0;
            // Dense linear grid plus a logarithmic grid captures high-Q treble and low bass.
            for (int i = 0; i <= 4096; i++) {
                double f = sampleRate * .499 * i / 4096;
                max = Math.max(max, responseDb(filters, f, sampleRate));
                if (i > 0) max = Math.max(max, responseDb(filters, 10 * Math.pow(sampleRate * .0499, i / 4096.0), sampleRate));
            }
            attenuation = max > .01 ? -(max + .5) : 0;
        }
        effectivePreampDb = settings.eqEnabled && !settings.usbBitPerfect ? Math.min(0, settings.preampDb) + attenuation : 0;
        double preamp = Math.pow(10, effectivePreampDb / 20);
        double balance = settings.usbBitPerfect ? 0 : Math.max(-1, Math.min(1, settings.balance));
        leftGain = preamp * (balance > 0 && channels == 2 ? 1 - balance : 1);
        rightGain = preamp * (balance < 0 && channels == 2 ? 1 + balance : 1);
    }

    public void process(double[] samples, int count) {
        if (bypass) return;
        for (int i = 0; i < count; i++) {
            int channel = i % channels;
            double value = samples[i];
            for (Biquad filter : filters) value = filter.process(value, channel);
            value *= channel == 0 ? leftGain : rightGain;
            samples[i] = Double.isFinite(value) ? value : 0;
        }
    }

    public void reset() { for (Biquad filter : filters) filter.reset(); }

    public static double responseDb(AudioSettings settings, int sampleRate, double frequencyHz) {
        return responseDb(settings, frequencyHz, sampleRate);
    }
    public static double effectivePreampDb(AudioSettings settings, int sampleRate) {
        return new PeqProcessor(settings, sampleRate, 2).effectivePreampDb;
    }

    private static double responseDb(Biquad[] filters, double frequency, int sampleRate) {
        double omega=2*Math.PI*Math.max(0,Math.min(sampleRate*.49999,frequency))/sampleRate;
        double c=Math.cos(omega),s=Math.sin(omega),c2=Math.cos(2*omega),s2=Math.sin(2*omega),result=0;
        for(Biquad filter:filters) {
            double[] v=filter.c;
            double nr=v[0]+v[1]*c+v[2]*c2,ni=-v[1]*s-v[2]*s2;
            double dr=1+v[3]*c+v[4]*c2,di=-v[3]*s-v[4]*s2;
            result+=10*Math.log10(Math.max(1e-30,(nr*nr+ni*ni)/Math.max(1e-30,dr*dr+di*di)));
        }
        return result;
    }

    /** Magnitude of filters only; display may add the separately reported effective preamp. */
    public static double responseDb(AudioSettings settings, double frequency, int sampleRate) {
        if (!settings.eqEnabled || settings.usbBitPerfect) return 0;
        double omega = 2 * Math.PI * Math.max(0, Math.min(sampleRate * .49999, frequency)) / sampleRate;
        double c = Math.cos(omega), s = Math.sin(omega), c2 = Math.cos(2 * omega), s2 = Math.sin(2 * omega);
        double result = 0;
        for (AudioSettings.Band band : settings.bands) {
            double[] v = coefficients(band, sampleRate);
            double nr = v[0] + v[1] * c + v[2] * c2, ni = -v[1] * s - v[2] * s2;
            double dr = 1 + v[3] * c + v[4] * c2, di = -v[3] * s - v[4] * s2;
            result += 10 * Math.log10(Math.max(1e-30, (nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di)));
        }
        return result;
    }

    private static double[] coefficients(AudioSettings.Band band, int sampleRate) {
        if (!band.enabled || Math.abs(band.gainDb) < 1e-8 || band.frequencyHz >= sampleRate * .5) return new double[]{1,0,0,0,0};
        double frequency = Math.max(1, Math.min(sampleRate * .499, band.frequencyHz));
        double q = Math.max(.1, Math.min(18, band.q));
        double a = Math.pow(10, Math.max(-24, Math.min(24, band.gainDb)) / 40);
        double omega = 2 * Math.PI * frequency / sampleRate, c = Math.cos(omega), alpha = Math.sin(omega) / (2 * q);
        double b0,b1,b2,a0,a1,a2;
        if (AudioSettings.BAND_LOW_SHELF.equals(band.type)) {
            double t = 2 * Math.sqrt(a) * alpha;
            b0=a*((a+1)-(a-1)*c+t); b1=2*a*((a-1)-(a+1)*c); b2=a*((a+1)-(a-1)*c-t);
            a0=(a+1)+(a-1)*c+t; a1=-2*((a-1)+(a+1)*c); a2=(a+1)+(a-1)*c-t;
        } else if (AudioSettings.BAND_HIGH_SHELF.equals(band.type)) {
            double t = 2 * Math.sqrt(a) * alpha;
            b0=a*((a+1)+(a-1)*c+t); b1=-2*a*((a-1)+(a+1)*c); b2=a*((a+1)+(a-1)*c-t);
            a0=(a+1)-(a-1)*c+t; a1=2*((a-1)-(a+1)*c); a2=(a+1)-(a-1)*c-t;
        } else {
            b0=1+alpha*a; b1=-2*c; b2=1-alpha*a; a0=1+alpha/a; a1=-2*c; a2=1-alpha/a;
        }
        return new double[]{b0/a0,b1/a0,b2/a0,a1/a0,a2/a0};
    }

    private static final class Biquad {
        final double[] c, z1, z2;
        Biquad(double[] coefficients, int channels) { c=coefficients; z1=new double[channels]; z2=new double[channels]; }
        double process(double input, int channel) {
            double output=c[0]*input+z1[channel];
            z1[channel]=c[1]*input-c[3]*output+z2[channel];
            z2[channel]=c[2]*input-c[4]*output;
            if (Math.abs(z1[channel]) < 1e-25) z1[channel]=0;
            if (Math.abs(z2[channel]) < 1e-25) z2[channel]=0;
            return output;
        }
        void reset() { java.util.Arrays.fill(z1,0); java.util.Arrays.fill(z2,0); }
    }
}
