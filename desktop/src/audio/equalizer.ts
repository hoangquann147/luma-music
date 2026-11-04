/** App-local ten-band Web Audio equalizer. RBJ peak equations: W3C Audio EQ Cookbook. */
export const BAND_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_Q = 1.4;
export const EQUALIZER_STORAGE_KEY = 'luma.equalizer.v1';
export interface EqualizerSettings {
  enabled: boolean;
  preampDb: number;
  autoHeadroom: boolean;
  gains: number[];
}
export const EQ_PRESETS: { id: string; name: string; gains: number[]; preampDb?: number }[] = [
  { id: 'flat', name: 'Flat · Trung tính', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preampDb: 0 },
  { id: 'bass', name: 'Bass nhẹ', gains: [4, 3, 2, 0, -1, 0, 0, 0, 0, 0], preampDb: 0 },
  { id: 'vocal', name: 'Giọng hát', gains: [-2, -1, 0, 0, 1, 2, 3, 1, 0, -1], preampDb: 0 },
  { id: 'warm', name: 'Ấm dịu', gains: [2, 2, 1, 0, 0, 0, -1, -2, -2, -3], preampDb: 0 },
  { id: 'bright', name: 'Sáng rõ', gains: [-1, -1, 0, 0, 0, 1, 2, 2, 3, 2], preampDb: 0 },
];
export const defaultEqualizer = (): EqualizerSettings => ({ enabled: false, preampDb: 0, autoHeadroom: true, gains: Array<number>(10).fill(0) });
const finiteClamp = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export function normalizeEqualizer(value: unknown): EqualizerSettings {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    enabled: record.enabled === true,
    preampDb: finiteClamp(record.preampDb, -24, 0, 0),
    autoHeadroom: record.autoHeadroom !== false,
    gains: BAND_FREQUENCIES.map((_, index) => finiteClamp(Array.isArray(record.gains) ? record.gains[index] : 0, -12, 12, 0)),
  };
}
type StorageRead = Pick<Storage, 'getItem'>;
type StorageWrite = Pick<Storage, 'setItem'>;
const localStorageIfAvailable = (): Storage | undefined => { try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; } };
export function loadEqualizer(storage: StorageRead | undefined = localStorageIfAvailable()): EqualizerSettings {
  try {
    const serialized = storage?.getItem(EQUALIZER_STORAGE_KEY);
    if (!serialized || serialized.length > 8000) return defaultEqualizer();
    const stored: unknown = JSON.parse(serialized);
    if (!stored || typeof stored !== 'object' || (stored as { version?: unknown }).version !== 1) return defaultEqualizer();
    return normalizeEqualizer(stored);
  } catch { return defaultEqualizer(); }
}
export function saveEqualizer(settings: EqualizerSettings, storage: StorageWrite | undefined = localStorageIfAvailable()): boolean {
  try { if (!storage) return false; storage.setItem(EQUALIZER_STORAGE_KEY, JSON.stringify({ version: 1, ...normalizeEqualizer(settings) })); return true; }
  catch { return false; }
}

/** Filters only; preamp and volume are separate. Frequencies above Nyquist are bypassed. */
export function responseDb(settings: EqualizerSettings, frequency: number, sampleRate = 48000): number {
  if (!settings.enabled || !Number.isFinite(sampleRate) || sampleRate < 1) return 0;
  const w = 2 * Math.PI * Math.max(0, Math.min(sampleRate * .49999, frequency)) / sampleRate;
  const c = Math.cos(w), s = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let result = 0;
  BAND_FREQUENCIES.forEach((center, index) => {
    const gain = settings.gains[index] || 0;
    if (!gain || center >= sampleRate * .5) return;
    const a = 10 ** (gain / 40), omega = 2 * Math.PI * center / sampleRate;
    const alpha = Math.sin(omega) / (2 * EQ_Q), a0 = 1 + alpha / a;
    const b0 = (1 + alpha * a) / a0, b1 = -2 * Math.cos(omega) / a0, b2 = (1 - alpha * a) / a0;
    const a1 = -2 * Math.cos(omega) / a0, a2 = (1 - alpha / a) / a0;
    const nr = b0 + b1 * c + b2 * c2, ni = -b1 * s - b2 * s2;
    const dr = 1 + a1 * c + a2 * c2, di = -a1 * s - a2 * s2;
    result += 10 * Math.log10(Math.max(1e-30, (nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di)));
  });
  return result;
}
/** Estimated frequency-response headroom, not a limiter for arbitrary transients. */
export function effectivePreampDb(settings: EqualizerSettings, sampleRate = 48000): number {
  if (!settings.enabled) return 0;
  if (!settings.autoHeadroom) return settings.preampDb;
  let peak = 0;
  const high = Math.min(20000, sampleRate * .499);
  for (let i = 0; i <= 512; i++) peak = Math.max(peak, responseDb(settings, 10 * (high / 10) ** (i / 512), sampleRate));
  for (const frequency of BAND_FREQUENCIES) if (frequency < sampleRate * .5) peak = Math.max(peak, responseDb(settings, frequency, sampleRate));
  return settings.preampDb - (peak > .01 ? peak + .5 : 0);
}

/** Graph is source-agnostic, allowing OfflineAudioContext tests of the actual audio path. */
export class EqualizerGraph {
  readonly input: GainNode;
  readonly filters: BiquadFilterNode[];
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly preamp: GainNode;
  private readonly output: GainNode;
  private disposed = false;
  private current: EqualizerSettings;
  effectivePreampDb = 0;
  constructor(readonly context: BaseAudioContext, settings: EqualizerSettings, volume = 1, destination: AudioNode = context.destination) {
    this.current = normalizeEqualizer(settings);
    this.input = context.createGain(); this.dry = context.createGain(); this.wet = context.createGain();
    this.preamp = context.createGain(); this.output = context.createGain();
    this.filters = BAND_FREQUENCIES.map(frequency => {
      const node = context.createBiquadFilter(); node.type = 'peaking';
      node.frequency.value = Math.min(frequency, context.sampleRate * .499); node.Q.value = EQ_Q;
      return node;
    });
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.input.connect(this.filters[0]);
    for (let i = 1; i < this.filters.length; i++) this.filters[i - 1].connect(this.filters[i]);
    this.filters[this.filters.length - 1].connect(this.preamp); this.preamp.connect(this.wet); this.wet.connect(this.output);
    this.output.connect(destination); this.update(this.current, false); this.setVolume(volume, false);
  }
  private set(param: AudioParam, value: number, smooth: boolean): void {
    const now = this.context.currentTime;
    if (smooth) {
      // cancelAndHoldAtTime avoids discontinuities when dragging faster than the ramp.
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
      else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
      param.setTargetAtTime(value, now, .012);
    } else { param.cancelScheduledValues(now); param.setValueAtTime(value, now); }
  }
  update(settings: EqualizerSettings, smooth = true): void {
    if (this.disposed) return;
    this.current = normalizeEqualizer(settings);
    this.filters.forEach((filter, index) => this.set(filter.gain, BAND_FREQUENCIES[index] >= this.context.sampleRate * .5 ? 0 : this.current.gains[index], smooth));
    this.effectivePreampDb = effectivePreampDb(this.current, this.context.sampleRate);
    this.set(this.preamp.gain, 10 ** (this.effectivePreampDb / 20), smooth);
    this.set(this.dry.gain, this.current.enabled ? 0 : 1, smooth);
    this.set(this.wet.gain, this.current.enabled ? 1 : 0, smooth);
  }
  setVolume(volume: number, smooth = true): void { if (!this.disposed) this.set(this.output.gain, finiteClamp(volume, 0, 1, .7), smooth); }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const node of [this.input, ...this.filters, this.preamp, this.wet, this.dry, this.output]) node.disconnect();
  }
}
