import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export interface GoogleCryptoStore { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export interface GoogleAuthOptions {
  userDataDirectory: string;
  client: () => { id: string; secret?: string };
  openExternal: (url: string) => Promise<void>;
  cryptoStore?: GoogleCryptoStore;
  fetch?: typeof fetch;
  serverFactory?: typeof createServer;
  timeoutMs?: number;
}
interface GoogleTokens { clientId: string; accessToken: string; refreshToken: string; expiresAt: number }
export function validGoogleClientId(value: string): boolean { return /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(value) && value.length <= 300; }
export function validGoogleState(received: string | null, expected: string): boolean {
  if (!received) return false; const left = Buffer.from(received); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Installed/Desktop OAuth only. Android must use its own supported Google sign-in flow. */
export class GoogleAuth {
  private tokens?: GoogleTokens;
  private generation = 0;
  private refresh?: Promise<string>;
  private pending?: { cancel: (error: Error) => void };
  private writes: Promise<void> = Promise.resolve();
  private readonly crypto: GoogleCryptoStore;
  private readonly filename: string;
  constructor(private readonly options: GoogleAuthOptions) {
    this.crypto = options.cryptoStore || safeStorage;
    this.filename = path.join(options.userDataDirectory, 'google-drive-tokens.enc');
  }
  get connected(): boolean { return Boolean(this.tokens?.refreshToken && this.tokens.clientId === this.options.client().id); }
  get connecting(): boolean { return Boolean(this.pending); }
  async initialize(): Promise<void> {
    try {
      if (!this.crypto.isEncryptionAvailable()) return;
      const tokens = JSON.parse(this.crypto.decryptString(await fs.readFile(this.filename))) as GoogleTokens;
      if (typeof tokens.clientId === 'string' && typeof tokens.accessToken === 'string' && typeof tokens.refreshToken === 'string' && Number.isFinite(tokens.expiresAt)) this.tokens = tokens;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Google Drive session unavailable; reconnect in Settings.'); }
  }
  cancelConnect(): void { this.pending?.cancel(new Error('Đã hủy kết nối Google Drive.')); }
  async disconnect(): Promise<void> {
    this.cancelConnect(); this.generation++; this.tokens = undefined;
    const write = this.writes.then(() => fs.unlink(this.filename).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }));
    this.writes = write.catch(() => undefined); await write;
  }
  private save(tokens: GoogleTokens, generation: number): Promise<void> {
    const write = this.writes.then(async () => {
      if (!this.crypto.isEncryptionAvailable()) throw new Error('Kho khóa an toàn không khả dụng. Không thể lưu phiên Google.');
      if (generation !== this.generation || tokens.clientId !== this.options.client().id) throw new Error('Phiên Google đã thay đổi.');
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, this.crypto.encryptString(JSON.stringify(tokens)), { mode: 0o600 });
        if (generation !== this.generation || tokens.clientId !== this.options.client().id) throw new Error('Phiên Google đã thay đổi.');
        await fs.rename(temporary, this.filename);
        if (generation !== this.generation || tokens.clientId !== this.options.client().id) { await fs.unlink(this.filename).catch(() => undefined); throw new Error('Phiên Google đã thay đổi.'); }
        this.tokens = tokens;
      } finally { await fs.unlink(temporary).catch(() => undefined); }
    });
    this.writes = write.catch(() => undefined); return write;
  }
  connect(): Promise<void> {
    if (this.pending) return Promise.reject(new Error('Đang chờ đăng nhập Google.'));
    const clientId = this.options.client().id;
    if (!validGoogleClientId(clientId)) return Promise.reject(new Error('Nhập OAuth Client ID loại Desktop app trong mục Google Drive trước.'));
    if (!this.crypto.isEncryptionAvailable()) return Promise.reject(new Error('Kho khóa an toàn chưa sẵn sàng; không thể kết nối Google.'));
    const verifier = randomBytes(64).toString('base64url'); const state = randomBytes(32).toString('base64url');
    const controller = new AbortController(); const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      let server: Server; let timer: ReturnType<typeof setTimeout>; let finished = false; let exchanging = false; let redirect = '';
      const finish = (error?: Error) => {
        if (finished) return; finished = true; clearTimeout(timer); this.pending = undefined; server?.close();
        if (error) { this.generation++; controller.abort(); reject(error); } else resolve();
      };
      this.pending = { cancel: finish };
      server = (this.options.serverFactory || createServer)((request, response) => {
        const respond = (status: number, text: string) => {
          response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
          response.end(`<!doctype html><meta charset="utf-8"><title>Luma · Google Drive</title><body style="font:18px system-ui;padding:48px">${text}</body>`);
        };
        let url: URL;
        try { if (!redirect || (request.url?.length || 0) > 8192) throw new Error(); url = new URL(request.url || '/', redirect); }
        catch { respond(400, 'Đường dẫn không hợp lệ.'); return; }
        const expected = new URL(redirect);
        if (request.method !== 'GET' || url.origin !== expected.origin || request.headers.host !== expected.host || url.pathname !== '/callback') { respond(404, 'Không tìm thấy trang.'); return; }
        if (!validGoogleState(url.searchParams.get('state'), state)) { respond(400, 'Mã xác thực không hợp lệ. Quay lại Luma.'); return; }
        if (finished || exchanging) { respond(409, 'Yêu cầu đã được xử lý.'); return; }
        if (url.searchParams.has('error')) { respond(400, 'Bạn đã hủy cấp quyền. Có thể đóng trang này.'); finish(new Error('Google chưa cấp quyền Google Drive cho Luma.')); return; }
        const code = url.searchParams.get('code'); if (!code || code.length > 4096) { respond(400, 'Thiếu mã đăng nhập.'); return; }
        exchanging = true;
        void this.exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: verifier }), clientId, undefined, controller.signal).then(async tokens => {
          if (finished) return;
          await this.save(tokens, generation); if (finished) return;
          respond(200, 'Đã kết nối Google Drive. Bạn có thể đóng trang này và trở lại Luma.'); finish();
        }).catch(error => { if (!response.writableEnded) respond(400, 'Không kết nối được Google. Xem thông báo trong Luma.'); finish(error instanceof Error ? error : new Error('Google OAuth thất bại.')); });
      });
      server.on('error', () => finish(new Error('Không mở được callback Google trên máy. Thử kết nối lại.')));
      timer = setTimeout(() => finish(new Error('Đã hết 3 phút chờ Google. Hãy kết nối lại.')), this.options.timeoutMs ?? 180_000);
      server.listen(0, '127.0.0.1', () => {
        if (finished) return;
        const address = server.address(); if (!address || typeof address === 'string') { finish(new Error('Callback Google không hợp lệ.')); return; }
        redirect = `http://127.0.0.1:${address.port}/callback`;
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: GOOGLE_DRIVE_SCOPE, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }).toString();
        void this.options.openExternal(url.toString()).catch(() => finish(new Error('Không mở được trình duyệt đăng nhập Google.')));
      });
    });
  }
  private async exchange(body: URLSearchParams, clientId: string, previous?: GoogleTokens, signal?: AbortSignal): Promise<GoogleTokens> {
    const secret = this.options.client().secret; if (secret) body.set('client_secret', secret);
    const response = await (this.options.fetch || fetch)('https://oauth2.googleapis.com/token', { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Google đang giới hạn yêu cầu. Thử lại sau.' : 'Google từ chối phiên đăng nhập. Kiểm tra Desktop Client ID/Client Secret, người dùng thử nghiệm và bật Google Drive API rồi kết nối lại.');
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.access_token !== 'string' || !data.access_token || !(typeof data.refresh_token === 'string' && data.refresh_token || previous?.refreshToken)) throw new Error('Google chưa cấp phiên truy cập offline. Kết nối lại và chấp nhận quyền Drive.');
    if (typeof data.scope === 'string' && !data.scope.split(' ').includes(GOOGLE_DRIVE_SCOPE)) throw new Error('Google chưa cấp quyền drive.file cần thiết.');
    return { clientId, accessToken: data.access_token, refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : previous!.refreshToken, expiresAt: Date.now() + Math.max(30, Number(data.expires_in) || 3600) * 1000 };
  }
  async accessToken(force = false, signal?: AbortSignal): Promise<string> {
    if (!this.connected || !this.tokens) throw new Error('Kết nối Google Drive trước khi đồng bộ.');
    if (!force && this.tokens.expiresAt > Date.now() + 60_000) return this.tokens.accessToken;
    if (this.refresh) return this.refresh;
    const previous = this.tokens; const generation = this.generation;
    this.refresh = this.exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: previous.refreshToken, client_id: previous.clientId }), previous.clientId, previous, signal).then(async tokens => {
      if (this.tokens !== previous || !this.connected) throw new Error('Phiên Google đã thay đổi.');
      await this.save(tokens, generation); return tokens.accessToken;
    }).finally(() => { this.refresh = undefined; });
    return this.refresh;
  }
}
