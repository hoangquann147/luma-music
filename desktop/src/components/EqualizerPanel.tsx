import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { AudioLines, Check, RotateCcw, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import type { PlayerState } from '../hooks/usePlayer';
import { BAND_FREQUENCIES, EQ_PRESETS, responseDb } from '../audio/equalizer';

const frequencyLabel = (hz: number) => hz >= 1000 ? `${hz / 1000}k` : String(hz);
const gainLabel = (db: number) => `${db > 0 ? '+' : ''}${db.toFixed(1)}`;

export default function EqualizerPanel({ player }: { player: PlayerState }) {
  const { equalizer, setEqualizer, resetEqualizer } = player;
  const exclusive = player.nativeState?.outputMode === 'exclusive';
  const applied = equalizer.enabled && !exclusive;
  const selectedPreset = EQ_PRESETS.find(preset => preset.gains.every((gain, index) => Math.abs(gain - equalizer.gains[index]) < .01)
    && Math.abs((preset.preampDb ?? 0) - equalizer.preampDb) < .01)?.id ?? 'custom';
  const curve = useMemo(() => Array.from({ length: 241 }, (_, index) => {
    const frequency = 20 * Math.pow(1000, index / 240);
    const db = responseDb(equalizer, frequency, 48000);
    return `${index === 0 ? 'M' : 'L'}${36 + index / 240 * 624},${88 - Math.max(-18, Math.min(18, db)) / 18 * 65}`;
  }).join(' '), [equalizer]);
  const setBand = (index: number, gain: number) => {
    const gains = [...equalizer.gains]; gains[index] = gain; setEqualizer({ gains });
  };
  const applyPreset = (id: string) => {
    const preset = EQ_PRESETS.find(item => item.id === id);
    if (preset) setEqualizer({ enabled: true, gains: [...preset.gains], preampDb: preset.preampDb ?? 0 });
  };

  return <div className={`equalizer-panel ${applied ? 'equalizer-enabled' : ''}`}>
    <section className="equalizer-card">
      <div className="equalizer-heading">
        <span className="equalizer-heading-icon"><SlidersHorizontal size={22} strokeWidth={1.65} /></span>
        <div><h3>Âm thanh, đúng gu bạn.</h3><p>{exclusive ? 'Exclusive đang bỏ qua EQ. Các chỉnh sửa được giữ để dùng trong Shared.' : '10 dải tần · thay đổi trực tiếp khi đang nghe.'}</p></div>
        <button type="button" role="switch" aria-label="Bật Equalizer" aria-checked={equalizer.enabled} className="equalizer-switch" onClick={() => setEqualizer({ enabled: !equalizer.enabled })}><span /></button>
      </div>
      <div className="equalizer-toolbar">
        <label className="equalizer-preset"><span>PRESET</span><select aria-label="Preset Equalizer" value={selectedPreset} onChange={event => applyPreset(event.target.value)}><option value="custom" disabled>Tùy chỉnh</option>{EQ_PRESETS.map(preset => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select></label>
        <span className={`equalizer-pill ${applied ? 'is-active' : ''}`}><i />{exclusive ? 'Bypass · Exclusive' : applied ? 'Đang áp dụng' : 'Đang bỏ qua'}</span>
        <button type="button" className="equalizer-reset" onClick={resetEqualizer}><RotateCcw size={13} /> Đặt lại</button>
      </div>

      <div className="equalizer-response">
        <svg viewBox="0 0 680 185" role="img" aria-label="Đáp tuyến các bộ lọc Equalizer, tham chiếu 48 kHz, chưa gồm preamp">
          <defs><clipPath id="equalizer-response-clip"><rect x="36" y="16" width="624" height="141" /></clipPath></defs>
          {[-12, 0, 12].map(db => <g key={db}><line x1="36" y1={88 - db / 18 * 65} x2="660" y2={88 - db / 18 * 65} className={db === 0 ? 'eq-grid-zero' : 'eq-grid'} /><text x="27" y={92 - db / 18 * 65} textAnchor="end">{db > 0 ? '+' : ''}{db}</text></g>)}
          {[20, 100, 1000, 10000, 20000].map(hz => {
            const x = 36 + Math.log(hz / 20) / Math.log(1000) * 624;
            return <g key={hz}><line x1={x} y1="16" x2={x} y2="157" className="eq-grid" /><text x={x} y="178" textAnchor={hz === 20 ? 'start' : hz === 20000 ? 'end' : 'middle'}>{frequencyLabel(hz)}</text></g>;
          })}
          <path d={curve} className="eq-response-line" clipPath="url(#equalizer-response-clip)" />
        </svg>
        <span>Đáp tuyến bộ lọc · tham chiếu 48 kHz · chưa gồm preamp</span>
      </div>

      <div className="equalizer-fader-scroll">
        <div className="equalizer-bands" aria-label="10 dải tần Equalizer">
          {BAND_FREQUENCIES.map((hz, index) => <label className="equalizer-band" key={hz}>
            <output htmlFor={`eq-band-${index}`}>{gainLabel(equalizer.gains[index])}<small>dB</small></output>
            <div className="equalizer-fader-track"><i className="equalizer-zero-mark" /><input id={`eq-band-${index}`} aria-label={`Equalizer ${hz} Hz`} aria-valuetext={`${gainLabel(equalizer.gains[index])} dB`} className="equalizer-fader" type="range" min="-12" max="12" step="0.5" value={equalizer.gains[index]} style={{ '--eq-fill': `${(equalizer.gains[index] + 12) / 24 * 100}%` } as CSSProperties} onChange={event => setBand(index, Number(event.target.value))} /></div>
            <strong>{frequencyLabel(hz)}</strong><small>Hz</small>
          </label>)}
        </div>
      </div>
      <p className="equalizer-editor-note">Kéo thanh để giảm hoặc tăng từng dải, từ −12 đến +12 dB. Tắt Equalizer để nghe so sánh; cài đặt của bạn vẫn được giữ.</p>
    </section>

    <section className="equalizer-card equalizer-levels">
      <div className="equalizer-section-title"><AudioLines size={19} strokeWidth={1.7} /><div><h3>Mức tín hiệu</h3><p>Giữ khoảng trống cho những dải bạn tăng.</p></div></div>
      <label className="equalizer-preamp"><span>Preamp</span><input className="slider" aria-label="Preamp Equalizer" type="range" min="-24" max="0" step="0.5" value={equalizer.preampDb} style={{ '--fill': `${(equalizer.preampDb + 24) / 24 * 100}%` } as CSSProperties} onChange={event => setEqualizer({ preampDb: Number(event.target.value) })} /><output>{gainLabel(equalizer.preampDb)} dB</output></label>
      <label className="equalizer-headroom"><input type="checkbox" checked={equalizer.autoHeadroom} onChange={event => setEqualizer({ autoHeadroom: event.target.checked })} /><span><strong>Tự tạo headroom</strong><small>Giảm mức theo đáp tuyến khi tăng EQ. Headroom giúp hạn chế clipping; đây không phải limiter.</small></span></label>
      <div className="equalizer-effective"><ShieldCheck size={14} /><span>Mức preamp áp dụng {applied ? '' : 'khi bỏ qua'}<strong>{gainLabel(player.effectivePreampDb)} dB</strong></span></div>
    </section>
    <div className="equalizer-status"><Check size={14} /><p><strong>Tự lưu trên máy.</strong> Các thay đổi áp dụng cho FLAC và M4A trong Shared Mode; Exclusive giữ tín hiệu gốc.</p></div>
    {player.eqStatus && <p className="equalizer-engine-status" role="status">{player.eqStatus}</p>}
  </div>;
}
