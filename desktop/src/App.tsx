import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowRight, AudioLines, Check, CheckCircle2, ChevronRight, Disc3, DiscAlbum, Download, ExternalLink, Folder, FolderOpen, Headphones, Home, LibraryBig, ListMusic, LoaderCircle, Music2, Play, Plus, Search, Settings2, ShieldCheck, SlidersHorizontal, Trash2, Upload, X } from 'lucide-react';
import type { BootstrapData, DownloadJob, PlaylistBatch, Settings, SpotifyAuthStatus, SpotifyMatch, SpotifyPlaylist, ToolStatus, Track, UserProfile } from '../shared/types';
import Player, { Artwork, time } from './components/Player';
import { usePlayer } from './hooks/usePlayer';
import PlaylistsView from './components/PlaylistsView';
import SettingsView, { type SettingsCategory } from './components/SettingsView';
import { trackFormatLabel, trackQualityLabel } from './audio/track-format';
import AlbumsView from './components/AlbumsView';
import type { Album, LibraryOrganizeResult } from '../shared/album-types';

type Tab = 'home' | 'library' | 'albums' | 'playlists' | 'downloader' | 'settings';
const names: Record<Tab, string> = { home: 'Home', library: 'Library', albums: 'Albums', playlists: 'Playlists', downloader: 'Downloader', settings: 'Settings' };
const initialSettings: Settings = { downloadDirectory: '', ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', spotifyClientId: '', spotifyConfigured: false, spotifyMarket: 'VN' };
const initialTools: ToolStatus = { ytDlp: { available: false }, ffmpeg: { available: false } };
const terminal = (job: DownloadJob) => ['completed', 'cancelled', 'error'].includes(job.stage);
const stageNames: Record<DownloadJob['stage'], string> = { queued: 'Đang chờ', resolving: 'Đang tìm nguồn', downloading: 'Đang tải âm thanh', converting: 'Đang chuyển đổi FLAC', tagging: 'Đang ghi metadata', completed: 'Hoàn tất', cancelled: 'Đã hủy', error: 'Không thành công' };
const mergeTracks = (current: Track[], incoming: Track[]) => [...new Map([...current, ...incoming].map(track => [track.id, track])).values()];
const mergeById = <T extends { id: string }>(current: T[], incoming: T[]) => [...new Map([...current, ...incoming].map(item => [item.id, item])).values()];

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [settingsNavigation, setSettingsNavigation] = useState<{ category: SettingsCategory; request: number }>({ category: 'profile', request: 0 });
  const openEqualizer = () => { setSettingsNavigation(value => ({ category: 'equalizer', request: value.request + 1 })); setTab('settings'); };
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const onLibraryOrganized = (result: LibraryOrganizeResult) => { setTracks(result.tracks); setAlbums(result.albums); };
  const refreshAlbums = () => window.music?.getAlbums().then(setAlbums).catch(error => fail(String(error.message || error)));
  const openLibrarySettings = () => { setSettingsNavigation(value => ({ category: 'library', request: value.request + 1 })); setTab('settings'); };
  const [settings, setSettings] = useState(initialSettings);
  const [tools, setTools] = useState(initialTools);
  const [profile, setProfile] = useState<UserProfile>({ name: '' });
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [playlistBatches, setPlaylistBatches] = useState<PlaylistBatch[]>([]);
  const [spotifyAuth, setSpotifyAuth] = useState<SpotifyAuthStatus>({ connected: false, redirectUri: 'http://127.0.0.1:43827/callback' });
  const [loading, setLoading] = useState(Boolean(window.music));
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const fail = useCallback((text: string) => setMessage({ text, kind: 'error' }), []);
  const success = useCallback((text: string) => setMessage({ text, kind: 'success' }), []);
  const player = usePlayer(tracks, fail);
  const requireDesktop = () => { if (!window.music) { fail('Mở ứng dụng bằng Electron để truy cập file và công cụ tải nhạc.'); return false; } return true; };
  useEffect(() => {
    if (!window.music) return;
    let active = true;
    const off = window.music.onDownloadUpdate(job => {
      if (!active) return;
      setJobs(current => [job, ...current.filter(item => item.id !== job.id)]);
      if (job.track) { setTracks(current => mergeTracks(current, [job.track!])); void refreshAlbums(); }
    });
    const offPlaylist = window.music.onPlaylistUpdate(playlist => {
      if (active) setPlaylists(current => mergeById(current, [playlist]));
    });
    const offBatch = window.music.onPlaylistBatchUpdate(batch => {
      if (active) setPlaylistBatches(current => current.some(item => item.id === batch.id) ? current.map(item => item.id === batch.id ? batch : item) : [batch, ...current]);
    });
    void window.music.bootstrap().then((data: BootstrapData) => {
      if (!active) return;
      setTracks(current => mergeTracks(data.tracks, current)); setSettings(data.settings); setTools(data.tools); setProfile(data.profile || { name: '' });
      setAlbums(current => mergeById(data.albums || [], current));
      setJobs(current => [...current, ...data.jobs.filter(job => !current.some(item => item.id === job.id))]);
      setSpotifyAuth(data.spotifyAuth || { connected: false, redirectUri: 'http://127.0.0.1:43827/callback' });
      setPlaylists(current => mergeById(data.playlists || [], current));
      setPlaylistBatches(current => [...current, ...(data.playlistBatches || []).filter(batch => !current.some(item => item.id === batch.id))]);
    }).catch(error => active && fail(String(error.message || error))).finally(() => active && setLoading(false));
    return () => { active = false; off(); offPlaylist(); offBatch(); };
  }, [fail]);
  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(null), 7000); return () => window.clearTimeout(timer); }, [message]);
  const importFiles = async () => {
    if (!requireDesktop() || importing) return;
    setImporting(true);
    try { const imported = await window.music!.importFiles(); setTracks(current => mergeTracks(current, imported)); if (imported.length) { await refreshAlbums(); success(`Đã thêm ${imported.length} bài hát vào thư viện và xếp theo album.`); } }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setImporting(false); }
  };
  const removeTrack = async (track: Track) => {
    if (!requireDesktop()) return;
    try { await window.music!.removeTrack(track.id); setTracks(current => current.filter(item => item.id !== track.id)); await refreshAlbums(); success('Đã gỡ khỏi thư viện. File gốc vẫn được giữ trên máy.'); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };
  const revealTrack = async (track: Track) => { if (!requireDesktop()) return; try { await window.music!.revealTrack(track.id); } catch (error) { fail(String(error)); } };
  const [query, setQuery] = useState('');
  const [playlistFilter, setPlaylistFilter] = useState('');
  const playlistTrackIds = playlistFilter ? new Set(playlists.find(item => item.id === playlistFilter)?.tracks.map(entry => entry.localTrackId).filter(Boolean)) : null;
  const filteredTracks = tracks.filter(track => (!playlistTrackIds || playlistTrackIds.has(track.id)) && `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="app-shell">
    <aside className="sidebar" aria-label="Điều hướng chính">
      <div className="brand-mark" title="Luma"><AudioLines size={21} strokeWidth={1.8} /></div>
      <nav>{([{ id: 'home', icon: Home }, { id: 'library', icon: LibraryBig }, { id: 'albums', icon: DiscAlbum }, { id: 'playlists', icon: ListMusic }, { id: 'downloader', icon: Download }] as const).map(({ id, icon: Icon }) => <button key={id} className={`nav-item ${tab === id ? 'active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><span className="nav-icon"><Icon size={22} strokeWidth={1.8} /></span><span>{names[id]}</span>{id === 'downloader' && jobs.some(job => !terminal(job)) && <i className="activity-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><span className="sidebar-version">LUMA</span><button className={`nav-item ${tab === 'settings' ? 'active' : ''}`} aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}><span className="nav-icon"><Settings2 size={22} strokeWidth={1.8} /></span><span>Settings</span></button></div>
    </aside>
    <main className={`main-view ${tab === 'settings' ? 'settings-mode' : ''}`}>
      {tab !== 'settings' && <header className="page-header"><div><div className="breadcrumb">YOUR PERSONAL SOUNDSPACE</div><h1>{names[tab]}</h1></div><div className="header-right"><span className="quality-pill"><span /> LOCAL FIRST</span><div className="header-avatar" title={profile.name || 'Hồ sơ của bạn'}>{profile.avatarDataUrl ? <img src={profile.avatarDataUrl} alt={profile.name ? `Ảnh hồ sơ ${profile.name}` : 'Ảnh hồ sơ'} /> : <Headphones size={19} />}</div></div></header>}
      {loading ? <div className="loading-state"><LoaderCircle className="spin" size={25} /><p>Đang mở thư viện…</p></div> : <>
        {tab === 'home' && <div className="home-page page-content">
          <section className="hero"><div className="hero-copy"><span className="eyebrow">LESS NOISE. MORE MUSIC.</span><h2>Một khoảng riêng<br />cho âm nhạc.</h2><p>Những bản nhạc bạn yêu, ở ngay trên máy.<br />Bấm phát và để mọi thứ chậm lại.</p><button className="primary-button" onClick={() => void importFiles()} disabled={importing}>{importing ? <LoaderCircle size={17} className="spin" /> : <Plus size={18} />} Import File <span className="button-separator" /><span className="button-caption">.flac · .m4a</span></button><div className="hero-footnote"><ShieldCheck size={14} /> Riêng tư. Không quảng cáo. Không gián đoạn.</div></div><div className="record-scene" aria-hidden="true"><div className="record-orbit orbit-one" /><div className="record-orbit orbit-two" /><div className="record-sleeve"><div className="sleeve-label">LUMA<br /><span>THE ART OF LISTENING</span></div><div className="sleeve-wave">{Array.from({ length: 23 }, (_, index) => <i key={index} style={{ height: `${14 + Math.sin(index * 0.72) ** 2 * 76}%` }} />)}</div><div className="sleeve-bottom"><span>SIDE A</span><span>33⅓ RPM</span></div></div><div className={`vinyl ${player.playing ? 'vinyl-playing' : ''}`}><div className="vinyl-label"><AudioLines size={25} /><small>LUMA</small><i /></div></div><div className="floating-format"><span className="format-dot" /><strong>FLAC + M4A</strong><span>Your music. Your space.</span></div></div></section>
          <section className="recent-section"><div className="section-heading"><div><span className="eyebrow">MADE FOR YOUR EARS</span><h3>Thư viện của bạn <span className="count">{tracks.length}</span></h3></div><button className="text-button" onClick={() => setTab('library')}>Xem thư viện <ArrowRight size={16} /></button></div>{tracks.length ? <div className="home-track-grid">{[...tracks].reverse().slice(0, 4).map(track => <button className="home-track" key={track.id} onClick={() => void player.play(track)}><Artwork track={track} size="large" /><span className="truncate"><strong>{track.title}</strong><small>{track.artist}</small></span><Play size={16} /></button>)}</div> : <div className="home-empty"><div className="empty-icon"><LibraryBig size={24} strokeWidth={1.5} /></div><div><strong>Bộ sưu tập đầu tiên bắt đầu từ một bài hát.</strong><p>Thêm file FLAC hoặc M4A để nghe từ bộ sưu tập của bạn.</p></div><button className="subtle-button" onClick={() => void importFiles()} disabled={importing}><Upload size={15} /> Thêm nhạc</button></div>}</section>
          <div className="home-bottom"><span><span className="status-dot" /> Tất cả âm nhạc. Một nơi của riêng bạn.</span><span>BUILT FOR LISTENING <AudioLines size={15} /></span></div>
        </div>}
        {tab === 'library' && <div className="library-page page-content"><section className="import-zone"><div className="import-icon"><FolderOpen size={29} strokeWidth={1.4} /></div><div><h2>Âm nhạc của bạn. Chất lượng nguyên bản.</h2><p>Nhạc FLAC/M4A được sao chép vào thư viện chung, chia thư mục theo album.</p></div><button className="primary-button" disabled={importing} onClick={() => void importFiles()}>{importing ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} Import File</button></section><div className="library-toolbar"><div className="library-heading"><h3>{playlistFilter ? 'Bài hát trong playlist' : 'Tất cả bài hát'}</h3><span className="count">{filteredTracks.length}</span></div>{playlists.length > 0 && <select className="library-playlist-filter" aria-label="Lọc thư viện theo playlist" value={playlistFilter} onChange={event => setPlaylistFilter(event.target.value)}><option value="">Tất cả playlist</option>{playlists.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select>}<label className="search-field"><Search size={16} /><input value={query} placeholder="Tìm bài hát, nghệ sĩ…" aria-label="Tìm trong thư viện" onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button small" aria-label="Xóa tìm kiếm" onClick={() => setQuery('')}><X size={14} /></button>}</label></div>{filteredTracks.length ? <div className="track-table"><div className="track-row table-head"><span>#</span><span>BÀI HÁT</span><span>ALBUM</span><span>CHẤT LƯỢNG</span><span>THỜI LƯỢNG</span><span /></div>{filteredTracks.map((track, index) => <div key={track.id} className={`track-row ${player.track?.id === track.id ? 'is-playing' : ''}`}><button className="row-play icon-button" onClick={() => void player.play(track)} aria-label={`Phát ${track.title}`}>{player.track?.id === track.id && player.playing ? <AudioLines size={17} /> : <><span className="row-index">{index + 1}</span><Play size={15} className="row-play-icon" fill="currentColor" /></>}</button><button className="track-identity" onClick={() => void player.play(track)}><Artwork track={track} /><span className="truncate"><strong>{track.title}</strong><small>{track.artist || 'Nghệ sĩ chưa rõ'}</small></span></button><span className="album-cell truncate">{track.album || '—'}</span><span className="quality-cell"><b>{trackFormatLabel(track)}</b><small>{trackQualityLabel(track)}</small></span><span className="duration-cell">{time(track.duration)}</span><div className="row-actions"><button className="icon-button small" aria-label={`Mở vị trí ${track.title}`} title="Mở vị trí file" onClick={() => void revealTrack(track)}><Folder size={16} /></button><button className="icon-button small" aria-label={`Gỡ ${track.title} khỏi thư viện`} title="Gỡ khỏi thư viện, giữ file gốc" onClick={() => void removeTrack(track)}><Trash2 size={15} /></button></div></div>)}</div> : <div className="library-empty"><div className="empty-icon large"><Music2 size={30} strokeWidth={1.4} /></div><h3>{query ? 'Chưa tìm thấy bài hát' : 'Một thư viện còn nhiều khoảng trống.'}</h3><p>{query ? 'Thử tên bài hát, nghệ sĩ hoặc album khác.' : 'Chọn file FLAC hoặc M4A yêu thích để bắt đầu nghe.'}</p>{!query && <button className="text-button" onClick={() => void importFiles()}>Import File <ArrowRight size={15} /></button>}</div>}<p className="library-note"><ShieldCheck size={14} /> Nhạc được giữ trong thư viện chung. Gỡ khỏi danh sách sẽ giữ các file nhạc trên máy.</p></div>}
        {tab === 'albums' && <AlbumsView albums={albums} tracks={tracks} directory={settings.libraryDirectory} player={player} onCreated={album => setAlbums(current => [...current.filter(item => item.id !== album.id), album])} onOrganized={onLibraryOrganized} onImport={() => void importFiles()} onSettings={openLibrarySettings} requireDesktop={requireDesktop} fail={fail} success={success} />}
        {tab === 'downloader' && <Downloader settings={settings} tools={tools} jobs={jobs} onJob={job => setJobs(current => current.some(item => item.id === job.id) ? current : [job, ...current])} onSettings={() => setTab('settings')} fail={fail} success={success} requireDesktop={requireDesktop} />}
        {tab === 'playlists' && <PlaylistsView playlists={playlists} batches={playlistBatches} jobs={jobs} tracks={tracks} auth={spotifyAuth} tools={tools} player={player} onPlaylist={playlist => setPlaylists(current => mergeById(current, [playlist]))} onBatch={batch => setPlaylistBatches(current => current.some(item => item.id === batch.id) ? current : [batch, ...current])} onJob={job => setJobs(current => current.some(item => item.id === job.id) ? current : [job, ...current])} onSettings={() => setTab('settings')} fail={fail} success={success} requireDesktop={requireDesktop} />}
        {tab === 'settings' && <SettingsView initialCategory={settingsNavigation.category} navigationRequest={settingsNavigation.request} settings={settings} tools={tools} setSettings={setSettings} setTools={setTools} spotifyAuth={spotifyAuth} onSpotifyAuth={setSpotifyAuth} profile={profile} onProfile={setProfile} player={player} onLibraryOrganized={onLibraryOrganized} fail={fail} success={success} requireDesktop={requireDesktop} />}
      </>}
    </main>
    {message && <div role={message.kind === 'error' ? 'alert' : 'status'} className={`toast toast-${message.kind}`}>{message.kind === 'success' ? <CheckCircle2 size={19} aria-hidden="true" /> : <span className="toast-error-icon" aria-hidden="true">!</span>}<span className="toast-message">{message.text}</span><button className="icon-button small" aria-label="Đóng thông báo" onClick={() => setMessage(null)}><X size={16} /></button></div>}
    <Player onOpenEqualizer={openEqualizer} player={player} tracks={player.queueTracks} queueOpen={queueOpen} setQueueOpen={setQueueOpen} />
  </div>;
}

interface CommonViewProps { fail: (message: string) => void; success: (message: string) => void; requireDesktop: () => boolean }
function Downloader({ settings, tools, jobs, onJob, onSettings, fail, success, requireDesktop }: CommonViewProps & { settings: Settings; tools: ToolStatus; jobs: DownloadJob[]; onJob: (job: DownloadJob) => void; onSettings: () => void }) {
  const [url, setUrl] = useState('');
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [match, setMatch] = useState<SpotifyMatch | null>(null);
  const [candidate, setCandidate] = useState('');
  const [cancelling, setCancelling] = useState<string[]>([]);
  const ready = tools.ytDlp.available && tools.ffmpeg.available;
  const openExternal = async (target: string) => {
    if (!requireDesktop()) return;
    try { await window.music!.openExternal(target); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };
  const reveal = async (id: string) => {
    if (!requireDesktop()) return;
    try { await window.music!.revealTrack(id); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!requireDesktop()) return;
    const cleaned = url.trim();
    let parsed: URL;
    try { parsed = new URL(cleaned); } catch { fail('Dán đường dẫn HTTPS của YouTube hoặc một bài hát Spotify.'); return; }
    if (parsed.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'music.youtube.com', 'youtu.be', 'open.spotify.com'].includes(parsed.hostname)) { fail('Chỉ hỗ trợ link HTTPS từ YouTube hoặc open.spotify.com.'); return; }
    if (!rights) { fail('Xác nhận bạn có quyền tải và chuyển đổi nguồn âm thanh này.'); return; }
    if (!ready) { fail('Không tìm thấy công cụ đi kèm. Mở Settings để kiểm tra lại đường dẫn.'); return; }
    setBusy(true);
    try {
      if (parsed.hostname === 'open.spotify.com' && !match) {
        const prepared = await window.music!.prepareSpotify(cleaned); setMatch(prepared); setCandidate('');
        if (!prepared.candidates.length) fail('Chưa tìm được nguồn phù hợp. Thử một bài khác hoặc dùng link YouTube trực tiếp.');
        else success('Đã lấy metadata Spotify. Chọn và kiểm tra nguồn âm thanh trước khi tải.');
        return;
      }
      if (match && !candidate) { fail('Chọn nguồn YouTube phù hợp với bài hát Spotify.'); return; }
      const job = await window.music!.startDownload({ url: cleaned, rightsConfirmed: rights, ...(match ? { spotifyMatchId: match.id, candidateId: candidate } : {}) });
      onJob(job); setUrl(''); setMatch(null); setCandidate(''); success('Đã thêm vào danh sách tải.');
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const cancel = async (id: string) => { if (!requireDesktop()) return; setCancelling(current => [...current, id]); try { await window.music!.cancelDownload(id); } catch (error) { fail(String(error)); } finally { setCancelling(current => current.filter(value => value !== id)); } };
  return <div className="downloader-page page-content"><div className="view-intro"><span className="eyebrow">SAVE IT FOR LATER</span><h2>Mang âm nhạc về bên bạn.</h2><p>Tải nguồn âm thanh được phép sử dụng và lưu trong thư viện FLAC.</p></div><form className="download-card" onSubmit={event => void submit(event)}><div className="download-card-heading"><span className="download-symbol"><ArrowDownToLine size={23} strokeWidth={1.7} /></span><div><h3>Download as FLAC</h3><p>YouTube · Spotify track metadata</p></div><span className="format-badge">.flac</span></div><label className="field-label" htmlFor="download-url">Đường dẫn bài hát</label><div className="download-input-row"><input id="download-url" type="url" required placeholder="Dán link YouTube hoặc Spotify…" value={url} disabled={busy} onChange={event => { setUrl(event.target.value); setMatch(null); setCandidate(''); }} /><button className="primary-button" type="submit" disabled={busy || !url.trim() || !rights}>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowDown size={17} />}{busy ? 'Đang xử lý…' : match ? 'Tải nguồn đã chọn' : 'Download as FLAC'}</button></div><label className="checkbox-label"><input type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)} />Tôi có quyền tải và chuyển đổi nguồn âm thanh này.</label>{match && <div className="spotify-match"><div className="spotify-metadata">{match.metadata.coverUrl ? <img src={match.metadata.coverUrl} alt={`Ảnh bìa ${match.metadata.album}`} /> : <div className="artwork"><Disc3 size={24} /></div>}<div className="truncate"><span className="eyebrow">SPOTIFY METADATA</span><strong>{match.metadata.title}</strong><small>{match.metadata.artist} · {time(match.metadata.duration)}</small><button type="button" className="text-button" onClick={() => void openExternal(match.metadata.spotifyUrl)}><SpotifyLogo /> Mở trên Spotify <ExternalLink size={12} /></button></div></div><p className="match-instruction">Chọn đúng bản thu từ YouTube. Nguồn tìm được có thể khác phiên bản Spotify.</p><div className="candidate-list">{match.candidates.map(item => <label className={`candidate ${candidate === item.id ? 'checked' : ''}`} key={item.id}><input type="radio" name="candidate" value={item.id} checked={candidate === item.id} onChange={() => setCandidate(item.id)} /><span className="truncate"><strong>{item.title}</strong><small>{item.channel} · {time(item.duration)}</small></span><button type="button" className="icon-button" aria-label={`Kiểm tra nguồn ${item.title}`} title="Mở nguồn để kiểm tra" onClick={() => void openExternal(item.url)}><ExternalLink size={15} /></button></label>)}</div></div>}<div className="download-quality"><AudioLines size={18} /><p><strong>Định dạng lossless, chất lượng theo nguồn.</strong> FLAC không khôi phục dữ liệu đã mất của nguồn YouTube. Spotify chỉ cung cấp metadata; âm thanh tải từ nguồn bạn chọn.</p></div><div className="download-destination"><Folder size={15} /><span className="truncate">{settings.downloadDirectory || 'Thư mục tải được cấu hình trong Settings'}</span><button className="text-button" type="button" onClick={onSettings}>Thay đổi <ChevronRight size={13} /></button></div></form>
    {!ready && <div className="tool-notice"><SlidersHorizontal size={18} /><span>Chưa nhận diện được công cụ đi kèm. Kiểm tra đường dẫn trong Settings.</span><button className="text-button" onClick={onSettings}>Kiểm tra công cụ <ArrowRight size={14} /></button></div>}
    <section className="downloads-section"><div className="section-heading"><div><span className="eyebrow">YOUR DOWNLOADS</span><h3>Hoạt động tải <span className="count">{jobs.length}</span></h3></div><span className="muted small-text">Tự động thêm vào Library</span></div>{jobs.length ? <div className="job-list">{jobs.map(job => <div className={`job-item job-${job.stage}`} key={job.id}><span className="job-icon">{job.stage === 'completed' ? <Check size={21} /> : job.stage === 'error' || job.stage === 'cancelled' ? <X size={20} /> : <Download size={21} />}</span><div className="job-content"><div className="job-title-row"><strong className="truncate">{job.title || job.url}</strong><span>{stageNames[job.stage]}</span></div>{!terminal(job) && <div className="progress-track"><i style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div>}<small className="job-message">{job.message || (job.stage === 'completed' ? 'Đã lưu FLAC vào thư viện.' : job.stage === 'cancelled' ? 'Đã dừng và dọn file tạm.' : job.url)}</small></div>{!terminal(job) && <button className="icon-button" aria-label={`Hủy tải ${job.title || 'bài hát'}`} disabled={cancelling.includes(job.id)} onClick={() => void cancel(job.id)}>{cancelling.includes(job.id) ? <LoaderCircle size={16} className="spin" /> : <X size={17} />}</button>}{job.track && <button className="icon-button" aria-label={`Mở file ${job.title}`} onClick={() => void reveal(job.track!.id)}><FolderOpen size={18} /></button>}</div>)}</div> : <div className="download-empty"><Download size={25} strokeWidth={1.4} /><strong>Chưa có bản tải nào.</strong><p>Dán đường dẫn ở trên để thêm bài hát đầu tiên.</p></div>}</section></div>;
}

function SpotifyLogo() { return <svg width="14" height="14" viewBox="0 0 24 24" role="img" aria-label="Spotify" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0Zm5.503 17.308a.75.75 0 0 1-1.032.248c-2.825-1.728-6.382-2.118-10.57-1.16a.75.75 0 0 1-.335-1.462c4.583-1.048 8.517-.596 11.69 1.345a.75.75 0 0 1 .247 1.029Zm1.47-3.272a.938.938 0 0 1-1.29.309c-3.235-1.989-8.166-2.565-11.993-1.403a.938.938 0 1 1-.544-1.794c4.372-1.327 9.805-.684 13.518 1.597a.938.938 0 0 1 .309 1.291Zm.126-3.409C15.22 8.324 8.82 8.112 5.116 9.236a1.125 1.125 0 0 1-.653-2.154C8.715 5.791 15.785 6.04 20.25 8.69a1.125 1.125 0 0 1-1.15 1.937Z" /></svg>; }
