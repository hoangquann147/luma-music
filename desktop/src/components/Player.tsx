import { ListMusic, Music2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, SlidersHorizontal, Volume2, VolumeX } from 'lucide-react';
import type { Track } from '../../shared/types';
import type { PlayerState } from '../hooks/usePlayer';
import { trackFormatLabel } from '../audio/track-format';
import QueuePanel from './QueuePanel';
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
  const exclusive = player.nativeState?.outputMode === 'exclusive';
  const volumeHint = exclusive ? 'WASAPI Exclusive · chỉnh âm lượng trên DAC hoặc ampli' : 'Âm lượng';
  return <>
    {queueOpen && <QueuePanel player={player} onClose={()=>setQueueOpen(false)}/>}
    <footer className="bottom-player">
      <div className="now-playing"><Artwork track={track} size="large" /><div className="truncate"><strong>{track?.title ?? 'Chưa phát nhạc'}</strong><small>{track?.artist ?? 'Âm nhạc, theo cách của bạn.'}</small>{track && <span className="mini-format">{trackFormatLabel(track)}{track.sampleRate ? ` · ${track.sampleRate / 1000} kHz` : ''}</span>}</div></div>
      <div className="transport"><div className="transport-buttons"><button className={`icon-button playback-mode ${player.shuffle?'selected':''}`} aria-label="Trộn bài" aria-pressed={player.shuffle} title={player.shuffle?'Tắt trộn bài':'Bật trộn bài'} onClick={player.toggleShuffle}><Shuffle size={18}/></button><button className="icon-button" aria-label="Bài trước" disabled={!tracks.length} onClick={player.previous}><SkipBack size={18} fill="currentColor" /></button><button className="play-button" aria-label={playing ? 'Tạm dừng' : 'Phát nhạc'} disabled={!tracks.length} onClick={player.toggle}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button><button className="icon-button" aria-label="Bài tiếp theo" disabled={!tracks.length} onClick={player.next}><SkipForward size={18} fill="currentColor" /></button><button className={`icon-button playback-mode ${player.repeatMode!=='off'?'selected':''}`} aria-label="Lặp lại" aria-pressed={player.repeatMode!=='off'} title={`Lặp lại: ${player.repeatMode==='one'?'Một bài':player.repeatMode==='all'?'Cả hàng đợi':'Tắt'}`} data-repeat={player.repeatMode} onClick={player.cycleRepeat}>{player.repeatMode==='one'?<Repeat1 size={18}/>:<Repeat size={18}/>}</button></div><div className="seek-row"><span>{time(position)}</span><input aria-label="Vị trí phát" className="slider" type="range" min="0" max={duration || 1} step="0.1" value={Math.min(position, duration || 0)} disabled={!track} style={{ '--fill': `${duration ? position / duration * 100 : 0}%` } as React.CSSProperties} onChange={event => player.seek(Number(event.target.value))} /><span>{time(duration)}</span></div></div>
      <div className="player-tools"><button className={`icon-button ${player.equalizer.enabled && !exclusive ? 'selected' : ''}`} aria-label="Mở Equalizer" title={exclusive ? 'Equalizer bypass · WASAPI Exclusive' : player.equalizer.enabled ? 'Equalizer đang bật' : 'Equalizer'} onClick={onOpenEqualizer}><SlidersHorizontal size={18} /></button><button className="icon-button" disabled={exclusive} title={volumeHint} aria-label={volume ? 'Tắt âm' : 'Bật âm'} onClick={() => player.setVolume(volume ? 0 : 0.7)}>{volume ? <Volume2 size={19} /> : <VolumeX size={19} />}</button><input className="slider volume-slider" disabled={exclusive} title={volumeHint} aria-label="Âm lượng" type="range" min="0" max="1" step="0.01" value={volume} style={{ '--fill': `${volume * 100}%` } as React.CSSProperties} onChange={event => player.setVolume(Number(event.target.value))} /><span className="tool-divider" /><button className={`icon-button ${queueOpen ? 'selected' : ''}`} aria-label="Mở hàng đợi" aria-expanded={queueOpen} onClick={() => setQueueOpen(!queueOpen)}><ListMusic size={21} /></button></div>
    </footer>
  </>;
}
