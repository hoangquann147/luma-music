import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { createServer, IncomingMessage, ServerResponse } from 'node:http';
vi.mock('electron', () => ({ safeStorage: {} }));
import { GOOGLE_DRIVE_SCOPE, GoogleAuth, validGoogleState } from '../electron/main/google-auth';
let directory: string;
const secure = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xac)), decryptString: (value: Buffer) => Buffer.from(value.map(byte => byte ^ 0xac)).toString() };
beforeEach(async () => { const root = path.resolve('node_modules/.cache/luma-google-auth-tests'); await fs.mkdir(root, { recursive: true }); directory = await fs.mkdtemp(path.join(root, 'case-')); });
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(directory, { recursive: true, force: true }); });
function fixture(timeoutMs = 1000) {
  let callback!: (request: IncomingMessage, response: ServerResponse) => void;
  class FakeServer extends EventEmitter {
    closed = false; requested?: { port: number; host: string };
    listen(port: number, host: string, ready: () => void) { this.requested = { port, host }; queueMicrotask(ready); return this; }
    address() { return { port: 49231, address: '127.0.0.1', family: 'IPv4' }; }
    close() { this.closed = true; return this; }
  }
  const server = new FakeServer(); const open = vi.fn(async (_url: string) => undefined); let id = 'client.apps.googleusercontent.com';
  const auth = new GoogleAuth({ userDataDirectory: directory, client: () => ({ id, secret: 'desktop-secret' }), openExternal: open, cryptoStore: secure, timeoutMs, serverFactory: ((listener: typeof callback) => { callback = listener; return server; }) as unknown as typeof createServer });
  const request = (query: string, target = '/callback', host = '127.0.0.1:49231') => {
    const response = { status: 0, writableEnded: false, writeHead(status: number) { this.status = status; }, end() { this.writableEnded = true; } };
    callback({ method: 'GET', url: `${target}?${query}`, headers: { host } } as IncomingMessage, response as unknown as ServerResponse); return response;
  };
  return { auth, server, open, request, changeClient: () => { id = 'different.apps.googleusercontent.com'; } };
}
describe('Google installed Desktop OAuth', () => {
  it('binds a random loopback port, requests only drive.file with PKCE/offline, and persists encrypted tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: GOOGLE_DRIVE_SCOPE })); vi.stubGlobal('fetch', fetchMock);
    const { auth, server, open, request } = fixture(); const connection = auth.connect();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    const url = new URL(open.mock.calls[0][0]); expect(server.requested).toEqual({ port: 0, host: '127.0.0.1' });
    expect(url.origin).toBe('https://accounts.google.com'); expect(url.searchParams.get('scope')).toBe(GOOGLE_DRIVE_SCOPE); expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:49231/callback');
    expect(request('state=forged&code=bad').status).toBe(400); expect(fetchMock).not.toHaveBeenCalled();
    expect(request('', 'http://[').status).toBe(400); expect(request('', 'http://evil.test/callback').status).toBe(404); expect(request('x'.repeat(9000)).status).toBe(400);
    request(`state=${url.searchParams.get('state')}&code=real-code`); await connection;
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(body.get('client_secret')).toBe('desktop-secret'); expect(auth.connected).toBe(true); expect(server.closed).toBe(true);
    const disk = await fs.readFile(path.join(directory, 'google-drive-tokens.enc')); expect(disk.toString()).not.toMatch(/private-access|private-refresh/);
    expect(validGoogleState('a', 'a')).toBe(true); expect(validGoogleState('b', 'a')).toBe(false);
  });
  it('cannot restore tokens from a late callback after cancellation', async () => {
    let finish!: (response: Response) => void; vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const { auth, open, request } = fixture(); const connection = auth.connect(); const rejected = expect(connection).rejects.toThrow('Đã hủy');
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce()); request(`state=${new URL(open.mock.calls[0][0]).searchParams.get('state')}&code=late`);
    auth.cancelConnect(); await rejected; finish(Response.json({ access_token: 'late', refresh_token: 'late-refresh' }));
    await new Promise(resolve => setTimeout(resolve, 20)); expect(auth.connected).toBe(false); await expect(fs.stat(path.join(directory, 'google-drive-tokens.enc'))).rejects.toThrow();
  });
  it('coalesces token refresh, retains the refresh token, and makes disconnect win over late refresh', async () => {
    await fs.writeFile(path.join(directory, 'google-drive-tokens.enc'), secure.encryptString(JSON.stringify({ clientId: 'client.apps.googleusercontent.com', accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 0 })));
    const { auth, changeClient } = fixture(); await auth.initialize(); const fetchMock = vi.fn().mockResolvedValue(Response.json({ access_token: 'renewed', expires_in: 3600 })); vi.stubGlobal('fetch', fetchMock);
    expect(await Promise.all([auth.accessToken(), auth.accessToken()])).toEqual(['renewed', 'renewed']); expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(secure.decryptString(await fs.readFile(path.join(directory, 'google-drive-tokens.enc')))).refreshToken).toBe('old-refresh');
    let finish!: (response: Response) => void; fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })); const refresh = auth.accessToken(true); const rejected = expect(refresh).rejects.toThrow('đã thay đổi');
    await auth.disconnect(); finish(Response.json({ access_token: 'too-late' })); await rejected; expect(auth.connected).toBe(false); await expect(fs.stat(path.join(directory, 'google-drive-tokens.enc'))).rejects.toThrow();
    changeClient(); expect(auth.connected).toBe(false);
  });
  it('closes a timed-out loopback server and works locally without an OAuth client configured', async () => {
    const { auth, server } = fixture(20); await expect(auth.connect()).rejects.toThrow('3 phút'); expect(server.closed).toBe(true);
    const local = new GoogleAuth({ userDataDirectory: directory, client: () => ({ id: '' }), openExternal: async () => undefined, cryptoStore: secure }); await local.initialize(); expect(local.connected).toBe(false); await expect(local.connect()).rejects.toThrow('Desktop app');
  });
});
