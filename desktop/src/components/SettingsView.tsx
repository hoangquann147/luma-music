import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Camera, Check, ChevronRight, Cloud, ExternalLink, Folder, FolderOpen, Headphones, Link2, LoaderCircle, Search, ShieldCheck, SlidersHorizontal, UserRound, Volume2, VolumeX, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Settings, SettingsUpdate, SpotifyAuthStatus, ToolStatus, UserProfile } from '../../shared/types';
import type { PlayerState } from '../hooks/usePlayer';
import type { LibraryOrganizeResult } from '../../shared/album-types';
import SpotifyConnection from './SpotifyConnection';
import SpotifyLogo from './SpotifyLogo';
import DriveSettings from './DriveSettings';
import EqualizerPanel from './EqualizerPanel';

export type SettingsCategory = 'profile' | 'library' | 'downloads' | 'spotify' | 'playback' | 'equalizer' | 'drive' | 'links';
type Category = SettingsCategory;
interface NavigationItem { id: Category; label: string; description: string; icon: LucideIcon; keywords: string }
const navigation: { title: string; items: NavigationItem[] }[] = [
  { title: 'CÁ NHÂN', items: [{ id: 'profile', label: 'Hồ sơ', description: 'Tên và ảnh của bạn', icon: UserRound, keywords: 'profile avatar anh dai dien name ten ca nhan' }] },
  { title: 'ÂM NHẠC', items: [
    { id: 'library', label: 'Thư viện local', description: 'Nơi lưu bộ sưu tập', icon: Folder, keywords: 'local library thu muc luu nhac file flac m4a aac alac' },
    { id: 'downloads', label: 'Tải & chuyển đổi', description: 'Công cụ đi kèm', icon: ArrowDownToLine, keywords: 'download converter yt-dlp ffmpeg ffprobe deno duong dan' },
    { id: 'spotify', label: 'Spotify & metadata', description: 'Tài khoản và playlist', icon: Headphones, keywords: 'spotify api client id secret market oauth dang nhap playlist ket noi' },
    { id: 'playback', label: 'Phát nhạc', description: 'Âm lượng và đầu ra', icon: AudioLines, keywords: 'player playback am luong volume loa giai ma chat luong' },
    { id: 'equalizer', label: 'Equalizer', description: '10 dải tần & preset', icon: SlidersHorizontal, keywords: 'equalizer eq am thanh tan so bass treble preamp preset can bang' },
    { id: 'drive', label: 'Đồng bộ Google Drive', description: 'Nhạc từ PC đến Android', icon: Cloud, keywords: 'google drive dong bo sync android dien thoai cloud upload tai len offline' },
  ] },
  { title: 'THÔNG TIN', items: [{ id: 'links', label: 'Liên kết', description: 'Tài liệu và nguồn chính thức', icon: Link2, keywords: 'links tai lieu website dashboard github spotify ffmpeg deno yt-dlp' }] },
];
const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replaceAll('đ', 'd');
const categories = navigation.flatMap(group => group.items);
interface Props {
  settings: Settings; tools: ToolStatus; setSettings: (settings: Settings) => void; setTools: (tools: ToolStatus) => void;
  spotifyAuth: SpotifyAuthStatus; onSpotifyAuth: (auth: SpotifyAuthStatus) => void;
  profile: UserProfile; onProfile: (profile: UserProfile) => void; player: PlayerState; onLibraryOrganized: (result: LibraryOrganizeResult) => void;
  fail: (message: string) => void; success: (message: string) => void; requireDesktop: () => boolean;
  initialCategory?: SettingsCategory;
  navigationRequest?: number;
}

export default function SettingsView({ settings, tools, setSettings, setTools, spotifyAuth, onSpotifyAuth, profile, onProfile, player, onLibraryOrganized, fail, success, requireDesktop, initialCategory = 'profile', navigationRequest = 0 }: Props) {
  const [category, setCategory] = useState<Category>(initialCategory);
  const contentRef = useRef<HTMLElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<SettingsUpdate>({ ...settings, spotifyClientSecret: '' });
  const [name, setName] = useState(profile.name);
  const [saving, setSaving] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [choosingPhoto, setChoosingPhoto] = useState(false);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const [checking, setChecking] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [organizeSummary, setOrganizeSummary] = useState('');
  useEffect(() => setName(profile.name), [profile.name]);
  useEffect(() => { setCategory(initialCategory); setSearch(''); }, [initialCategory, navigationRequest]);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [category, navigationRequest]);
  useEffect(() => {
    const list = navigationRef.current;
    const active = list?.querySelector<HTMLButtonElement>('[aria-current="page"]');
    if (!list || !active) return;
    const bounds = list.getBoundingClientRect(), item = active.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  }, [category, navigationRequest]);
  const query = normalize(search.trim());
  const filteredNavigation = navigation.map(group => ({ ...group, items: group.items.filter(item => normalize(`${item.label} ${item.description} ${item.keywords}`).includes(query)) })).filter(group => group.items.length > 0);
  const current = categories.find(item => item.id === category)!;
  const goToLinks = () => { setCategory('links'); setSearch(''); };
  const change = (key: keyof SettingsUpdate, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const save = async (update: SettingsUpdate, checkAfter = false) => {
    if (!requireDesktop() || saving) return; setSaving(true);
    try {
      const updated = await window.music!.saveSettings(update);
      setSettings(updated);
      setDraft(previous => { const next = { ...previous }; for (const key of Object.keys(update) as (keyof SettingsUpdate)[]) { if (key === 'spotifyClientSecret') next.spotifyClientSecret = ''; else next[key] = updated[key]; } return next; });
      onSpotifyAuth(await window.music!.spotifyStatus());
      if (checkAfter) setTools(await window.music!.checkTools());
      success('Đã lưu cài đặt.');
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault(); if (!requireDesktop() || savingProfile) return; setSavingProfile(true);
    try { onProfile(await window.music!.saveProfile({ name: name.trim() })); success('Đã lưu hồ sơ của bạn.'); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setSavingProfile(false); }
  };
  const choosePhoto = async () => {
    if (!requireDesktop() || choosingPhoto) return; setChoosingPhoto(true);
    try { const updated = await window.music!.chooseProfilePhoto(); if (updated) { onProfile(updated); success('Đã cập nhật ảnh hồ sơ.'); } }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setChoosingPhoto(false); }
  };
  const chooseDirectory = async () => {
    if (!requireDesktop()) return; setChoosingDirectory(true);
    try { const directory = await window.music!.selectDownloadDirectory(); if (directory) change('downloadDirectory', directory); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setChoosingDirectory(false); }
  };
  const chooseLibraryDirectory = async () => {
    if (!requireDesktop() || choosingDirectory || organizing) return; setChoosingDirectory(true);
    try { const directory = await window.music!.chooseLibraryDirectory(); if (directory) change('libraryDirectory', directory); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setChoosingDirectory(false); }
  };
  const organizeLibrary = async () => {
    if (!requireDesktop() || organizing || saving) return; setOrganizing(true); setOrganizeSummary('');
    try {
      const result = await window.music!.consolidateLibrary(); onLibraryOrganized(result);
      const summary = `Đã sao chép ${result.copied} bài vào thư viện chung.`;
      setOrganizeSummary(summary + (result.failed.length ? ` ${result.failed.length} bài chưa xử lý được.` : ' File nguồn được giữ nguyên.'));
      if (result.failed.length) fail(result.failed.map(item => `${item.title}: ${item.error}`).join('\n'));
      else success(summary);
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setOrganizing(false); }
  };
  const openLibraryDirectory = async () => {
    if (!requireDesktop()) return;
    try { await window.music!.openLibraryDirectory(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };
  const checkTools = async () => {
    if (!requireDesktop()) return; setChecking(true);
    try { setTools(await window.music!.checkTools()); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setChecking(false); }
  };
  const openLink = async (url: string) => {
    if (!requireDesktop()) return;
    try { await window.music!.openExternal(url); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="settings-layout">
    <aside className="settings-navigation" aria-label="Danh mục cài đặt">
      <div className="settings-navigation-heading"><h1>Settings</h1><span>Tạo một khoảng riêng.</span></div>
      <label className="settings-search"><Search size={17} /><input aria-label="Tìm trong cài đặt" placeholder="Tìm cài đặt" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && filteredNavigation[0]?.items[0]) setCategory(filteredNavigation[0].items[0].id); }} />{search && <button type="button" className="icon-button small" aria-label="Xóa tìm kiếm cài đặt" onClick={() => setSearch('')}><X size={13} /></button>}</label>
      <nav className="settings-category-list" ref={navigationRef}>{filteredNavigation.length ? filteredNavigation.map(group => <div className="settings-navigation-group" key={group.title}><div className="settings-group-label">{group.title}</div><div className="settings-group-items">{group.items.map(item => { const Icon = item.icon; return <button key={item.id} className={`settings-category ${category === item.id ? 'active' : ''}`} aria-current={category === item.id ? 'page' : undefined} onClick={() => setCategory(item.id)}><Icon size={20} strokeWidth={1.65} /><span><strong>{item.label}</strong><small>{item.description}</small></span><ChevronRight size={13} /></button>; })}</div></div>) : <div className="settings-search-empty" role="status"><Search size={23} strokeWidth={1.4} /><strong>Chưa tìm thấy mục phù hợp</strong><p>Thử “Spotify”, “ảnh” hoặc “âm lượng”.</p></div>}</nav>
      <div className="settings-brand"><AudioLines size={17} /><strong>Luma</strong><span>v1.5.0</span></div>
    </aside>
    <section className="settings-content" aria-labelledby="settings-category-heading" ref={contentRef}>
      <header className="settings-content-heading"><span className="eyebrow">YOUR SPACE, YOUR WAY</span><h2 id="settings-category-heading">{current.label}</h2><p>{({ profile: 'Một chút cá tính cho nơi bạn nghe nhạc.', library: 'Bộ sưu tập trên máy, luôn ở đúng nơi bạn muốn.', downloads: 'Mọi công cụ cần thiết đã đi cùng Luma.', spotify: 'Kết nối danh sách yêu thích và thông tin bài hát.', playback: 'Điều chỉnh âm thanh cho phút giây hiện tại.', equalizer: 'Một chút bass. Một chút sáng. Đúng gu của bạn.', drive: 'Đưa FLAC trên PC lên Drive để điện thoại tự tải về.', links: 'Các tài liệu và dịch vụ chính thức, tập trung ở một nơi.' } as const)[category]}</p></header>
      <div className="settings-content-body">
        {category === 'profile' && <form className="profile-form" onSubmit={event => void saveProfile(event)}>
          <div className="profile-photo-section"><button type="button" className="profile-photo" aria-label="Chọn ảnh hồ sơ" disabled={choosingPhoto || savingProfile} onClick={() => void choosePhoto()}>{profile.avatarDataUrl ? <img src={profile.avatarDataUrl} alt="Ảnh hồ sơ của bạn" /> : <UserRound size={43} strokeWidth={1.3} />}<span>{choosingPhoto ? <LoaderCircle size={16} className="spin" /> : <Camera size={16} />}</span></button><div><h3>Ảnh đại diện</h3><p>PNG, JPG hoặc WebP từ máy · tối đa 5 MB.</p><button type="button" className="profile-photo-button" disabled={choosingPhoto || savingProfile} onClick={() => void choosePhoto()}>{choosingPhoto ? 'Đang mở…' : 'Chọn ảnh'}</button></div></div>
          <label className="profile-name-label" htmlFor="profile-name">Tên hiển thị</label><input id="profile-name" name="profile-name" type="text" required disabled={savingProfile} autoComplete="nickname" maxLength={80} value={name} placeholder="Nhập tên của bạn" onChange={event => setName(event.target.value)} />
          <p className="profile-private-note"><ShieldCheck size={14} /> Hồ sơ chỉ lưu trên máy, không cần tạo tài khoản.</p>
          <button type="submit" className="settings-wide-save" disabled={savingProfile || choosingPhoto}>{savingProfile ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Lưu thay đổi</button>
        </form>}
        {category === 'library' && <div className="settings-category-form">
          <form onSubmit={event => { event.preventDefault(); void save({ libraryDirectory: draft.libraryDirectory }); }}>
            <div className="settings-card"><div className="settings-section-title"><Folder size={21} /><div><h3>Thư mục thư viện nhạc</h3><p>Một thư mục gốc. Mỗi album có thư mục con riêng.</p></div></div><label className="field-label" htmlFor="library-directory">Thư mục chung</label><div className="settings-input-row"><input id="library-directory" value={draft.libraryDirectory || ''} required disabled={saving || organizing} onChange={event => change('libraryDirectory', event.target.value)} placeholder="Music / Luma / Library" /><button type="button" className="subtle-button" disabled={choosingDirectory || saving || organizing} onClick={() => void chooseLibraryDirectory()}><FolderOpen size={16} /> Chọn</button></div><p className="settings-help">Nhạc import mới được sao chép vào đây, xếp theo album trong metadata hoặc album bạn chọn. File gốc luôn được giữ nguyên.</p><div className="settings-library-folder-actions"><button type="button" className="text-button" onClick={() => void openLibraryDirectory()}><FolderOpen size={14} /> Mở thư mục đã lưu</button></div></div>
            <button type="submit" className="settings-wide-save" disabled={saving || organizing || choosingDirectory}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Lưu thư mục thư viện</button>
          </form>
          <section className="settings-card"><div className="settings-section-title"><AudioLines size={21} /><div><h3>Gom nhạc đã có trong Library</h3><p>Sao chép các bài đang nằm ở nhiều nơi vào thư viện chung đã lưu.</p></div></div><p className="settings-plain-copy">Bài hát được nhận diện album từ tags có sẵn. Bài thiếu tên album có thể được xếp lại trong mục Albums. Thao tác không xóa file nguồn.</p><button type="button" className="subtle-button" disabled={organizing || saving || Boolean(draft.libraryDirectory && draft.libraryDirectory !== settings.libraryDirectory)} onClick={() => void organizeLibrary()}>{organizing ? <LoaderCircle size={15} className="spin" /> : <FolderOpen size={15} />} {organizing ? 'Đang sao chép nhạc…' : 'Gom nhạc vào thư mục chung'}</button>{draft.libraryDirectory && draft.libraryDirectory !== settings.libraryDirectory && <p className="settings-help">Lưu đường dẫn mới trước khi gom nhạc.</p>}{organizeSummary && <p className="settings-help" role="status">{organizeSummary}</p>}</section>
          <form onSubmit={event => { event.preventDefault(); void save({ downloadDirectory: draft.downloadDirectory }); }}><div className="settings-card"><div className="settings-section-title"><Folder size={21} /><div><h3>Thư mục tải nhạc</h3><p>Nơi lưu bản tải từ Downloader trước khi thêm vào thư viện album.</p></div></div><label className="field-label" htmlFor="output-directory">Download directory</label><div className="settings-input-row"><input id="output-directory" value={draft.downloadDirectory || ''} required onChange={event => change('downloadDirectory', event.target.value)} placeholder="Chọn nơi lưu FLAC" /><button type="button" className="subtle-button" disabled={choosingDirectory || organizing} onClick={() => void chooseDirectory()}><FolderOpen size={16} /> Chọn</button></div></div><button type="submit" className="settings-wide-save" disabled={saving || organizing}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Lưu thư mục tải</button></form>
        </div>}
        {category === 'downloads' && <form className="settings-category-form" onSubmit={event => { event.preventDefault(); void save({ ytDlpPath: draft.ytDlpPath, ffmpegPath: draft.ffmpegPath }, true); }}><div className="settings-card"><div className="settings-section-title"><SlidersHorizontal size={21} /><div><h3>Công cụ chuyển đổi</h3><p>yt-dlp, FFmpeg, ffprobe và Deno đã được đóng kèm bản Windows.</p></div></div><div className="settings-tool-fields"><div><label className="field-label" htmlFor="yt-dlp-path">yt-dlp</label><input id="yt-dlp-path" required value={draft.ytDlpPath || ''} onChange={event => change('ytDlpPath', event.target.value)} placeholder="yt-dlp" /><ToolIndicator status={tools.ytDlp} /></div><div><label className="field-label" htmlFor="ffmpeg-path">FFmpeg</label><input id="ffmpeg-path" required value={draft.ffmpegPath || ''} onChange={event => change('ffmpegPath', event.target.value)} placeholder="ffmpeg" /><ToolIndicator status={tools.ffmpeg} /></div></div><div className="settings-tools-actions"><span>Chỉ sửa đường dẫn khi bạn muốn dùng công cụ riêng.</span><button type="button" className="subtle-button" disabled={checking} onClick={() => void checkTools()}>{checking ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />} Kiểm tra</button></div><p className="settings-help">Kiểm tra dùng đường dẫn đã lưu và xác nhận cả ffprobe đi kèm FFmpeg.</p></div><button type="submit" className="settings-wide-save" disabled={saving}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Lưu công cụ</button><button type="button" className="settings-inline-navigation" onClick={goToLinks}>Tài liệu công cụ trong mục Liên kết <ArrowRight size={13} /></button></form>}
        {category === 'spotify' && <div className="settings-category-form"><form onSubmit={event => { event.preventDefault(); void save({ spotifyClientId: draft.spotifyClientId, spotifyMarket: draft.spotifyMarket, ...(draft.spotifyClientSecret ? { spotifyClientSecret: draft.spotifyClientSecret } : {}) }); }}><div className="settings-card"><div className="settings-section-title"><span className="spotify-brand"><SpotifyLogo size={22} /></span><div><h3>Spotify metadata</h3><p>Lưu Client ID trước khi kết nối. Đăng nhập playlist không cần Secret.</p></div></div><div className="settings-tool-fields"><div><label className="field-label" htmlFor="spotify-id">Client ID</label><input id="spotify-id" autoComplete="off" value={draft.spotifyClientId || ''} onChange={event => change('spotifyClientId', event.target.value)} placeholder="Spotify Developer Client ID" /></div><div><label className="field-label" htmlFor="spotify-secret">Client Secret <span className="optional-label">tùy chọn</span></label><input id="spotify-secret" type="password" autoComplete="new-password" value={draft.spotifyClientSecret || ''} onChange={event => change('spotifyClientSecret', event.target.value)} placeholder={settings.spotifyConfigured ? 'Đã lưu · để trống để giữ nguyên' : 'Chỉ dùng cho metadata Client Credentials'} /></div></div><div className="market-field"><label className="field-label" htmlFor="spotify-market">Market (mã quốc gia ISO)</label><input id="spotify-market" required pattern="[A-Z]{2}" maxLength={2} value={draft.spotifyMarket || 'VN'} onChange={event => change('spotifyMarket', event.target.value.toUpperCase())} /></div><p className="settings-help"><ShieldCheck size={13} /> Secret chỉ giữ trong tiến trình chính và được mã hóa khi lưu. Không lưu ở trình duyệt.</p></div><button type="submit" className="settings-wide-save" disabled={saving}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Lưu Spotify</button></form><SpotifyConnection auth={spotifyAuth} clientId={settings.spotifyClientId} onAuth={onSpotifyAuth} fail={fail} success={success} requireDesktop={requireDesktop} onNavigateLinks={goToLinks} /></div>}
        {category === 'playback' && <div className="settings-category-form"><div className="settings-card"><div className="settings-section-title"><Headphones size={21} /><div><h3>Âm lượng phát nhạc</h3><p>Thay đổi áp dụng ngay cho trình phát hiện tại.</p></div></div><div className="settings-volume-control"><button type="button" className="icon-button" aria-label={player.volume ? 'Tắt âm trình phát' : 'Bật âm trình phát'} onClick={() => player.setVolume(player.volume ? 0 : 0.7)}>{player.volume ? <Volume2 size={22} /> : <VolumeX size={22} />}</button><input className="slider" aria-label="Âm lượng trong cài đặt" type="range" min="0" max="1" step="0.01" value={player.volume} style={{ '--fill': `${player.volume * 100}%` } as React.CSSProperties} onChange={event => player.setVolume(Number(event.target.value))} /><output>{Math.round(player.volume * 100)}%</output></div><p className="settings-help">{player.track ? `Đang chọn: ${player.track.title} — ${player.track.artist}` : 'Âm lượng cũng có thể chỉnh ở thanh phát nhạc phía dưới.'}</p></div><div className="settings-card"><div className="settings-section-title"><AudioLines size={21} /><div><h3>Phát FLAC & M4A trên máy</h3><p>File gốc và thông tin bài hát luôn được giữ nguyên.</p></div></div><p className="settings-plain-copy">Chỉnh chất âm trong mục Equalizer. Thiết bị, driver và mixer hệ điều hành quyết định đầu ra cuối cùng.</p><button type="button" className="settings-inline-navigation" onClick={() => { setCategory('equalizer'); setSearch(''); }}>Mở Equalizer <ArrowRight size={13} /></button></div></div>}
        {category === 'equalizer' && <EqualizerPanel player={player} />}
        <DriveSettings visible={category === 'drive'} fail={fail} success={success} requireDesktop={requireDesktop} onNavigateLinks={goToLinks} />
        {category === 'links' && <div className="settings-links">{linkGroups.map(group => <section className="settings-link-group" key={group.title}><h3>{group.title}</h3><div>{group.links.map(link => <button type="button" className="settings-link-row" key={link.url} onClick={() => void openLink(link.url)}><span className="settings-link-icon"><BookOpen size={17} strokeWidth={1.6} /></span><span><strong>{link.title}</strong><small>{link.description}</small></span><ExternalLink size={15} /></button>)}</div></section>)}</div>}
      </div>
    </section>
  </div>;
}

function ToolIndicator({ status }: { status: ToolStatus['ytDlp'] }) {
  return <div className={`tool-indicator ${status.available ? 'available' : ''}`} title={status.error}><span />{status.available ? status.version || 'Sẵn sàng' : status.error || 'Chưa tìm thấy hoặc chưa kiểm tra'}</div>;
}
const linkGroups = [
  { title: 'Google Drive', links: [
    { title: 'Google Cloud Console · OAuth', description: 'Tạo OAuth Client ID loại Desktop app và bật Google Drive API.', url: 'https://console.cloud.google.com/apis/credentials' },
    { title: 'Đăng nhập Google cho ứng dụng Desktop', description: 'Hướng dẫn OAuth và quyền truy cập cho ứng dụng cài trên máy.', url: 'https://developers.google.com/identity/protocols/oauth2/native-app' },
    { title: 'Google Drive API', description: 'Tài liệu tải file và quản lý thư mục đồng bộ.', url: 'https://developers.google.com/workspace/drive/api/guides/about-sdk' },
  ] },
  { title: 'Spotify', links: [
    { title: 'Spotify Developer Dashboard', description: 'Tạo ứng dụng, lấy Client ID và đăng ký Redirect URI.', url: 'https://developer.spotify.com/dashboard' },
    { title: 'Hướng dẫn OAuth PKCE', description: 'Cách đăng nhập và cấp quyền truy cập playlist.', url: 'https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow' },
    { title: 'Thay đổi Spotify Web API', description: 'Điều kiện và giới hạn Development Mode.', url: 'https://developer.spotify.com/documentation/web-api/references/changes/february-2026' },
  ] },
  { title: 'Tải & chuyển đổi', links: [
    { title: 'yt-dlp', description: 'Mã nguồn, phiên bản và hướng dẫn tải âm thanh.', url: 'https://github.com/yt-dlp/yt-dlp' },
    { title: 'FFmpeg', description: 'Tài liệu và các bản phân phối chính thức.', url: 'https://ffmpeg.org/download.html' },
    { title: 'Deno', description: 'Runtime dùng để xử lý JavaScript challenge của YouTube.', url: 'https://deno.com/' },
  ] },
];
