import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { createServer, IncomingMessage, ServerResponse } from 'node:http';
vi.mock('electron', () => ({ safeStorage: {} }));
import { createPkce, SpotifyAuth, SPOTIFY_REDIRECT_URI, validOAuthState } from '../electron/main/spotify-auth';

let directory: string;
const secure = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xb3)),
  decryptString: (value: Buffer) => Buffer.from(value.map(byte => byte ^ 0xb3)).toString(),
};
beforeEach(async () => {
  const root = path.resolve('node_modules/.cache/luma-auth-tests'); await fs.mkdir(root, { recursive: true }); directory = await fs.mkdtemp(path.join(root, 'case-'));
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(directory, { recursive: true, force: true }); });

function fixture(timeoutMs = 1000) {
  let callback!: (request: IncomingMessage, response: ServerResponse) => void;
  class FakeServer extends EventEmitter {
    closed = false; address?: { port: number; host: string };
    listen(port: number, host: string, ready: () => void) { this.address = { port, host }; queueMicrotask(ready); return this; }
    close() { this.closed = true; return this; }
  }
  const server = new FakeServer(); const open = vi.fn(async (_url: string) => undefined); let clientId = '0123456789abcdef0123456789abcdef';
  const auth = new SpotifyAuth({ userDataDirectory: directory, clientId: () => clientId, openExternal: open, cryptoStore: secure, timeoutMs, serverFactory: ((listener: typeof callback) => { callback = listener; return server; }) as unknown as typeof createServer });
  const request = (query: string, host = '127.0.0.1:43827', pathname = '/callback') => {
    const response = { status: 0, writableEnded: false, writeHead(status: number) { this.status = status; }, end() { this.writableEnded = true; } };
    callback({ method: 'GET', url: `${pathname}?${query}`, headers: { host } } as IncomingMessage, response as unknown as ServerResponse); return response;
  };
  return { auth, server, open, request, changeClient: () => { clientId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; } };
}

describe('Spotify PKCE login and encrypted session lifecycle', () => {
  it('uses strong PKCE and timing-safe state validation', () => {
    const first = createPkce(); const second = createPkce();
    expect(first.verifier.length).toBeGreaterThanOrEqual(43);
    expect(first.challenge).toBe(createHash('sha256').update(first.verifier).digest('base64url'));
    expect(first.state).not.toBe(second.state);
    expect(validOAuthState(first.state, first.state)).toBe(true);
    expect(validOAuthState('wrong', first.state)).toBe(false);
    expect(validOAuthState(null, first.state)).toBe(false);
  });
  it('rejects forged callbacks and keeps tokens out of renderer status and plaintext disk', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600 })).mockResolvedValueOnce(Response.json({ display_name: 'Listener' })); vi.stubGlobal('fetch', fetchMock);
    const { auth, server, open, request } = fixture(); const connection = auth.connect();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    const authorize = new URL(open.mock.calls[0][0]);
    expect(server.address).toEqual({ port: 43827, host: '127.0.0.1' });
    expect(authorize.searchParams.get('redirect_uri')).toBe(SPOTIFY_REDIRECT_URI);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toContain('playlist-read-private');
    expect(request('state=forged&code=bad').status).toBe(400);
    expect(request('', '127.0.0.1:43827', 'http://[').status).toBe(400);
    expect(request('x'.repeat(9000)).status).toBe(400);
    expect(request('', '127.0.0.1:43827', 'http://evil.test/callback').status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(request(`state=${authorize.searchParams.get('state')}&code=good`, 'evil.test').status).toBe(404);
    request(`state=${authorize.searchParams.get('state')}&code=good`);
    expect(await connection).toEqual({ connected: true, displayName: 'Listener', redirectUri: SPOTIFY_REDIRECT_URI });
    const exchanged = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(createHash('sha256').update(exchanged.get('code_verifier')!).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'));
    expect(exchanged.has('client_secret')).toBe(false);
    const disk = await fs.readFile(path.join(directory, 'spotify-session.enc'));
    expect(disk.toString()).not.toContain('secret-access');
    expect(disk.toString()).not.toContain('secret-refresh');
    expect(JSON.stringify(auth.status())).not.toMatch(/secret-access|secret-refresh/);
    expect(server.closed).toBe(true);
  });
  it('does not resurrect a cancelled login when its token response arrives late', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const { auth, open, request } = fixture(); const connection = auth.connect();
    const rejected = expect(connection).rejects.toThrow('Đã hủy');
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    request(`state=${new URL(open.mock.calls[0][0]).searchParams.get('state')}&code=late`);
    auth.cancelConnect(); await rejected;
    finish(Response.json({ access_token: 'late-access', refresh_token: 'late-refresh' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(auth.status().connected).toBe(false);
    await expect(fs.stat(path.join(directory, 'spotify-session.enc'))).rejects.toThrow();
  });
  it('coalesces refreshes, preserves a refresh token when omitted, and disconnect wins over late refresh', async () => {
    const saved = { clientId: '0123456789abcdef0123456789abcdef', accessToken: 'expired', refreshToken: 'refresh-old', expiresAt: Date.now() - 1000 };
    await fs.writeFile(path.join(directory, 'spotify-session.enc'), secure.encryptString(JSON.stringify(saved)));
    const { auth, changeClient } = fixture(); await auth.initialize();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ access_token: 'new-token', expires_in: 3600 })); vi.stubGlobal('fetch', fetchMock);
    expect(await Promise.all([auth.accessToken(), auth.accessToken()])).toEqual(['new-token', 'new-token']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(secure.decryptString(await fs.readFile(path.join(directory, 'spotify-session.enc')))).refreshToken).toBe('refresh-old');
    let finish!: (value: Response) => void; fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const refresh = auth.accessToken(true); const rejected = expect(refresh).rejects.toThrow('đã thay đổi');
    await auth.disconnect(); finish(Response.json({ access_token: 'too-late', refresh_token: 'rotated' })); await rejected;
    expect(auth.status().connected).toBe(false);
    await expect(fs.stat(path.join(directory, 'spotify-session.enc'))).rejects.toThrow();
    changeClient(); expect(auth.status().connected).toBe(false);
  });
  it('times out the loopback listener and rejects a session for a different Client ID', async () => {
    const { auth, server } = fixture(20); await expect(auth.connect()).rejects.toThrow('3 phút'); expect(server.closed).toBe(true);
    await fs.writeFile(path.join(directory, 'spotify-session.enc'), secure.encryptString(JSON.stringify({ clientId: 'other-app', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600000 })));
    await auth.initialize(); expect(auth.status().connected).toBe(false); await expect(auth.accessToken()).rejects.toThrow('Kết nối');
  });
});
