import { randomBytes, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { SpotifyAuthStatus } from '../../shared/types';

export const SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:43827/callback';
export const SPOTIFY_SCOPES = 'playlist-read-private playlist-read-collaborative';
interface Tokens { clientId: string; accessToken: string; refreshToken: string; expiresAt: number; displayName?: string }
interface CryptoStore { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
interface AuthOptions {
  userDataDirectory: string;
  clientId: () => string;
  openExternal: (url: string) => Promise<void>;
  cryptoStore?: CryptoStore;
  serverFactory?: typeof createServer;
  timeoutMs?: number;
}
export function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url') };
}
export function validOAuthState(received: string | null, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Tokens never leave the main process; only status is exposed through IPC. */
export class SpotifyAuth {
  private tokens?: Tokens;
  private refresh?: Promise<string>;
  private pending?: { cancel: (error: Error) => void };
  private generation = 0;
  private fileMutation: Promise<void> = Promise.resolve();
  private readonly crypto: CryptoStore;
  private readonly tokenPath: string;
  constructor(private readonly options: AuthOptions) {
    this.crypto = options.cryptoStore || safeStorage;
    this.tokenPath = path.join(options.userDataDirectory, 'spotify-session.enc');
  }
  async initialize(): Promise<void> {
    try {
      if (!this.crypto.isEncryptionAvailable()) return;
      const value = JSON.parse(this.crypto.decryptString(await fs.readFile(this.tokenPath))) as Tokens;
      if (typeof value.clientId === 'string' && typeof value.accessToken === 'string' && typeof value.refreshToken === 'string' && Number.isFinite(value.expiresAt)) this.tokens = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Spotify session could not be restored; reconnect in Settings.'); }
  }
  status(): SpotifyAuthStatus {
    return { connected: Boolean(this.tokens?.refreshToken && this.tokens.clientId === this.options.clientId().trim()), redirectUri: SPOTIFY_REDIRECT_URI, displayName: this.tokens?.clientId === this.options.clientId().trim() ? this.tokens.displayName : undefined };
  }
  cancelConnect(): void { this.pending?.cancel(new Error('Đã hủy kết nối Spotify.')); }
  async disconnect(): Promise<SpotifyAuthStatus> {
    this.cancelConnect(); this.generation++; this.tokens = undefined;
    const operation = this.fileMutation.then(() => fs.unlink(this.tokenPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }));
    this.fileMutation = operation.catch(() => undefined); await operation;
    return this.status();
  }
  private async save(tokens: Tokens, generation: number): Promise<void> {
    const operation = this.fileMutation.then(() => this.writeTokens(tokens, generation));
    this.fileMutation = operation.catch(() => undefined); return operation;
  }
  private async writeTokens(tokens: Tokens, generation: number): Promise<void> {
    if (!this.crypto.isEncryptionAvailable()) throw new Error('Kho khóa an toàn của Windows chưa sẵn sàng; không thể lưu phiên Spotify.');
    await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
    const temporary = `${this.tokenPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, this.crypto.encryptString(JSON.stringify(tokens)), { mode: 0o600 });
      if (generation !== this.generation || tokens.clientId !== this.options.clientId().trim()) throw new Error('Phiên kết nối Spotify đã thay đổi.');
      await fs.rename(temporary, this.tokenPath);
      if (generation !== this.generation || tokens.clientId !== this.options.clientId().trim()) { await fs.unlink(this.tokenPath).catch(() => undefined); throw new Error('Phiên kết nối Spotify đã thay đổi.'); }
      this.tokens = tokens;
    }
    finally { await fs.unlink(temporary).catch(() => undefined); }
  }
  connect(): Promise<SpotifyAuthStatus> {
    if (this.pending) return Promise.reject(new Error('Đang chờ đăng nhập Spotify. Hãy hoàn tất hoặc hủy kết nối trước.'));
    const clientId = this.options.clientId().trim();
    if (!/^[A-Za-z0-9]{16,128}$/.test(clientId)) return Promise.reject(new Error('Lưu Spotify Client ID hợp lệ trong Settings trước khi kết nối.'));
    if (!this.crypto.isEncryptionAvailable()) return Promise.reject(new Error('Kho khóa an toàn chưa sẵn sàng; không thể kết nối Spotify.'));
    const pkce = createPkce(); const controller = new AbortController(); const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      let server: Server; let timer: ReturnType<typeof setTimeout>; let finished = false; let exchanging = false;
      const finish = (error?: Error) => {
        if (finished) return; finished = true; clearTimeout(timer); this.pending = undefined;
        server?.close(); if (error) { this.generation++; controller.abort(); reject(error); } else resolve(this.status());
      };
      this.pending = { cancel: finish };
      const respond = (response: ServerResponse, status: number, message: string) => {
        response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(`<!doctype html><meta charset="utf-8"><title>Luma · Spotify</title><body style="font:18px system-ui;padding:48px;background:#f7f8fd;color:#28384c">${message}</body>`);
      };
      const callback = (request: IncomingMessage, response: ServerResponse) => {
        let url: URL;
        try {
          if ((request.url?.length || 0) > 8192) throw new Error('Request too long');
          url = new URL(request.url || '/', SPOTIFY_REDIRECT_URI);
        } catch { respond(response, 400, 'Đường dẫn callback không hợp lệ.'); return; }
        if (request.method !== 'GET' || url.origin !== 'http://127.0.0.1:43827' || url.pathname !== '/callback' || request.headers.host !== '127.0.0.1:43827') { respond(response, 404, 'Không tìm thấy trang.'); return; }
        if (!validOAuthState(url.searchParams.get('state'), pkce.state)) { respond(response, 400, 'Mã xác thực không hợp lệ. Hãy quay lại Luma.'); return; }
        if (finished || exchanging) { respond(response, 409, 'Yêu cầu đã được xử lý.'); return; }
        if (url.searchParams.has('error')) { respond(response, 400, 'Bạn đã từ chối kết nối. Có thể đóng trang này.'); finish(new Error('Spotify không cấp quyền. Hãy kết nối lại và cho phép đọc playlist.')); return; }
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096) { respond(response, 400, 'Thiếu mã xác thực Spotify.'); return; }
        exchanging = true;
        void this.exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: SPOTIFY_REDIRECT_URI, code_verifier: pkce.verifier }), clientId, undefined, controller.signal).then(async tokens => {
          if (finished) return;
          try {
            const profile = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
            if (profile.ok) { const data = await profile.json() as { display_name?: unknown }; if (typeof data.display_name === 'string') tokens.displayName = data.display_name.slice(0, 200); }
          } catch { /* A display name is optional; no additional profile scope. */ }
          if (finished) return;
          await this.save(tokens, generation);
          if (finished) return;
          respond(response, 200, 'Đã kết nối Spotify với Luma. Bạn có thể đóng trang này và trở lại ứng dụng.'); finish();
        }).catch(error => { if (!response.writableEnded) respond(response, 400, 'Không kết nối được Spotify. Xem thông báo trong Luma.'); finish(error instanceof Error ? error : new Error(String(error))); });
      };
      server = (this.options.serverFactory || createServer)(callback);
      server.on('error', error => finish(new Error((error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'Cổng 43827 đang được sử dụng. Đóng phiên kết nối khác rồi thử lại.' : `Không mở được callback Spotify: ${error.message}`)));
      timer = setTimeout(() => finish(new Error('Đã hết 3 phút chờ Spotify. Hãy kết nối lại.')), this.options.timeoutMs ?? 180_000);
      server.listen(43827, '127.0.0.1', () => {
        if (finished) return;
        const url = new URL('https://accounts.spotify.com/authorize');
        url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: SPOTIFY_REDIRECT_URI, scope: SPOTIFY_SCOPES, state: pkce.state, code_challenge_method: 'S256', code_challenge: pkce.challenge }).toString();
        void this.options.openExternal(url.toString()).catch(error => finish(error instanceof Error ? error : new Error('Không mở được trình duyệt.')));
      });
    });
  }
  private async exchange(body: URLSearchParams, clientId: string, previous?: Tokens, signal?: AbortSignal): Promise<Tokens> {
    const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Spotify đang giới hạn yêu cầu. Thử lại sau.' : 'Phiên Spotify không còn hợp lệ. Kiểm tra Client ID, redirect URI và đăng nhập lại.');
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.access_token !== 'string' || !data.access_token || !(typeof data.refresh_token === 'string' && data.refresh_token || previous?.refreshToken)) throw new Error('Spotify trả về phiên đăng nhập thiếu token.');
    return { clientId, accessToken: data.access_token, refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : previous!.refreshToken, expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000, displayName: previous?.displayName };
  }
  async accessToken(force = false, signal?: AbortSignal): Promise<string> {
    if (!this.status().connected || !this.tokens) throw new Error('Kết nối tài khoản Spotify trong Settings để đọc playlist.');
    if (!force && this.tokens.expiresAt > Date.now() + 30_000) return this.tokens.accessToken;
    if (this.refresh) return this.refresh;
    const previous = this.tokens;
    const generation = this.generation;
    this.refresh = this.exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: previous.refreshToken, client_id: previous.clientId }), previous.clientId, previous, signal).then(async tokens => {
      if (this.tokens !== previous || this.options.clientId().trim() !== previous.clientId) throw new Error('Phiên Spotify đã thay đổi. Kết nối lại tài khoản.');
      await this.save(tokens, generation); return tokens.accessToken;
    }).finally(() => { this.refresh = undefined; });
    return this.refresh;
  }
}
