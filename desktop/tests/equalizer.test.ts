import { describe, expect, it } from 'vitest';
import { BAND_FREQUENCIES, defaultEqualizer, effectivePreampDb, EQUALIZER_STORAGE_KEY, loadEqualizer, normalizeEqualizer, responseDb, saveEqualizer } from '../src/audio/equalizer';

describe('desktop equalizer persistence and numeric response', () => {
  it('starts bypassed with independent ten-band preset snapshots', () => {
    const first = defaultEqualizer(), second = defaultEqualizer(); first.gains[0] = 12;
    expect(second.enabled).toBe(false); expect(second.preampDb).toBe(0);
    expect(second.gains).toHaveLength(BAND_FREQUENCIES.length); expect(second.gains[0]).toBe(0);
  });
  it('rejects non-finite settings and clamps out-of-range controls before DSP', () => {
    const result = normalizeEqualizer({ enabled: 'true', preampDb: -99, autoHeadroom: false, gains: [99, -99, Number.NaN, Infinity, '6', 1.25] });
    expect(result.enabled).toBe(false); expect(result.preampDb).toBe(-24); expect(result.autoHeadroom).toBe(false);
    expect(result.gains).toEqual([12, -12, 0, 0, 0, 1.25, 0, 0, 0, 0]);
    expect(normalizeEqualizer(null)).toEqual(defaultEqualizer());
  });
  it('round-trips the saved enabled preset while keeping a versioned storage schema', () => {
    const memory = new Map<string, string>(); const storage = { getItem: (key: string) => memory.get(key) || null, setItem: (key: string, value: string) => { memory.set(key, value); } };
    const saved = { ...defaultEqualizer(), enabled: true, preampDb: -4.5, gains: [1, 2, 3, 4, 0, -2, 0, 2, 0, -1] };
    expect(saveEqualizer(saved, storage)).toBe(true); expect(loadEqualizer(storage)).toEqual(saved);
    expect(JSON.parse(memory.get(EQUALIZER_STORAGE_KEY)!).version).toBe(1);
  });
  it('recovers corrupt, unavailable, oversized and future-version storage safely', () => {
    for (const text of ['{broken', JSON.stringify({ version: 2, enabled: true }), ' '.repeat(8001)]) expect(loadEqualizer({ getItem: () => text })).toEqual(defaultEqualizer());
    expect(loadEqualizer({ getItem: () => { throw new Error('disabled'); } })).toEqual(defaultEqualizer());
    expect(saveEqualizer(defaultEqualizer(), { setItem: () => { throw new Error('quota'); } })).toBe(false);
  });
  it('is an exact flat response with no automatic attenuation on neutral bands', () => {
    const settings = { ...defaultEqualizer(), enabled: true };
    for (const rate of [16000, 44100, 48000, 96000]) for (const frequency of [20, 100, 1000, 7000]) expect(responseDb(settings, frequency, rate)).toBe(0);
    expect(effectivePreampDb(settings)).toBe(0);
  });
  it('matches the RBJ analytical gain for a single peak and cut at its center', () => {
    for (const gain of [-12, -6, 6, 12]) {
      const settings = { ...defaultEqualizer(), enabled: true }; settings.gains[5] = gain;
      expect(responseDb(settings, 1000, 48000)).toBeCloseTo(gain, 8);
      expect(Math.abs(responseDb(settings, 20, 48000))).toBeLessThan(.05);
    }
  });
  it('accounts for overlapping filter boosts when estimating headroom', () => {
    const settings = { ...defaultEqualizer(), enabled: true, preampDb: -2, gains: Array<number>(10).fill(6) };
    const attenuation = effectivePreampDb(settings, 48000);
    expect(attenuation).toBeLessThan(-8.4);
    let peak = -Infinity;
    for (let i = 0; i < 2000; i++) peak = Math.max(peak, responseDb(settings, 20 * 1000 ** (i / 1999), 48000) + attenuation);
    expect(peak).toBeLessThan(-2.4);
    expect(effectivePreampDb({ ...settings, autoHeadroom: false })).toBe(-2);
  });
  it('bypasses saved boosts and preamp without erasing the preset', () => {
    const settings = { ...defaultEqualizer(), enabled: false, preampDb: -24, gains: Array<number>(10).fill(12) };
    expect(responseDb(settings, 1000)).toBe(0); expect(effectivePreampDb(settings)).toBe(0);
    expect(settings.gains[0]).toBe(12);
  });
  it('skips bands at or above the context Nyquist frequency', () => {
    const settings = { ...defaultEqualizer(), enabled: true }; settings.gains[8] = 12; settings.gains[9] = 12;
    expect(responseDb(settings, 1000, 16000)).toBe(0);
    expect(effectivePreampDb(settings, 16000)).toBe(0);
  });
});
