import { app, safeStorage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import type { Settings, SettingsUpdate, Track, TrackSource } from '../../shared/types';
import { resolveToolPath, storedToolPath, toolsDirectory } from './tool-paths';
import { probeM4a } from './m4a-probe';
import type { Album, AlbumAssign, AlbumCreate, LibraryOrganizeResult } from '../../shared/album-types';
import { albumDirectory, copyVerified, inside, libraryRoot, retireCopy, safeStem, samePath, type RetiredCopy } from './managed-library';

interface DiskSettings {
  downloadDirectory: string;
  libraryDirectory: string;
  ytDlpPath: string;
  ffmpegPath: string;
  spotifyClientId: string;
  spotifyMarket: string;
  encryptedSpotifySecret?: string;
  bundledToolsDirectory?: string;
}
export interface InternalSettings extends Settings { spotifyClientSecret?: string }
type StoredAlbum = Omit<Album, 'trackCount' | 'coverDataUrl'>;
interface DiskState { version: 1; tracks: Track[]; settings: DiskSettings; albums: StoredAlbum[]; retiredCopies: RetiredCopy[] }
const UNKNOWN_ALBUM = 'Chưa phân album';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const cleanLabel = (value: string, fallback = '') => value.replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || fallback;
const albumKey = (name: string, artist: string) => JSON.stringify([name.normalize('NFC').toLocaleLowerCase(), artist.normalize('NFC').toLocaleLowerCase()]);
const stableAlbumId = (key: string) => { const h = createHash('sha256').update(key).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };

export class LibraryStore {
  private state!: DiskState;
  private readonly albumLookup = new WeakMap<DiskState, Map<string, StoredAlbum>>();
  private pendingWrite: Promise<void> = Promise.resolve();
  private readonly filePath = path.join(app.getPath('userData'), 'library.json');
  private readonly toolDirectory = toolsDirectory({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });

  async initialize(): Promise<void> {
    const defaults: DiskState = {
      version: 1, tracks: [], albums: [], retiredCopies: [],
      settings: {
        downloadDirectory: path.join(app.getPath('music'), 'Luma'),
        libraryDirectory: path.join(app.getPath('music'), 'Luma', 'Library'),
        ytDlpPath: 'bundled', ffmpegPath: 'bundled',
        bundledToolsDirectory: this.toolDirectory,
        spotifyClientId: '', spotifyMarket: 'VN',
      },
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let serialized: string;
    try { serialized = await fs.readFile(this.filePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Không đọc được thư viện hiện tại: ${(error as Error).message}`);
      this.state = defaults;
      return;
    }
    try {
      const parsed = JSON.parse(serialized) as DiskState;
      if (parsed.version !== 1 || !Array.isArray(parsed.tracks) || !parsed.settings) throw new Error('Unsupported library data');
      const albums = Array.isArray(parsed.albums) ? parsed.albums.filter(album => album && uuid.test(album.id) && typeof album.name === 'string' && typeof album.artist === 'string' && typeof album.folder === 'string' && path.basename(album.folder) === album.folder && album.folder !== '.' && album.folder !== '..') : [];
      this.state = { version: 1, tracks: parsed.tracks.map(track => ({ ...track })), settings: { ...defaults.settings, ...parsed.settings }, albums, retiredCopies: Array.isArray(parsed.retiredCopies) ? parsed.retiredCopies : [] };
      if (typeof this.state.settings.libraryDirectory !== 'string' || !path.isAbsolute(this.state.settings.libraryDirectory)) this.state.settings.libraryDirectory = defaults.settings.libraryDirectory;
      this.registerExistingAlbums(this.state);
      this.state.settings.ytDlpPath = storedToolPath('yt-dlp', this.state.settings.ytDlpPath, this.toolDirectory, parsed.settings.bundledToolsDirectory);
      this.state.settings.ffmpegPath = storedToolPath('ffmpeg', this.state.settings.ffmpegPath, this.toolDirectory, parsed.settings.bundledToolsDirectory);
      this.state.settings.bundledToolsDirectory = this.toolDirectory;
    } catch (error) {
      // Never replace an unreadable or corrupt library without preserving it.
      await fs.copyFile(this.filePath, `${this.filePath}.backup-${Date.now()}`);
      console.error('Invalid library; preserved a backup.', error);
      this.state = defaults;
    }
  }

  list(): Track[] { return this.state.tracks.map(track => ({ ...track })); }
  get(id: string): Track | undefined { return this.state.tracks.find(track => track.id === id); }

  listAlbums(): Album[] {
    const totals = new Map<string, { count: number; coverDataUrl?: string }>();
    for (const track of this.state.tracks) {
      if (!track.albumId) continue;
      const value = totals.get(track.albumId) || { count: 0, coverDataUrl: undefined };
      value.count++; value.coverDataUrl ||= track.coverDataUrl; totals.set(track.albumId, value);
    }
    return this.state.albums.map(album => {
      const value = totals.get(album.id);
      return { ...album, trackCount: value?.count || 0, coverDataUrl: value?.coverDataUrl };
    }).sort((a,b) => a.name.localeCompare(b.name, 'vi'));
  }

  private ensureAlbum(state: DiskState, name: string, artist: string, kind: StoredAlbum['kind'] = 'metadata'): StoredAlbum {
    name = cleanLabel(name, UNKNOWN_ALBUM); artist = name === UNKNOWN_ALBUM ? '' : cleanLabel(artist);
    const key = albumKey(name, artist);
    let lookup = this.albumLookup.get(state);
    if (!lookup) { lookup = new Map(state.albums.map(album => [albumKey(album.name, album.artist), album])); this.albumLookup.set(state, lookup); }
    const existing = lookup.get(key);
    if (existing) return existing;
    const id = stableAlbumId(key);
    const album: StoredAlbum = { id, name, artist, folder: `${safeStem(name + (artist ? ' - ' + artist : ''), 'Album', 42)}--${id}`, createdAt: new Date().toISOString(), kind };
    state.albums.push(album); lookup.set(key, album); return album;
  }

  private registerExistingAlbums(state: DiskState): void {
    const knownIds = new Set(state.albums.map(album => album.id));
    for (const track of state.tracks) {
      if (track.albumId && knownIds.has(track.albumId)) continue;
      const name = !track.album || track.album === 'Local collection' ? UNKNOWN_ALBUM : track.album;
      const album = this.ensureAlbum(state, name, track.albumArtist || (name === UNKNOWN_ALBUM ? '' : track.artist));
      track.albumId = album.id; track.album = album.name; track.albumArtist = album.artist;
    }
  }

  async createAlbum(input: AlbumCreate): Promise<Album> {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160 || /[\x00-\x1f]/.test(input.name) || (input.artist !== undefined && (typeof input.artist !== 'string' || input.artist.length > 160 || /[\x00-\x1f]/.test(input.artist)))) throw new Error('Tên album/nghệ sĩ không hợp lệ (tối đa 160 ký tự).');
    const albumId = await this.commit(async next => {
      const album = this.ensureAlbum(next, input.name, input.artist || '', 'manual');
      const root = await libraryRoot(next.settings.libraryDirectory);
      await albumDirectory(root, album.folder, album.id);
      return album.id;
    });
    return this.listAlbums().find(album => album.id === albumId)!;
  }

  async assignAlbum(input: AlbumAssign): Promise<LibraryOrganizeResult> {
    if (!input || !uuid.test(input.albumId) || !Array.isArray(input.trackIds) || !input.trackIds.length || input.trackIds.length > 10000 || input.trackIds.some(id => typeof id !== 'string' || !uuid.test(id))) throw new Error('Danh sách bài hát hoặc album không hợp lệ.');
    return this.organize([...new Set(input.trackIds)], input.albumId);
  }

  async consolidateLibrary(): Promise<LibraryOrganizeResult> { return this.organize(); }

  private async organize(ids?: string[], albumId?: string): Promise<LibraryOrganizeResult> {
    const created: string[] = [];
    let copied = 0;
    const failed: LibraryOrganizeResult['failed'] = [];
    try {
      await this.commit(async next => {
        const selected = ids ? ids.map(id => { const track = next.tracks.find(item => item.id === id); if (!track) throw new Error('Một bài hát không còn trong thư viện.'); return track; }) : [...next.tracks];
        const target = albumId ? next.albums.find(item => item.id === albumId) : undefined;
        if (albumId && !target) throw new Error('Album không còn trong thư viện.');
        const root = await libraryRoot(next.settings.libraryDirectory);
        for (const track of selected) {
          try {
            let album = target || next.albums.find(item => item.id === track.albumId)!;
            if (!album) throw new Error('Bài hát chưa có thông tin album.');
            // Older versions cached only album title, losing compilation album-artist.
            // Refresh tags only when the user explicitly consolidates a legacy track.
            // Manual assignments and absent/unreadable tags retain the user's grouping.
            if (!target && !track.managed && album.kind !== 'manual') {
              try {
                const { common } = await parseFile(track.path, { duration: false, skipCovers: true });
                if (common.album?.trim()) {
                  album = this.ensureAlbum(next, common.album, common.albumartist || (common.compilation ? 'Various Artists' : common.artist || track.albumArtist || track.artist));
                }
              } catch { /* The already saved album remains usable if tag parsing fails. */ }
            }
            const directory = await albumDirectory(root, album.folder, album.id);
            const extension = path.extname(track.path).toLowerCase();
            if (!['.flac', '.m4a'].includes(extension)) throw new Error('Định dạng file chưa hỗ trợ.');
            const destination = path.join(directory, `${safeStem(track.title, 'Track')}--${track.id}${extension}`);
            const result = await copyVerified(track.path, destination);
            if (result.created) { created.push(destination); copied++; }
            if (track.managed && track.albumId && !samePath(track.path, destination)) {
              const oldRoot = path.dirname(path.dirname(track.path));
              next.retiredCopies.push({ path: track.path, root: oldRoot, sha256: result.sha256, trackId: track.id, albumId: track.albumId });
            }
            const replacement: Track = { ...track, originalPath: track.originalPath || track.path, path: destination, managed: true, albumId: album.id, album: album.name, albumArtist: album.artist };
            next.tracks = next.tracks.map(item => item.id === track.id ? replacement : item);
          } catch (error) { failed.push({ trackId: track.id, title: track.title, error: (error as Error).message }); }
        }
        const occupied = new Set(next.tracks.map(track => track.albumId));
        next.albums = next.albums.filter(album => album.kind === 'manual' || occupied.has(album.id));
      });
    } catch (error) { await Promise.all(created.map(filename => fs.unlink(filename).catch(() => undefined))); throw error; }
    await this.cleanupManagedCopies();
    return { tracks: this.list(), albums: this.listAlbums(), copied, failed };
  }

  async cleanupManagedCopies(): Promise<void> {
    if (!this.state.retiredCopies.length) return;
    try {
      await this.commit(async next => {
        const retained: RetiredCopy[] = [];
        for (const copy of next.retiredCopies) {
          if (next.tracks.some(track => samePath(track.path, copy.path)) || !await retireCopy(copy)) retained.push(copy);
        }
        next.retiredCopies = retained;
      });
    } catch (error) { console.warn('Luma retained an old managed copy:', error); }
  }

  settings(): InternalSettings {
    let secret = process.env.SPOTIFY_CLIENT_SECRET || '';
    if (!secret && this.state.settings.encryptedSpotifySecret && safeStorage.isEncryptionAvailable()) {
      try { secret = safeStorage.decryptString(Buffer.from(this.state.settings.encryptedSpotifySecret, 'base64')); }
      catch { console.warn('Spotify secret cannot be decrypted on this device.'); }
    }
    const { encryptedSpotifySecret: _, bundledToolsDirectory: _directory, ...publicSettings } = this.state.settings;
    return {
      ...publicSettings,
      ytDlpPath: resolveToolPath('yt-dlp', publicSettings.ytDlpPath, this.toolDirectory, process.env.YT_DLP_PATH),
      ffmpegPath: resolveToolPath('ffmpeg', publicSettings.ffmpegPath, this.toolDirectory, process.env.FFMPEG_PATH),
      spotifyMarket: /^[A-Z]{2}$/.test((process.env.SPOTIFY_MARKET || '').toUpperCase()) ? process.env.SPOTIFY_MARKET!.toUpperCase() : publicSettings.spotifyMarket,
      spotifyClientId: process.env.SPOTIFY_CLIENT_ID || publicSettings.spotifyClientId,
      spotifyClientSecret: secret,
      spotifyConfigured: Boolean((process.env.SPOTIFY_CLIENT_ID || publicSettings.spotifyClientId) && secret),
    };
  }

  publicSettings(): Settings {
    const { spotifyClientSecret: _, ...settings } = this.settings();
    return settings;
  }

  async updateSettings(update: SettingsUpdate): Promise<Settings> {
    const { spotifyClientSecret, ...publicPatch } = update;
    if (publicPatch.ytDlpPath !== undefined) publicPatch.ytDlpPath = storedToolPath('yt-dlp', publicPatch.ytDlpPath, this.toolDirectory);
    if (publicPatch.ffmpegPath !== undefined) publicPatch.ffmpegPath = storedToolPath('ffmpeg', publicPatch.ffmpegPath, this.toolDirectory);
    let encrypted: string | undefined;
    if (spotifyClientSecret !== undefined) {
      if (spotifyClientSecret && !safeStorage.isEncryptionAvailable()) throw new Error('Hệ điều hành chưa hỗ trợ kho khóa an toàn. Hãy dùng biến môi trường SPOTIFY_CLIENT_SECRET.');
      encrypted = spotifyClientSecret ? safeStorage.encryptString(spotifyClientSecret).toString('base64') : undefined;
    }
    if (publicPatch.downloadDirectory) await fs.mkdir(publicPatch.downloadDirectory, { recursive: true });
    if (publicPatch.libraryDirectory !== undefined) {
      const directory = publicPatch.libraryDirectory;
      const defaultRoot = path.join(app.getPath('music'), 'Luma', 'Library');
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || samePath(directory, app.getPath('userData')) || (!samePath(directory, defaultRoot) && (inside(app.getPath('userData'), directory) || inside(app.getAppPath(), directory) || samePath(directory, app.getAppPath())))) throw new Error('Chọn thư mục nhạc riêng, bên ngoài hồ sơ và thư mục ứng dụng Luma.');
      publicPatch.libraryDirectory = await libraryRoot(directory);
    }
    await this.commit(next => {
      next.settings = { ...next.settings, ...publicPatch, ...(spotifyClientSecret === undefined ? {} : { encryptedSpotifySecret: encrypted }) };
    });
    return this.publicSettings();
  }

  async addFile(filePath: string, source: TrackSource = 'local', sourceUrl?: string, spotifyUrl?: string): Promise<Track> {
    const absolute = await fs.realpath(filePath);
    const extension = path.extname(absolute).toLowerCase();
    if (!['.flac', '.m4a'].includes(extension)) throw new Error('Chỉ hỗ trợ file .flac và .m4a (AAC / ALAC).');
    const known = this.state.tracks.find(track => samePath(track.path, absolute) || Boolean(track.originalPath && samePath(track.originalPath, absolute)));
    if (known) return { ...known };
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('Đường dẫn không phải file âm thanh.');
    const handle = await fs.open(absolute, 'r');
    try {
      const signature = Buffer.alloc(16);
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      if (extension === '.flac' && signature.toString('ascii', 0, 4) !== 'fLaC') throw new Error(`File ${path.basename(absolute)} không có dữ liệu FLAC hợp lệ.`);
      if (extension === '.m4a' && (bytesRead < 16 || signature.toString('ascii', 4, 8) !== 'ftyp' || signature.readUInt32BE(0) < 16 || signature.readUInt32BE(0) > stat.size))
        throw new Error(`File ${path.basename(absolute)} không có container M4A hợp lệ.`);
    } finally { await handle.close(); }
    const metadata = await parseFile(absolute, { duration: true, skipCovers: false });
    const { common, format } = metadata;
    const audio = extension === '.m4a' ? await probeM4a(absolute, resolveToolPath('ffprobe', 'bundled', this.toolDirectory, process.env.FFPROBE_PATH)) : undefined;
    const m4aCodec = audio?.codec;
    const picture = common.picture?.find(item => ['image/jpeg', 'image/png', 'image/webp'].includes(item.format) && item.data.length <= 5 * 1024 * 1024);
    const track: Track = {
      id: randomUUID(), path: absolute,
      title: common.title || path.basename(absolute, path.extname(absolute)),
      artist: common.artist || 'Nghệ sĩ chưa xác định', album: cleanLabel(common.album || '', UNKNOWN_ALBUM),
      albumArtist: common.album ? cleanLabel(common.albumartist || (common.compilation ? 'Various Artists' : common.artist || '')) : '',
      duration: audio?.duration ?? format.duration ?? 0, sampleRate: audio?.sampleRate ?? format.sampleRate ?? 0,
      bitsPerSample: audio?.bitsPerSample ?? format.bitsPerSample ?? 0, channels: audio?.channels ?? format.numberOfChannels ?? 0,
      addedAt: new Date().toISOString(), source, sourceUrl, spotifyUrl,
      container: extension === '.m4a' ? 'M4A' : 'FLAC', codec: m4aCodec || 'FLAC',
      lossless: extension === '.flac' || m4aCodec === 'ALAC', bitrate: audio?.bitrate ?? format.bitrate ?? undefined,
      coverDataUrl: picture ? `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}` : undefined,
    };
    let created: string | undefined;
    try { return await this.commit(async next => {
      // Recheck inside the transaction after asynchronous metadata parsing.
      const concurrent = next.tracks.find(item => samePath(item.path, absolute) || Boolean(item.originalPath && samePath(item.originalPath, absolute)));
      if (concurrent) return { ...concurrent };
      const album = this.ensureAlbum(next, track.album, track.albumArtist || '');
      const root = await libraryRoot(next.settings.libraryDirectory);
      const directory = await albumDirectory(root, album.folder, album.id);
      const destination = path.join(directory, `${safeStem(track.title, 'Track')}--${track.id}${extension}`);
      const copied = await copyVerified(absolute, destination, stat);
      if (copied.created) created = destination;
      const managed: Track = { ...track, path: destination, originalPath: absolute, managed: true, albumId: album.id, album: album.name, albumArtist: album.artist };
      next.tracks.push(managed);
      return { ...managed };
    }); } catch (error) { if (created) await fs.unlink(created).catch(() => undefined); throw error; }
  }

  async remove(id: string): Promise<void> {
    await this.commit(next => { next.tracks = next.tracks.filter(track => track.id !== id); });
  }

  private commit<T>(change: (next: DiskState) => T | Promise<T>): Promise<T> {
    // Serialize both the state mutation and the durable write. A failed write
    // must not leak into a later operation's snapshot or into the UI.
    const write = this.pendingWrite.catch(() => undefined).then(async () => {
      const next: DiskState = { version: 1, tracks: this.state.tracks.map(track => ({ ...track })), settings: { ...this.state.settings }, albums: this.state.albums.map(album => ({ ...album })), retiredCopies: this.state.retiredCopies.map(copy => ({ ...copy })) };
      const result = await change(next);
      const json = JSON.stringify(next, null, 2);
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, json, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, this.filePath);
      } finally { await fs.unlink(temporary).catch(() => undefined); }
      this.state = next;
      return result;
    });
    this.pendingWrite = write.then(() => undefined, () => undefined);
    return write;
  }
}
