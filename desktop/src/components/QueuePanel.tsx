import { AudioLines, ListMusic, X } from 'lucide-react';
import type { PlayerState } from '../hooks/usePlayer';
import { Artwork, time } from './Player';

export default function QueuePanel({player,onClose}:{player:PlayerState;onClose:()=>void}){
  const tracks=player.queueTracks;
  const index=tracks.findIndex(item=>item.id===player.track?.id);
  const upcoming=index<0?tracks:tracks.slice(index+1);
  const remaining=player.repeatMode==='one'?[]:player.repeatMode==='all'&&index>=0?[...upcoming,...tracks.slice(0,index)]:upcoming;
  return <aside className="queue-panel" aria-label="Hàng đợi bên phải">
    <header className="queue-header"><span className="queue-heading-icon"><ListMusic size={18}/></span><h2>Hàng đợi</h2><span className="queue-count">{tracks.length}</span><button className="icon-button" aria-label="Đóng hàng đợi" onClick={onClose}><X size={17}/></button></header>
    <div className="queue-scroll">
      <div className="queue-section-label"><i/>{player.playing?'ĐANG PHÁT':'ĐANG CHỌN'}</div>
      <section className="queue-current">
        <div className="queue-cover"><Artwork track={player.track} size="large"/>{player.track&&<span className="queue-cover-badge">{player.nativeState?.outputMode==='exclusive'?'EXCLUSIVE':player.track.lossless?'LOSSLESS':'LOCAL AUDIO'}</span>}</div>
        <h3>{player.track?.title??'Chọn một giai điệu.'}</h3><p>{player.track?.artist??'Thêm nhạc để bắt đầu câu chuyện của bạn.'}</p>
        {player.track&&<div className="queue-current-meta"><span>{player.track.codec||'AUDIO'}{player.track.sampleRate?` · ${player.track.sampleRate/1000} kHz`:''}</span><span>{time(player.duration)}</span></div>}
      </section>
      <div className="queue-up-next-title"><h3>Tiếp theo</h3><span>{remaining.length} bài</span></div>
      {remaining.length?<div className="queue-list">{remaining.map((item,index)=><button key={item.id} className="queue-item" onClick={()=>void player.playQueued(item)} aria-label={`Phát tiếp ${item.title}`}><span className="queue-number">{String(index+1).padStart(2,'0')}</span><Artwork track={item}/><span className="truncate"><strong>{item.title}</strong><small>{item.artist}</small></span><small>{time(item.duration)}</small></button>)}</div>:<div className="queue-empty"><ListMusic size={26}/><p>{player.repeatMode==='one'?'Bài hiện tại sẽ phát lại.':'Bạn đã đến cuối hàng đợi.'}</p><small>{tracks.length?'Chọn bài khác hoặc bật lặp lại.':'Import FLAC hoặc M4A từ thư viện.'}</small></div>}
    </div>
    <footer className="queue-footer"><AudioLines size={15}/><span>{player.shuffle?'Thứ tự ngẫu nhiên':player.repeatMode==='one'?'Lặp một bài':player.repeatMode==='all'?'Lặp toàn bộ hàng đợi':'Âm nhạc, theo cách của bạn.'}</span></footer>
  </aside>;
}
