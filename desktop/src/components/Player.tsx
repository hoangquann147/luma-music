import { ListMusic, Music2, Pause, Play, SkipBack, SkipForward, SlidersHorizontal, Volume2, VolumeX, X } from 'lucide-react';
import type { Track } from '../../shared/types';
import type { PlayerState } from '../hooks/usePlayer';
import { trackFormatLabel } from '../audio/track-format';
export const time = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};
export function Artwork({ track, size = 'small' }: { track?: Track; size?: 'small' | 'large' }) {
  return <div className={`artwork artwork-${size}`}>{track?.coverDataUrl ? <img src={track.coverDataUrl} alt={`Ảnh bìa ${track.album || track.title}`} /> : <Music2 size={size === 'large' ? 30 : 21} strokeWidth={1.6} />}</div>;
}
export default function Player({ player, tracks, queueOpen, setQueueOpen, onOpenEqualizer }: { player: PlayerState; tracks: Track[]; queueOpen: boolean; setQueueOpen: (value: boolean) => void; onOpenEqualizer: () => void }) {
  const { track, playing, position, duration, volume } = player;
  return <>
    {queueOpen && <aside className="queue-panel" aria-label="Danh sách phát">
      <div className="section-heading"><div><span className="eyebrow">UP NEXT</span><h3>Hàng đợi <span className="count">{tracks.length}</span></h3></div><button className="icon-button" aria-label="Đóng hàng đợi" onClick={() => setQueueOpen(false)}><X size={18} /></button></div>
      {!tracks.length ? <div className="queue-empty"><ListMusic size={28} /><p>Chưa có bài hát nào.</p><small>Thêm FLAC hoặc M4A trong Library để bắt đầu.</small></div> : <div className="queue-list">{tracks.map((item, index) => <button key={item.id} className={`queue-item ${track?.id === item.id ? 'current' : ''}`} onClick={() => void player.playQueued(item)}><span className="queue-number">{track?.id === item.id && playing ? '♫' : String(index + 1).padStart(2, '0')}</span><Artwork track={item} /><span className="truncate"><strong>{item.title}</strong><small>{item.artist}</small></span><small>{time(item.duration)}</small></button>)}</div>}
    </aside>}
    <footer className="bottom-player">
      <div className="now-playing"><Artwork track={track} size="large" /><div className="truncate"><strong>{track?.title ?? 'Chưa phát nhạc'}</strong><small>{track?.artist ?? 'Âm nhạc, theo cách của bạn.'}</small>{track && <span className="mini-format">{trackFormatLabel(track)}{track.sampleRate ? ` · ${track.sampleRate / 1000} kHz` : ''}</span>}</div></div>
      <div className="transport"><div className="transport-buttons"><button className="icon-button" aria-label="Bài trước" disabled={!tracks.length} onClick={player.previous}><SkipBack size={18} fill="currentColor" /></button><button className="play-button" aria-label={playing ? 'Tạm dừng' : 'Phát nhạc'} disabled={!tracks.length} onClick={player.toggle}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button><button className="icon-button" aria-label="Bài tiếp theo" disabled={!tracks.length} onClick={player.next}><SkipForward size={18} fill="currentColor" /></button></div><div className="seek-row"><span>{time(position)}</span><input aria-label="Vị trí phát" className="slider" type="range" min="0" max={duration || 1} step="0.1" value={Math.min(position, duration || 0)} disabled={!track} style={{ '--fill': `${duration ? position / duration * 100 : 0}%` } as React.CSSProperties} onChange={event => player.seek(Number(event.target.value))} /><span>{time(duration)}</span></div></div>
      <div className="player-tools"><button className={`icon-button ${player.equalizer.enabled ? 'selected' : ''}`} aria-label="Mở Equalizer" title={player.equalizer.enabled ? 'Equalizer đang bật' : 'Equalizer'} onClick={onOpenEqualizer}><SlidersHorizontal size={18} /></button><button className="icon-button" aria-label={volume ? 'Tắt âm' : 'Bật âm'} onClick={() => player.setVolume(volume ? 0 : 0.7)}>{volume ? <Volume2 size={19} /> : <VolumeX size={19} />}</button><input className="slider volume-slider" aria-label="Âm lượng" type="range" min="0" max="1" step="0.01" value={volume} style={{ '--fill': `${volume * 100}%` } as React.CSSProperties} onChange={event => player.setVolume(Number(event.target.value))} /><span className="tool-divider" /><button className={`icon-button ${queueOpen ? 'selected' : ''}`} aria-label="Mở hàng đợi" aria-expanded={queueOpen} onClick={() => setQueueOpen(!queueOpen)}><ListMusic size={21} /></button></div>
    </footer>
  </>;
}
