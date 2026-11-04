import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Disc3, FolderOpen, LoaderCircle, Music2, Play, Plus, Search, X } from 'lucide-react';
import type { Track } from '../../shared/types';
import type { Album, LibraryOrganizeResult } from '../../shared/album-types';
import type { PlayerState } from '../hooks/usePlayer';
import { Artwork, time } from './Player';
import { trackFormatLabel } from '../audio/track-format';

interface Props {
  albums: Album[]; tracks: Track[]; directory?: string; player: PlayerState;
  onCreated: (album: Album) => void; onOrganized: (result: LibraryOrganizeResult) => void;
  onImport: () => void; onSettings: () => void;
  requireDesktop: () => boolean; fail: (message: string) => void; success: (message: string) => void;
}

export default function AlbumsView({ albums, tracks, directory, player, onCreated, onOrganized, onImport, onSettings, requireDesktop, fail, success }: Props) {
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<'create' | 'assign' | null>(null);
  const [name, setName] = useState(''), [artist, setArtist] = useState('');
  const [trackQuery, setTrackQuery] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  const album = albums.find(item => item.id === selectedId);
  const albumTracks = useMemo(() => tracks.filter(track => track.albumId === selectedId), [tracks, selectedId]);
  const visibleAlbums = albums.filter(item => `${item.name} ${item.artist}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const availableTracks = tracks.filter(track => track.albumId !== selectedId);
  const visibleTracks = availableTracks.filter(track => `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase().includes(trackQuery.toLocaleLowerCase()));
  const open = (kind: 'create' | 'assign') => { returnFocus.current = document.activeElement as HTMLElement; setChosen(new Set()); setTrackQuery(''); setName(''); setArtist(''); setModal(kind); };
  const close = () => { if (busy) return; setModal(null); window.setTimeout(() => returnFocus.current?.focus(), 0); };
  useEffect(() => {
    if (!modal) return;
    const node = dialog.current, focusable = () => Array.from(node?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') || []);
    focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { setModal(null); returnFocus.current?.focus(); }
      if (event.key === 'Tab') { const list = focusable(), first = list[0], last = list.at(-1); if (!list.length) return; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [modal, busy]);
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); if (!requireDesktop() || busy || !name.trim()) return;
    setBusy(true);
    try { const created = await window.music!.createAlbum({ name: name.trim(), artist: artist.trim() }); onCreated(created); setSelectedId(created.id); setModal(null); window.setTimeout(() => returnFocus.current?.focus(), 0); success(`Đã tạo album “${created.name}”.`); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const assign = async () => {
    if (!requireDesktop() || busy || !album || !chosen.size) return; setBusy(true);
    try {
      const result = await window.music!.assignAlbum({ albumId: album.id, trackIds: [...chosen] }); onOrganized(result);
      if (result.failed.length) fail(`Đã xử lý ${chosen.size - result.failed.length} bài. ${result.failed.map(item => `${item.title}: ${item.error}`).join('\n')}`);
      else { setModal(null); window.setTimeout(() => returnFocus.current?.focus(), 0); success(`Đã thêm ${chosen.size} bài vào album “${album.name}”.`); }
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const openFolder = async () => { if (!requireDesktop()) return; try { await window.music!.openLibraryDirectory(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); } };
  const toggleTrack = (id: string) => setChosen(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  return <div className="albums-page page-content">
    <section className="albums-intro"><div><span className="eyebrow">YOUR MUSIC, COLLECTED</span><h2>{album ? album.name : 'Mỗi album, một khoảng riêng.'}</h2><p>{album ? (album.artist || 'Nghệ sĩ chưa rõ') : 'Tự nhận diện từ metadata. Thêm những bộ sưu tập do bạn tạo.'}</p></div><button className="primary-button" onClick={() => open('create')}><Plus size={16} /> Tạo album</button></section>
    <div className="album-library-folder"><FolderOpen size={17} /><div><strong>Một thư viện chung, mỗi album một thư mục</strong><span title={directory}>{directory || 'Chọn thư mục thư viện trong Settings'}</span></div><button className="text-button" onClick={() => void openFolder()}>Mở thư mục</button><button className="icon-button small" aria-label="Cài đặt thư mục thư viện" onClick={onSettings}><FolderOpen size={15} /></button></div>
    {album ? <>
      <button className="text-button albums-back" onClick={() => setSelectedId('')}><ArrowLeft size={15} /> Tất cả album</button>
      <section className="album-detail-header"><div className="album-cover large">{album.coverDataUrl ? <img src={album.coverDataUrl} alt={`Ảnh bìa ${album.name}`} /> : <Disc3 size={60} strokeWidth={1.1} />}</div><div><span className="eyebrow">{album.kind === 'manual' ? 'ALBUM CỦA BẠN' : 'ALBUM TỪ METADATA'}</span><h3>{album.name}</h3><p>{album.artist || 'Nghệ sĩ chưa rõ'} · {albumTracks.length} bài · {time(albumTracks.reduce((total, track) => total + track.duration, 0))}</p><div className="album-detail-actions"><button className="primary-button" disabled={!albumTracks.length} onClick={() => void player.playAlbum(albumTracks)}><Play size={15} fill="currentColor" /> Phát album</button><button className="subtle-button" onClick={() => open('assign')}><Plus size={15} /> Thêm bài vào album</button></div><small className="album-folder-label" title={album.folder}>Thư mục: {album.folder}</small></div></section>
      {albumTracks.length ? <div className="album-track-list">{albumTracks.map((track, index) => <button key={track.id} className={`album-track ${player.track?.id === track.id ? 'current' : ''}`} onClick={() => void player.playAlbum(albumTracks, track.id)}><span>{String(index + 1).padStart(2, '0')}</span><Artwork track={track} /><span className="album-track-title"><strong>{track.title}</strong><small>{track.artist}</small></span><span className="album-track-format">{trackFormatLabel(track)}</span><span>{time(track.duration)}</span><Play size={14} /></button>)}</div> : <div className="album-empty"><Music2 size={33} strokeWidth={1.3} /><h3>Album đang chờ những bài đầu tiên.</h3><p>Chọn bài đã có trong Library rồi thêm vào album này.</p><button className="subtle-button" onClick={() => open('assign')}><Plus size={15} /> Chọn bài hát</button></div>}
    </> : <>
      <div className="album-toolbar"><h3>Album của bạn <span className="count">{albums.length}</span></h3><label className="search-field"><Search size={15} /><input aria-label="Tìm album" placeholder="Tìm album, nghệ sĩ…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button small" aria-label="Xóa tìm album" onClick={() => setQuery('')}><X size={13} /></button>}</label></div>
      {visibleAlbums.length ? <div className="album-grid">{visibleAlbums.map(item => <button key={item.id} className="album-card" onClick={() => setSelectedId(item.id)}><div className="album-cover">{item.coverDataUrl ? <img src={item.coverDataUrl} alt={`Ảnh bìa ${item.name}`} /> : <Disc3 size={50} strokeWidth={1.1} />}<span><ArrowRight size={16} /></span></div><strong>{item.name}</strong><small>{item.artist || 'Nghệ sĩ chưa rõ'}</small><p>{item.trackCount} bài <i /> {item.kind === 'manual' ? 'Tạo thủ công' : 'Metadata'}</p></button>)}</div> : <div className="album-empty"><Disc3 size={39} strokeWidth={1.3} /><h3>{query ? 'Chưa tìm thấy album phù hợp.' : 'Bắt đầu từ những bài hát bạn yêu.'}</h3><p>{query ? 'Thử tên album hoặc nghệ sĩ khác.' : 'Import FLAC hoặc M4A. Luma đọc tên album và nghệ sĩ từ tags có sẵn.'}</p>{!query && <button className="subtle-button" onClick={onImport}><Plus size={15} /> Import File</button>}</div>}
      <p className="album-explanation"><Check size={14} /> Nhạc mới được sao chép vào thư mục album. File gốc vẫn giữ nguyên; bài thiếu tags có thể được xếp album thủ công.</p>
    </>}
    {modal && <div className="album-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><div className="album-modal" role="dialog" aria-modal="true" aria-labelledby="album-dialog-title" ref={dialog}><header><div><span className="eyebrow">YOUR COLLECTION</span><h3 id="album-dialog-title">{modal === 'create' ? 'Tạo album mới' : `Thêm bài vào ${album?.name || 'album'}`}</h3></div><button className="icon-button" disabled={busy} aria-label="Đóng cửa sổ album" onClick={close}><X size={18} /></button></header>
      {modal === 'create' ? <form onSubmit={event => void create(event)}><label className="field-label" htmlFor="new-album-name">Tên album</label><input id="new-album-name" required maxLength={160} disabled={busy} value={name} onChange={event => setName(event.target.value)} placeholder="Ví dụ: Những ngày dịu dàng" /><label className="field-label" htmlFor="new-album-artist">Nghệ sĩ album <small>tùy chọn</small></label><input id="new-album-artist" maxLength={160} disabled={busy} value={artist} onChange={event => setArtist(event.target.value)} placeholder="Tên nghệ sĩ hoặc bộ sưu tập" /><p className="album-modal-note">Luma tạo một thư mục con trong thư viện chung. Bạn có thể thêm bài đã nhập ở bước tiếp theo.</p><footer><button type="button" className="subtle-button" disabled={busy} onClick={close}>Hủy</button><button className="primary-button" disabled={busy || !name.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />} Tạo album</button></footer></form> : <><label className="search-field album-pick-search"><Search size={15} /><input disabled={busy} aria-label="Tìm bài để thêm vào album" placeholder="Tìm bài hát, nghệ sĩ…" value={trackQuery} onChange={event => setTrackQuery(event.target.value)} /></label><div className="album-pick-list">{visibleTracks.length ? visibleTracks.map(track => <label key={track.id} className={`album-pick-track ${chosen.has(track.id) ? 'chosen' : ''}`}><input type="checkbox" disabled={busy} checked={chosen.has(track.id)} onChange={() => toggleTrack(track.id)} /><Artwork track={track} /><span><strong>{track.title}</strong><small>{track.artist} · {track.album || 'Chưa có album'}</small></span><small>{time(track.duration)}</small></label>) : <div className="album-pick-empty">{availableTracks.length ? 'Không tìm thấy bài phù hợp.' : 'Chưa có bài để thêm. Import File trong Library trước.'}</div>}</div><p className="album-modal-note">Các bài được xếp lại vào thư mục album này. Bản nguồn của bạn được giữ nguyên. Nhạc hiện có trong album sẽ không hiện ở đây.</p><footer><span>{chosen.size} bài đã chọn</span><button type="button" className="subtle-button" disabled={busy} onClick={close}>Hủy</button><button className="primary-button" disabled={busy || !chosen.size} onClick={() => void assign()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} {busy ? 'Đang thêm…' : 'Thêm vào album'}</button></footer></>}
    </div></div>}
  </div>;
}
