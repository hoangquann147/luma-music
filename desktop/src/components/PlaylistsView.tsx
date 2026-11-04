import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, Check, CheckCheck, ChevronLeft, ChevronRight, Disc3, ExternalLink, FileUp, ListMusic, LoaderCircle, Play, Plus, X } from 'lucide-react';
import type { DownloadJob, PlaylistBatch, PlaylistBatchItem, PlaylistTrack, SpotifyAuthStatus, SpotifyMatch, SpotifyPlaylist, ToolStatus, Track } from '../../shared/types';
import type { PlayerState } from '../hooks/usePlayer';
import { time } from './Player';
import SpotifyLogo from './SpotifyLogo';

interface Props {
  playlists: SpotifyPlaylist[]; batches: PlaylistBatch[]; jobs: DownloadJob[]; tracks: Track[];
  auth: SpotifyAuthStatus; tools: ToolStatus; player: PlayerState;
  onPlaylist: (playlist: SpotifyPlaylist) => void; onBatch: (batch: PlaylistBatch) => void; onJob: (job: DownloadJob) => void;
  onSettings: () => void; fail: (message: string) => void; success: (message: string) => void; requireDesktop: () => boolean;
}
const itemLabels: Record<PlaylistBatchItem['stage'], string> = { queued: 'Đang chờ', resolving: 'Tìm nguồn', downloading: 'Đang tải', completed: 'Đã tải', error: 'Có lỗi', 'needs-review': 'Cần chọn nguồn', cancelled: 'Đã hủy' };
const PAGE_SIZE = 100;

export default function PlaylistsView(props: Props) {
  const { playlists, batches, jobs, tracks, auth, tools, player, onPlaylist, onBatch, onJob, onSettings, fail, success, requireDesktop } = props;
  const [url, setUrl] = useState('');
  const [importing, setImporting] = useState<'url' | 'file' | null>(null);
  const [selectedId, setSelectedId] = useState(playlists[0]?.id || '');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rights, setRights] = useState(false);
  const [autoMatch, setAutoMatch] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [review, setReview] = useState<{ entry: PlaylistTrack; loading: boolean; match?: SpotifyMatch; error?: string } | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [reviewRights, setReviewRights] = useState(false);
  const [reviewStarting, setReviewStarting] = useState(false);
  const reviewRequest = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const playlist = playlists.find(item => item.id === selectedId) ?? playlists[0];
  const batch = batches.find(item => item.playlistId === playlist?.id);
  const localTracks = useMemo(() => new Map(tracks.map(track => [track.id, track])), [tracks]);
  const batchItems = useMemo(() => new Map(batch?.items.map(item => [item.entryId, item]) ?? []), [batch]);
  const jobMap = useMemo(() => new Map(jobs.map(job => [job.id, job])), [jobs]);
  const eligible = useMemo(() => playlist?.tracks.filter(entry => !entry.localTrackId || !localTracks.has(entry.localTrackId)) ?? [], [playlist, localTracks]);
  const selectedEntries = useMemo(() => eligible.filter(entry => selected.has(entry.id)), [eligible, selected]);
  const totalPages = Math.max(1, Math.ceil((playlist?.tracks.length || 0) / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const visibleEntries = useMemo(() => playlist?.tracks.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE) ?? [], [playlist, currentPage]);
  const allSelected = eligible.length > 0 && selectedEntries.length === eligible.length;
  const isRunning = batch?.stage === 'running';
  const ready = tools.ytDlp.available && tools.ffmpeg.available;
  const presentCount = useMemo(() => playlist?.tracks.filter(entry => entry.localTrackId && localTracks.has(entry.localTrackId)).length ?? 0, [playlist, localTracks]);
  useEffect(() => { if (!playlists.some(item => item.id === selectedId)) setSelectedId(playlists[0]?.id || ''); }, [playlists, selectedId]);
  useEffect(() => { setSelected(new Set()); setRights(false); setAutoMatch(false); setPage(0); }, [playlist?.id]);
  useEffect(() => { if (page !== currentPage) setPage(currentPage); }, [page, currentPage]);
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selectedEntries.length > 0 && !allSelected; }, [selectedEntries.length, allSelected]);
  useEffect(() => () => { ++reviewRequest.current; }, []);
  const openExternal = async (target?: string) => {
    if (!target || !requireDesktop()) return;
    try { await window.music!.openExternal(target); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };
  const importUrl = async (event: React.FormEvent) => {
    event.preventDefault(); if (!requireDesktop() || importing) return;
    if (!auth.connected) { fail('Kết nối Spotify trong Settings để nhập playlist qua API, hoặc dùng file CSV / JSON đã xuất.'); return; }
    setImporting('url');
    try { const imported = await window.music!.importSpotifyPlaylist(url.trim()); onPlaylist(imported); setSelectedId(imported.id); setUrl(''); success(`Đã nhập ${imported.tracks.length} bài từ playlist.`); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setImporting(null); }
  };
  const importFile = async () => {
    if (!requireDesktop() || importing) return; setImporting('file');
    try { const imported = await window.music!.importPlaylistFile(); if (imported) { onPlaylist(imported); setSelectedId(imported.id); success(`Đã nhập playlist từ file: ${imported.tracks.length} bài.`); } }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setImporting(null); }
  };
  const startBatch = async () => {
    if (!requireDesktop() || !playlist || starting) return;
    if (!selectedEntries.length) { fail('Chọn ít nhất một bài chưa có trên máy để tải.'); return; }
    if (!rights || !autoMatch) { fail('Xác nhận quyền tải và cách tự ghép nguồn YouTube trước khi tải nhiều bài.'); return; }
    if (!ready) { fail('Kiểm tra công cụ yt-dlp và FFmpeg trong Settings trước khi tải.'); return; }
    setStarting(true);
    try { onBatch(await window.music!.startPlaylistDownload({ playlistId: playlist.id, entryIds: selectedEntries.map(entry => entry.id), rightsConfirmed: rights, autoMatchConfirmed: autoMatch })); success('Đã bắt đầu tải các bài đã chọn. Bài chưa khớp chắc chắn sẽ chờ bạn chọn nguồn.'); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setStarting(false); }
  };
  const cancelBatch = async () => {
    if (!batch || !requireDesktop()) return; setCancelling(true);
    try { await window.music!.cancelPlaylistDownload(batch.id); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setCancelling(false); }
  };
  const closeReview = () => { ++reviewRequest.current; setReview(null); setCandidateId(''); setReviewRights(false); queueMicrotask(() => returnFocus.current?.focus()); };
  const reviewEntry = async (entry: PlaylistTrack) => {
    if (!requireDesktop()) return;
    if (!review) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const generation = ++reviewRequest.current;
    setReview({ entry, loading: true }); setCandidateId(''); setReviewRights(false);
    try { const match = await window.music!.prepareSpotify(entry.metadata.spotifyUrl); if (generation === reviewRequest.current) setReview({ entry, loading: false, match }); }
    catch (error) { if (generation === reviewRequest.current) setReview({ entry, loading: false, error: error instanceof Error ? error.message : String(error) }); }
  };
  const startManual = async () => {
    if (!review?.match || !candidateId || !reviewRights || !requireDesktop()) return;
    const generation = reviewRequest.current; setReviewStarting(true);
    try { const job = await window.music!.startDownload({ url: review.entry.metadata.spotifyUrl, rightsConfirmed: true, spotifyMatchId: review.match.id, candidateId }); onJob(job); if (generation === reviewRequest.current) { closeReview(); success('Đã bắt đầu tải nguồn bạn chọn. Theo dõi tiến trình ở Downloader.'); } }
    catch (error) { if (generation === reviewRequest.current) fail(error instanceof Error ? error.message : String(error)); }
    finally { setReviewStarting(false); }
  };
  const toggleEntry = (id: string, checked: boolean) => setSelected(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; });
  const resolvedCount = useMemo(() => batch ? batch.items.filter(item => ['completed', 'error', 'needs-review', 'cancelled'].includes(item.stage)).length : 0, [batch]);
  return <div className="playlists-page page-content">
    <div className="view-intro"><span className="eyebrow">YOUR COLLECTION, TOGETHER</span><h2>Một playlist. Nhiều bản nhạc.</h2><p>Nhập danh sách yêu thích, chọn bài và lưu các nguồn được phép sử dụng thành FLAC.</p></div>
    <section className="playlist-import-card"><form onSubmit={event => void importUrl(event)}><label className="field-label" htmlFor="playlist-url">Spotify playlist URL</label><div className="playlist-import-row"><span className="playlist-link-icon"><SpotifyLogo size={19} /></span><input id="playlist-url" type="url" required value={url} placeholder="https://open.spotify.com/playlist/…" disabled={Boolean(importing)} onChange={event => setUrl(event.target.value)} /><button className="primary-button" type="submit" disabled={!url.trim() || Boolean(importing)}>{importing === 'url' ? <LoaderCircle size={15} className="spin" /> : <Plus size={16} />} Nhập playlist</button></div></form><div className="playlist-import-footer"><span>{auth.connected ? <><span className="status-dot" /> Spotify đã kết nối{auth.displayName ? ` · ${auth.displayName}` : ''}</> : <>Chưa kết nối Spotify. <button className="text-button" onClick={onSettings}>Kết nối trong Settings</button></>}</span><button className="text-button" disabled={Boolean(importing)} onClick={() => void importFile()}>{importing === 'file' ? <LoaderCircle size={14} className="spin" /> : <FileUp size={14} />} Import CSV / JSON</button></div></section>
    {!playlists.length ? <div className="playlists-empty"><div className="empty-icon large"><ListMusic size={30} strokeWidth={1.4} /></div><h3>Những bài hát hay thường đi cùng nhau.</h3><p>Nhập playlist qua liên kết Spotify hoặc file CSV / JSON đã xuất.<br />Danh sách được lưu trên máy và có thể mở lại ở lần sau.</p></div> : <>
      <div className="playlist-picker-row"><label className="field-label" htmlFor="saved-playlist">PLAYLIST ĐÃ LƯU <span className="count">{playlists.length}</span></label><select id="saved-playlist" value={playlist?.id || ''} onChange={event => setSelectedId(event.target.value)}>{playlists.map(item => <option key={item.id} value={item.id}>{item.name} · {item.tracks.length} bài</option>)}</select></div>
      {playlist && <section className="playlist-detail"><header className="playlist-cover-header"><div className="playlist-cover">{playlist.coverUrl ? <img src={playlist.coverUrl} alt={`Ảnh bìa playlist ${playlist.name}`} /> : <ListMusic size={34} strokeWidth={1.3} />}</div><div className="playlist-description"><span className="eyebrow">{playlist.source === 'spotify' ? 'SPOTIFY PLAYLIST' : 'IMPORTED PLAYLIST'}</span><h3>{playlist.name}</h3><p>{playlist.owner ? `${playlist.owner} · ` : ''}{playlist.tracks.length} bài nhập được · {presentCount} bài trên máy{playlist.skipped > 0 ? ` · ${playlist.skipped} mục bỏ qua` : ''}</p>{playlist.url && <button className="text-button spotify-attribution" onClick={() => void openExternal(playlist.url)}><SpotifyLogo size={14} /> Mở playlist trên Spotify <ExternalLink size={12} /></button>}</div><span className="playlist-saved"><Check size={12} /> Đã lưu trên máy</span></header>
        {batch && <div className={`batch-summary batch-${batch.stage}`} aria-live="polite"><div className="batch-summary-top"><span>{batch.stage === 'running' ? <LoaderCircle size={16} className="spin" /> : <CheckCheck size={16} />}<strong>{batch.stage === 'running' ? 'Đang xử lý playlist' : batch.stage === 'cancelled' ? 'Đã hủy đợt tải' : 'Đã xử lý đợt tải'}</strong><small>{resolvedCount} / {batch.total} bài</small></span>{isRunning && <button className="text-button" disabled={cancelling} onClick={() => void cancelBatch()}>{cancelling ? <LoaderCircle size={12} className="spin" /> : <X size={12} />} Hủy đợt tải</button>}</div><div className="progress-track"><i style={{ width: `${batch.total ? Math.min(100, resolvedCount / batch.total * 100) : 0}%` }} /></div><div className="batch-counts"><span><i className="batch-dot completed" /> {batch.completed} hoàn tất</span><span><i className="batch-dot review" /> {batch.reviewRequired} cần chọn nguồn</span><span><i className="batch-dot error" /> {batch.failed} có lỗi</span></div></div>}
        <div className="playlist-selection-bar"><label className="checkbox-label"><input ref={selectAll} type="checkbox" checked={allSelected} disabled={!eligible.length || isRunning} onChange={event => setSelected(event.target.checked ? new Set(eligible.map(entry => entry.id)) : new Set())} /> Chọn tất cả bài chưa tải</label><span>{selectedEntries.length} đã chọn</span></div>
        <div className="playlist-track-list"><div className="playlist-track-row playlist-track-head"><span /><span>#</span><span>BÀI HÁT / NGHỆ SĨ</span><span>ALBUM</span><span>THỜI LƯỢNG</span><span>TRẠNG THÁI / NGUỒN</span></div>{visibleEntries.map((entry, index) => {
          const local = entry.localTrackId ? localTracks.get(entry.localTrackId) : undefined;
          const item = batchItems.get(entry.id); const job = item?.jobId ? jobMap.get(item.jobId) : undefined;
          return <div className={`playlist-track-row ${local ? 'playlist-track-local' : ''}`} key={entry.id}><input type="checkbox" aria-label={`Chọn ${entry.metadata.title}`} checked={!local && selected.has(entry.id)} disabled={Boolean(local) || isRunning} onChange={event => toggleEntry(entry.id, event.target.checked)} /><span className="playlist-row-index">{currentPage * PAGE_SIZE + index + 1}</span><div className="playlist-track-identity"><div className="playlist-track-art">{entry.metadata.coverUrl ? <img src={entry.metadata.coverUrl} alt="" /> : <Disc3 size={17} />}</div><span className="truncate"><strong>{entry.metadata.title}</strong><small>{entry.metadata.artist}</small></span>{entry.metadata.spotifyUrl && <button className="icon-button small playlist-spotify-link" aria-label={`Mở ${entry.metadata.title} trên Spotify`} title="Mở trên Spotify" onClick={() => void openExternal(entry.metadata.spotifyUrl)}><SpotifyLogo size={12} /></button>}{local && <button className="icon-button small" aria-label={`Phát ${entry.metadata.title}`} onClick={() => void player.play(local)}>{player.track?.id === local.id && player.playing ? <span className="playing-note">♫</span> : <Play size={14} fill="currentColor" />}</button>}</div><span className="album-cell truncate" title={entry.metadata.album}>{entry.metadata.album || '—'}</span><span className="duration-cell">{time(entry.metadata.duration)}</span><div className="playlist-track-status">{local ? <span className="playlist-status completed"><Check size={12} /> Đã có</span> : <><span className={`playlist-status ${item?.stage || 'metadata'}`} title={item?.message}>{item ? itemLabels[item.stage] : 'Chưa tải'}{job && !['completed', 'cancelled', 'error'].includes(job.stage) && <small>{Math.round(job.progress)}%</small>}</span>{(!isRunning || item?.stage === 'needs-review' || item?.stage === 'error') && <button className="text-button" disabled={reviewStarting} onClick={() => void reviewEntry(entry)}>Chọn nguồn</button>}</>}{item?.message && ['error', 'needs-review'].includes(item.stage) && !local && <small className="playlist-item-error" title={item.message}>{item.message}</small>}</div></div>;
        })}</div>
        {playlist.tracks.length > 0 && <nav className="playlist-pagination" aria-label="Phân trang playlist"><div><span>{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, playlist.tracks.length)} / {playlist.tracks.length} bài</span><small>Chọn tất cả áp dụng cho toàn bộ playlist.</small></div><div><button className="subtle-button" aria-label="Trang playlist trước" disabled={currentPage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}><ChevronLeft size={14} /> Trước</button><span>Trang {currentPage + 1} / {totalPages}</span><button className="subtle-button" aria-label="Trang playlist tiếp theo" disabled={currentPage >= totalPages - 1} onClick={() => setPage(value => Math.min(totalPages - 1, value + 1))}>Tiếp <ChevronRight size={14} /></button></div></nav>}
        {!playlist.tracks.length && <p className="playlist-no-tracks">Playlist không có bài hỗ trợ. Thử playlist khác hoặc kiểm tra file đã xuất.</p>}
        <div className="playlist-download-footer"><div><label className="checkbox-label"><input type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)} /> Tôi có quyền tải và chuyển đổi các nguồn âm thanh đã chọn.</label><label className="checkbox-label"><input type="checkbox" checked={autoMatch} onChange={event => setAutoMatch(event.target.checked)} /> Cho phép tự ghép nguồn YouTube phù hợp; bài chưa chắc chắn cần tôi duyệt.</label><p><AlertCircle size={12} /> Spotify chỉ cung cấp danh sách và metadata. FLAC không phục hồi chất lượng của nguồn nén mất dữ liệu.</p></div><button className="primary-button" disabled={!selectedEntries.length || !rights || !autoMatch || isRunning || starting} onClick={() => void startBatch()}>{starting ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />} Tải {selectedEntries.length || ''} bài đã chọn</button></div>
      </section>}
    </>}
    {review && <div className="source-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !reviewStarting) closeReview(); }}><section className="source-modal" role="dialog" aria-modal="true" aria-labelledby="source-review-title" onKeyDown={event => { if (event.key === 'Escape' && !reviewStarting) closeReview(); if (event.key === 'Tab') { const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')); const first = buttons[0]; const last = buttons[buttons.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }}><div className="section-heading"><div><span className="eyebrow">CHOOSE YOUR RECORDING</span><h3 id="source-review-title">Kiểm tra nguồn âm thanh</h3></div><button className="icon-button" aria-label="Đóng chọn nguồn" autoFocus disabled={reviewStarting} onClick={closeReview}><X size={18} /></button></div><div className="source-review-title"><strong>{review.entry.metadata.title}</strong><small>{review.entry.metadata.artist} · {time(review.entry.metadata.duration)}</small></div>{review.loading ? <div className="review-loading"><LoaderCircle size={22} className="spin" /><p>Đang tìm các bản thu tương ứng…</p></div> : review.error ? <div className="review-error"><AlertCircle size={20} /><p>{review.error}</p><button className="text-button" onClick={() => void reviewEntry(review.entry)}>Thử lại</button></div> : <><p className="match-instruction">Mở nguồn để nghe kiểm tra và chọn đúng bản thu. Kết quả tìm kiếm có thể khác bản Spotify.</p><div className="candidate-list">{review.match?.candidates.map(candidate => <label className={`candidate ${candidateId === candidate.id ? 'checked' : ''}`} key={candidate.id}><input type="radio" name="playlist-review-candidate" checked={candidateId === candidate.id} onChange={() => setCandidateId(candidate.id)} /><span className="truncate"><strong>{candidate.title}</strong><small>{candidate.channel} · {time(candidate.duration)}</small></span><button type="button" className="icon-button" aria-label={`Kiểm tra ${candidate.title}`} onClick={() => void openExternal(candidate.url)}><ExternalLink size={15} /></button></label>)}</div><label className="checkbox-label"><input type="checkbox" checked={reviewRights} onChange={event => setReviewRights(event.target.checked)} /> Tôi có quyền tải nguồn âm thanh đã chọn.</label><div className="source-modal-footer"><button className="subtle-button" disabled={reviewStarting} onClick={closeReview}>Để sau</button><button className="primary-button" disabled={!candidateId || !reviewRights || reviewStarting} onClick={() => void startManual()}>{reviewStarting ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />} Tải nguồn đã chọn</button></div></>}</section></div>}
  </div>;
}
