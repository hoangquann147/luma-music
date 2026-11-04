import { safeStorage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import type { DriveConfig, DriveConfigUpdate, DriveStatus } from '../../shared/drive-types';
import { GoogleAuth, type GoogleCryptoStore, validGoogleClientId } from './google-auth';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const CHUNK = 8 * 1024 * 1024;
const MAX_TRACK_BYTES = 2 * 1024 * 1024 * 1024;
interface RemoteFile { id: string; name?: string; md5Checksum?: string; size?: string; parents?: string[]; properties?: Record<string, string>; trashed?: boolean; mimeType?: string; etag?: string }
interface CacheEntry { size: number; mtime: number; md5: string; sha256: string; remoteId: string }
interface AuthPort { readonly connected: boolean; readonly connecting: boolean; initialize(): Promise<void>; connect(): Promise<void>; cancelConnect(): void; disconnect(): Promise<void>; accessToken(force?: boolean, signal?: AbortSignal): Promise<string> }
export interface DriveSyncOptions {
  userDataDirectory: string;
  defaultSourceDirectory: string;
  openExternal: (url: string) => Promise<void>;
  onStatus: (status: DriveStatus) => void;
  cryptoStore?: GoogleCryptoStore;
  fetch?: typeof fetch;
  auth?: AuthPort;
  pollIntervalMs?: number;
}
export function driveTrackId(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').normalize('NFC');
  return createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex');
}
export function driveProperty(key: string, value: string): string {
  let result = ''; const budget = 124 - Buffer.byteLength(key, 'utf8');
  for (const point of value.replace(/[\u0000-\u001f\u007f]/g, ' ')) { if (Buffer.byteLength(result + point, 'utf8') > budget) break; result += point; }
  return result;
}
export function resumableOffset(range: string | null, total: number): number {
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range); const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new Error('Drive trả về vị trí upload không hợp lệ.');
  return offset;
}
function abortError(): Error { return new Error('Đã dừng đồng bộ Google Drive.'); }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
  });
}
const idValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{3,200}$/.test(value);

/** One-way, app-managed PC → Drive synchronization. Never deletes remote files. */
export class DriveSyncService {
  private config: DriveConfig;
  private secret?: string;
  private readonly crypto: GoogleCryptoStore;
  private readonly auth: AuthPort;
  private readonly directory: string;
  private cache: Record<string, CacheEntry> = {};
  private generation = 0;
  private controller?: AbortController;
  private running?: Promise<DriveStatus>;
  private timer?: ReturnType<typeof setInterval>;
  private closing = false;
  private mutations: Promise<void> = Promise.resolve();
  private state: Omit<DriveStatus, 'config' | 'connected' | 'connecting'> = { phase: 'idle', filesTotal: 0, filesDone: 0, uploaded: 0, skipped: 0, failed: 0, bytesUploaded: 0, bytesTotal: 0, progress: 0 };
  constructor(private readonly options: DriveSyncOptions) {
    this.directory = options.userDataDirectory; this.crypto = options.cryptoStore || safeStorage;
    this.config = { desktopClientId: '', secretConfigured: false, sourceDirectory: options.defaultSourceDirectory, autoSync: true };
    this.auth = options.auth || new GoogleAuth({ userDataDirectory: this.directory, client: () => ({ id: this.config.desktopClientId, secret: this.secret }), openExternal: options.openExternal, cryptoStore: this.crypto, fetch: options.fetch });
  }
  status(): DriveStatus { return structuredClone({ ...this.state, config: this.config, connected: this.auth.connected, connecting: this.auth.connecting }); }
  private emit(patch: Partial<typeof this.state> = {}): void { Object.assign(this.state, patch); this.options.onStatus(this.status()); }
  private async atomic(filename: string, contents: string | Buffer): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, filename); const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, contents, { mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.unlink(temporary).catch(() => undefined); }
  }
  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.directory, 'drive-config.json'), 'utf8')) as Record<string, unknown>;
      if (raw.version !== 1 || typeof raw.desktopClientId !== 'string' || typeof raw.sourceDirectory !== 'string' || typeof raw.autoSync !== 'boolean') throw new Error('Cấu hình Drive không hợp lệ.');
      if (raw.desktopClientId && !validGoogleClientId(raw.desktopClientId) || !path.isAbsolute(raw.sourceDirectory)) throw new Error('Cấu hình Drive không hợp lệ.');
      this.config = { desktopClientId: raw.desktopClientId, sourceDirectory: raw.sourceDirectory, autoSync: raw.autoSync, secretConfigured: false };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Không đọc được cấu hình Google Drive. Hồ sơ hiện tại chưa bị thay đổi.'); }
    try {
      if (this.crypto.isEncryptionAvailable()) {
        const credentials = JSON.parse(this.crypto.decryptString(await fs.readFile(path.join(this.directory, 'google-drive-credentials.enc')))) as { clientId: string; secret: string };
        if (credentials.clientId === this.config.desktopClientId && typeof credentials.secret === 'string') this.secret = credentials.secret;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Google client secret could not be restored.'); }
    this.config.secretConfigured = Boolean(this.secret);
    try { const cached = JSON.parse(await fs.readFile(path.join(this.directory, 'drive-sync-index.json'), 'utf8')) as { version: number; entries: Record<string, CacheEntry> }; if (cached.version === 1 && cached.entries && typeof cached.entries === 'object') this.cache = cached.entries; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Drive sync index will be rebuilt.'); }
    await this.auth.initialize(); this.schedule(); this.emit();
  }
  saveConfig(update: DriveConfigUpdate): Promise<DriveStatus> {
    const operation = this.mutations.then(async () => {
      if (this.closing) throw new Error('Ứng dụng đang đóng.');
      if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('Cấu hình Google Drive không hợp lệ.');
      const next = { ...this.config };
      if (update.desktopClientId !== undefined) {
        if (typeof update.desktopClientId !== 'string') throw new Error('Google Client ID không hợp lệ.');
        next.desktopClientId = update.desktopClientId.trim(); if (next.desktopClientId && !validGoogleClientId(next.desktopClientId)) throw new Error('Dùng OAuth Client ID loại Desktop app, có đuôi .apps.googleusercontent.com.');
      }
      if (update.sourceDirectory !== undefined) {
        if (typeof update.sourceDirectory !== 'string' || update.sourceDirectory.includes('\0') || !path.isAbsolute(update.sourceDirectory)) throw new Error('Thư mục đồng bộ phải là đường dẫn tuyệt đối.');
        if (!(await fs.stat(update.sourceDirectory)).isDirectory()) throw new Error('Thư mục đồng bộ không hợp lệ.'); next.sourceDirectory = update.sourceDirectory;
      }
      if (update.autoSync !== undefined) { if (typeof update.autoSync !== 'boolean') throw new Error('Cài đặt tự đồng bộ không hợp lệ.'); next.autoSync = update.autoSync; }
      if (update.desktopClientSecret !== undefined && (typeof update.desktopClientSecret !== 'string' || update.desktopClientSecret.length > 4096 || /[\u0000-\u001f]/.test(update.desktopClientSecret))) throw new Error('Google Client Secret không hợp lệ.');
      const changedClient = next.desktopClientId !== this.config.desktopClientId;
      const secret = update.desktopClientSecret === undefined ? changedClient ? undefined : this.secret : update.desktopClientSecret.trim() || undefined;
      if (secret && !this.crypto.isEncryptionAvailable()) throw new Error('Không có kho khóa an toàn để lưu Google Client Secret.');
      this.cancelConnect(); this.cancelSync(); if (this.running) await this.running;
      if (changedClient) await this.auth.disconnect();
      if (secret) await this.atomic('google-drive-credentials.enc', this.crypto.encryptString(JSON.stringify({ clientId: next.desktopClientId, secret })));
      else await fs.unlink(path.join(this.directory, 'google-drive-credentials.enc')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      await this.atomic('drive-config.json', JSON.stringify({ version: 1, desktopClientId: next.desktopClientId, sourceDirectory: next.sourceDirectory, autoSync: next.autoSync }, null, 2));
      this.secret = secret; this.config = { ...next, secretConfigured: Boolean(secret) }; this.schedule(); this.emit({ phase: 'idle', message: 'Đã lưu cài đặt Google Drive.' }); return this.status();
    });
    this.mutations = operation.then(() => undefined, () => undefined); return operation;
  }
  async connect(): Promise<DriveStatus> {
    if (this.closing) throw new Error('Ứng dụng đang đóng.');
    const generation = this.generation;
    try { const authorization = this.auth.connect(); this.emit({ phase: 'connecting', message: 'Hoàn tất đăng nhập Google trong trình duyệt.' }); await authorization; if (generation !== this.generation || this.closing) throw abortError(); this.schedule(); this.emit({ phase: 'idle', message: 'Đã kết nối Google Drive.' }); if (this.config.autoSync) void this.syncNow().catch(() => undefined); return this.status(); }
    catch (error) { if (generation === this.generation && !this.closing) this.emit({ phase: 'error', message: (error as Error).message }); throw error; }
  }
  cancelConnect(): void { if (this.auth.connecting) { this.generation++; this.auth.cancelConnect(); this.emit({ phase: 'idle', message: 'Đã hủy kết nối Google Drive.' }); } }
  async disconnect(): Promise<DriveStatus> {
    this.cancelSync(); this.stopTimer(); await this.auth.disconnect(); if (this.running) await this.running;
    this.emit({ phase: 'idle', folderId: undefined, message: 'Đã ngắt kết nối Google Drive trên máy này.' }); return this.status();
  }
  cancelSync(): DriveStatus { this.generation++; this.controller?.abort(); this.emit({ phase: 'idle', message: 'Đã dừng đồng bộ Google Drive.' }); return this.status(); }
  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private schedule(): void {
    this.stopTimer(); if (!this.closing && this.config.autoSync && this.auth.connected) {
      this.timer = setInterval(() => { if (!this.running) void this.syncNow().catch(() => undefined); }, this.options.pollIntervalMs ?? 120_000); this.timer.unref?.();
    }
  }
  syncNow(): Promise<DriveStatus> {
    if (this.running) return this.running;
    if (this.closing || !this.auth.connected) return Promise.reject(new Error('Kết nối Google Drive trước khi đồng bộ.'));
    const controller = new AbortController(); const generation = ++this.generation; this.controller = controller;
    const run = this.sync(controller.signal, generation).finally(() => { if (this.running === run) this.running = undefined; if (this.controller === controller) this.controller = undefined; });
    this.running = run; return run;
  }
  private check(signal: AbortSignal, generation: number): void { if (signal.aborted || generation !== this.generation || !this.auth.connected || this.closing) throw abortError(); }
  private async request(url: string, init: RequestInit, signal: AbortSignal, makeBody?: () => NodeJS.ReadableStream): Promise<Response> {
    for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
      const token = await this.auth.accessToken(authAttempt === 1, signal);
      if (signal.aborted) throw abortError();
      const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`);
      const body = makeBody?.();
      try {
        const response = await (this.options.fetch || fetch)(url, { ...init, headers, body: body || init.body, ...(body ? { duplex: 'half' } : {}), redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) } as RequestInit);
        if (response.status !== 401 || authAttempt === 1) return response;
        await response.body?.cancel();
      } finally { (body as { destroy?: () => void } | undefined)?.destroy?.(); }
    }
    throw new Error('Phiên Google không hợp lệ. Kết nối lại.');
  }
  private async json(url: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.retryRequest(url, init, signal);
    if (!response.ok) throw new Error(response.status === 403 ? 'Drive từ chối truy cập. Bật Google Drive API, cấp quyền drive.file và kiểm tra dung lượng Google còn trống.' : `Google Drive HTTP ${response.status}.`);
    return await response.json() as Record<string, unknown>;
  }
  private async retryable(response: Response): Promise<boolean> {
    if (response.status === 429 || response.status >= 500) return true;
    if (response.status !== 403) return false;
    try { const body = await response.clone().json() as { error?: { errors?: { reason?: string }[] } }; return Boolean(body.error?.errors?.some(error => ['rateLimitExceeded', 'userRateLimitExceeded', 'backendError'].includes(error.reason || ''))); }
    catch { return false; }
  }
  private async retryRequest(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try { response = await this.request(url, init, signal); }
      catch (error) { if (signal.aborted) throw abortError(); if (attempt === 3) throw error; await delay(500 * 2 ** attempt, signal); continue; }
      if (!(await this.retryable(response)) || attempt === 3) return response;
      await response.body?.cancel(); await delay(500 * 2 ** attempt, signal);
    }
    throw new Error('Google Drive chưa phản hồi.');
  }
  private async list(query: string, signal: AbortSignal): Promise<RemoteFile[]> {
    const files: RemoteFile[] = []; const seen = new Set<string>(); let page = '';
    do {
      if (seen.has(page)) throw new Error('Drive trả về phân trang lặp.'); seen.add(page);
      const params = new URLSearchParams({ q: query, spaces: 'drive', pageSize: '1000', fields: 'nextPageToken,files(id,name,mimeType,md5Checksum,size,parents,properties,trashed)', orderBy: 'createdTime' }); if (page) params.set('pageToken', page);
      const data = await this.json(`${API}/files?${params}`, {}, signal);
      if (!Array.isArray(data.files)) throw new Error('Danh sách Google Drive không hợp lệ.');
      for (const item of data.files) if (item && typeof item === 'object' && idValid((item as RemoteFile).id)) files.push(item as RemoteFile);
      if (files.length > 100_000) throw new Error('Thư mục Drive vượt giới hạn 100.000 file.');
      page = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
    } while (page);
    return files;
  }
  private async newId(signal: AbortSignal): Promise<string> {
    const data = await this.json(`${API}/files/generateIds?count=1&space=drive&type=files`, {}, signal);
    const id = Array.isArray(data.ids) ? data.ids[0] : undefined; if (!idValid(id)) throw new Error('Drive không cấp mã file hợp lệ.'); return id;
  }
  private async folder(signal: AbortSignal): Promise<string> {
    const existing = await this.list("trashed=false and mimeType='application/vnd.google-apps.folder' and properties has { key='lumaSyncRoot' and value='v1' }", signal);
    if (existing.length) return existing[0].id;
    const id = await this.newId(signal);
    const response = await this.retryRequest(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: 'Luma Music', mimeType: 'application/vnd.google-apps.folder', properties: { lumaSyncRoot: 'v1' } }) }, signal);
    if (response.status === 409) { const previous = await this.remote(id, signal); if (previous?.mimeType === 'application/vnd.google-apps.folder' && previous.properties?.lumaSyncRoot === 'v1') return id; }
    if (!response.ok) throw new Error(`Không tạo được thư mục Luma trên Drive (HTTP ${response.status}).`);
    const created = await response.json() as { id?: unknown };
    if (!idValid(created.id)) throw new Error('Không tạo được thư mục Luma trên Drive.'); return created.id;
  }
  private async scan(root: string, signal: AbortSignal): Promise<{ filename: string; relative: string; size: number; mtime: number }[]> {
    const base = await fs.realpath(root); const result: { filename: string; relative: string; size: number; mtime: number }[] = [];
    const walk = async (directory: string): Promise<void> => {
      if (signal.aborted) throw abortError();
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(filename);
        else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.flac') {
          const stat = await fs.stat(filename); if (!stat.size || !Number.isSafeInteger(stat.size)) continue;
          result.push({ filename, relative: path.relative(base, filename), size: stat.size, mtime: stat.mtimeMs });
          if (result.length > 10_000) throw new Error('Thư mục nguồn vượt 10.000 file FLAC. Hãy chọn thư mục nhỏ hơn.');
        }
      }
    };
    await walk(base); return result.sort((a, b) => a.relative.localeCompare(b.relative));
  }
  private async hashes(filename: string, signal: AbortSignal): Promise<{ md5: string; sha256: string }> {
    const md5 = createHash('md5'); const sha256 = createHash('sha256');
    const stream = createReadStream(filename, { highWaterMark: 1024 * 1024, signal });
    for await (const chunk of stream) { md5.update(chunk); sha256.update(chunk); }
    return { md5: md5.digest('hex'), sha256: sha256.digest('hex') };
  }
  private async remote(id: string, signal: AbortSignal): Promise<RemoteFile | undefined> {
    const response = await this.request(`${API}/files/${encodeURIComponent(id)}?fields=id,name,md5Checksum,size,parents,properties,trashed,mimeType`, {}, signal);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Không kiểm tra được file Drive (HTTP ${response.status}).`);
    return { ...await response.json() as RemoteFile, etag: response.headers.get('etag') || undefined };
  }
  private async upload(filename: string, size: number, id: string, folder: string, properties: Record<string, string>, existing: RemoteFile | undefined, signal: AbortSignal, progress: (bytes: number) => void): Promise<RemoteFile> {
    const metadata = { ...(!existing ? { id, parents: [folder] } : {}), name: `${properties.lumaTrackId}.flac`, mimeType: 'audio/flac', properties };
    for (let restart = 0; restart < 2; restart++) {
      const start = await this.retryRequest(`${UPLOAD}${existing ? `/${encodeURIComponent(id)}` : ''}?uploadType=resumable&fields=id,md5Checksum,size,properties,parents`, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'audio/flac', 'X-Upload-Content-Length': String(size), ...(existing?.etag && !existing.etag.startsWith('W/') ? { 'If-Match': existing.etag } : {}) }, body: JSON.stringify(metadata) }, signal);
      if (start.status === 412) throw new Error('File trên Drive vừa thay đổi; chưa ghi đè. Đồng bộ lại để kiểm tra xung đột.');
      if (start.status === 409 && !existing) { const committed = await this.remote(id, signal); if (committed?.properties?.lumaTrackId === properties.lumaTrackId) return committed; }
      if (!start.ok) throw new Error(`Không khởi tạo được upload Drive (HTTP ${start.status}).`);
      let session: URL; try { session = new URL(start.headers.get('location') || ''); } catch { throw new Error('Drive chưa trả về phiên upload.'); }
      if (session.origin !== 'https://www.googleapis.com' || !session.pathname.startsWith('/upload/drive/v3/files') || session.username || session.password) throw new Error('Phiên upload Drive không hợp lệ.');
      let offset = 0; let failures = 0; let expired = false;
      while (offset < size) {
        const end = Math.min(size - 1, offset + CHUNK - 1); const before = offset;
        try {
          const response = await this.request(session.toString(), { method: 'PUT', headers: { 'Content-Type': 'audio/flac', 'Content-Length': String(end - offset + 1), 'Content-Range': `bytes ${offset}-${end}/${size}` } }, signal, () => createReadStream(filename, { start: before, end }));
          if (response.status === 200 || response.status === 201) { progress(size); return await response.json() as RemoteFile; }
          if (response.status === 308) { offset = resumableOffset(response.headers.get('range'), size); if (offset <= before && ++failures > 4) throw new Error('Drive không nhận thêm dữ liệu.'); progress(offset); continue; }
          if (response.status === 404) { expired = true; break; }
          if (!(await this.retryable(response))) throw new Error(`Upload Drive HTTP ${response.status}.`);
          await response.body?.cancel();
        } catch (error) { if (signal.aborted) throw abortError(); if (error instanceof Error && /HTTP 4\d\d/.test(error.message)) throw error; }
        if (++failures > 4) throw new Error('Upload Drive thất bại sau nhiều lần thử.');
        await delay(500 * 2 ** (failures - 1), signal);
        const status = await this.retryRequest(session.toString(), { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` }, body: '' }, signal);
        if (status.ok) { progress(size); return await status.json() as RemoteFile; }
        if (status.status === 404) { expired = true; break; }
        if (status.status !== 308) throw new Error(`Không khôi phục được upload (HTTP ${status.status}).`);
        offset = resumableOffset(status.headers.get('range'), size); progress(offset);
      }
      if (!expired) throw new Error('Drive kết thúc upload nhưng chưa xác nhận file.');
      const committed = await this.remote(id, signal); if (committed && committed.md5Checksum) return committed;
    }
    throw new Error('Phiên upload Drive đã hết hạn. Thử đồng bộ lại.');
  }
  private async sync(signal: AbortSignal, generation: number): Promise<DriveStatus> {
    this.emit({ phase: 'scanning', message: 'Đang quét thư mục FLAC…', filesTotal: 0, filesDone: 0, uploaded: 0, skipped: 0, failed: 0, bytesUploaded: 0, bytesTotal: 0, progress: 0 });
    try {
      const files = await this.scan(this.config.sourceDirectory, signal); this.check(signal, generation);
      this.emit({ filesTotal: files.length, bytesTotal: files.reduce((total, file) => total + file.size, 0) });
      const folder = await this.folder(signal); this.check(signal, generation); this.emit({ folderId: folder });
      const remotes = await this.list(`'${folder}' in parents and trashed=false and properties has { key='lumaSource' and value='desktop' }`, signal);
      const byTrack = new Map<string, RemoteFile>(); for (const remote of remotes) { const trackId = remote.properties?.lumaTrackId; if (trackId && !byTrack.has(trackId)) byTrack.set(trackId, remote); }
      let bytesDone = 0; let uploadedBytes = 0; let lastError = '';
      for (const file of files) {
        this.check(signal, generation); const trackId = driveTrackId(file.relative); const previous = this.cache[trackId];
        let acknowledged = 0;
        try {
          if (file.size > MAX_TRACK_BYTES) throw new Error('File vượt giới hạn 2 GiB của Luma Android; chưa tải lên.');
          const handle = await fs.open(file.filename, 'r');
          try { const signature = Buffer.alloc(4); await handle.read(signature, 0, 4, 0); if (signature.toString('ascii') !== 'fLaC') throw new Error('File không chứa dữ liệu FLAC hợp lệ.'); }
          finally { await handle.close(); }
          const local = previous?.size === file.size && previous.mtime === file.mtime ? { md5: previous.md5, sha256: previous.sha256 } : await this.hashes(file.filename, signal);
          this.check(signal, generation); const stable = await fs.stat(file.filename); if (stable.size !== file.size || stable.mtimeMs !== file.mtime) throw new Error('File đang thay đổi; sẽ thử lại ở lần đồng bộ sau.');
          let remote = byTrack.get(trackId); if (remote) remote = await this.remote(remote.id, signal);
          if (remote && (remote.trashed || !remote.parents?.includes(folder) || remote.properties?.lumaTrackId !== trackId || remote.properties?.lumaSource !== 'desktop')) throw new Error('File đích đã thay đổi quyền sở hữu thư mục; chưa ghi đè.');
          if (remote?.md5Checksum?.toLowerCase() === local.md5) {
            this.check(signal, generation); this.cache[trackId] = { ...local, size: file.size, mtime: file.mtime, remoteId: remote.id }; this.state.skipped++;
          } else {
            if (remote && (!previous || previous.remoteId !== remote.id || !remote.md5Checksum || previous.md5 !== remote.md5Checksum.toLowerCase())) throw new Error('File trên Drive đã thay đổi hoặc chưa có bản đối chiếu trên máy này; giữ nguyên bản Drive để tránh ghi đè.');
            const metadata = await parseFile(file.filename, { skipCovers: true });
            const properties: Record<string, string> = { lumaTrackId: trackId, lumaSource: 'desktop', lumaContentSha256: local.sha256, title: metadata.common.title || path.basename(file.filename, path.extname(file.filename)), artist: metadata.common.artist || '', album: metadata.common.album || '', duration: String(metadata.format.duration || 0) };
            for (const key of Object.keys(properties)) properties[key] = driveProperty(key, properties[key]);
            const id = remote?.id || await this.newId(signal); this.check(signal, generation);
            this.emit({ phase: 'uploading', message: `Đang tải lên: ${properties.title}` });
            const saved = await this.upload(file.filename, file.size, id, folder, properties, remote, signal, bytes => { acknowledged = bytes; if (!signal.aborted && generation === this.generation) this.emit({ bytesUploaded: uploadedBytes + bytes, progress: this.state.bytesTotal ? (bytesDone + bytes) / this.state.bytesTotal * 100 : 100 }); });
            this.check(signal, generation);
            if (!idValid(saved.id) || saved.md5Checksum?.toLowerCase() !== local.md5) throw new Error('Drive chưa xác nhận checksum đúng. Sẽ kiểm tra lại ở lần đồng bộ sau.');
            this.cache[trackId] = { ...local, size: file.size, mtime: file.mtime, remoteId: saved.id }; this.state.uploaded++;
          }
          this.check(signal, generation); await this.atomic('drive-sync-index.json', JSON.stringify({ version: 1, entries: this.cache }));
        } catch (error) { this.check(signal, generation); this.state.failed++; lastError = `${path.basename(file.filename)}: ${(error as Error).message}`; this.state.message = lastError; }
        uploadedBytes += acknowledged; bytesDone += file.size; this.emit({ filesDone: this.state.filesDone + 1, bytesUploaded: uploadedBytes, progress: this.state.bytesTotal ? bytesDone / this.state.bytesTotal * 100 : 100 });
      }
      this.check(signal, generation); this.emit({ phase: this.state.failed ? 'error' : 'idle', progress: 100, lastSyncAt: new Date().toISOString(), message: `Đồng bộ xong: ${this.state.uploaded} tải lên, ${this.state.skipped} đã có, ${this.state.failed} lỗi.${lastError ? ` Lỗi gần nhất: ${lastError}` : ''}` });
    } catch (error) { if (generation === this.generation && !signal.aborted) this.emit({ phase: 'error', message: (error as Error).message }); }
    return this.status();
  }
  async shutdown(): Promise<void> {
    this.closing = true; this.stopTimer(); this.auth.cancelConnect(); this.cancelSync(); if (this.running) await this.running; await this.mutations;
  }
}
