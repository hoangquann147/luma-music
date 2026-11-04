import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
vi.mock('electron', () => ({ safeStorage: {} }));
vi.mock('music-metadata', () => ({ parseFile: vi.fn(async () => ({ common: { title: 'Bình minh 🌷', artist: 'Artist', album: 'Album' }, format: { duration: 180 } })) }));
import { DriveSyncService, driveProperty, driveTrackId, resumableOffset } from '../electron/main/drive-sync';
import type { DriveStatus } from '../shared/drive-types';

let directory: string;
const secure = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xac)), decryptString: (value: Buffer) => Buffer.from(value.map(byte => byte ^ 0xac)).toString() };
beforeEach(async () => { const root = path.resolve('node_modules/.cache/luma-drive-tests'); await fs.mkdir(root, { recursive: true }); directory = await fs.mkdtemp(path.join(root, 'case-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
type Remote = { id: string; properties: Record<string, string>; parents: string[]; md5Checksum?: string; size?: string };
function fixture() {
  let connected = true; const events: DriveStatus[] = []; const files = new Map<string, Remote>(); const sessions = new Map<string, { remote: Remote; md5: ReturnType<typeof createHash>; received: number }>();
  let serial = 0; let creates = 0; let updates = 0; let interrupt = false; let interrupted = false; let blockChunk = false; let paginate = false; let chunkStarted: (() => void) | undefined;
  const chunks: number[] = [];
  const auth = { get connected() { return connected; }, connecting: false, initialize: async () => undefined, connect: async () => { connected = true; }, cancelConnect: () => undefined, disconnect: async () => { connected = false; }, accessToken: async () => { if (!connected) throw new Error('disconnected'); return 'secret-bearer'; } };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)); const method = init?.method || 'GET'; const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer secret-bearer');
    if (url.pathname.endsWith('/generateIds')) return Response.json({ ids: [`remote${++serial}`] });
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const query = url.searchParams.get('q') || '';
      if (paginate && !url.searchParams.has('pageToken')) return Response.json({ files: [], nextPageToken: 'page-two' });
      return Response.json({ files: query.includes('lumaSyncRoot') ? [{ id: 'folder123' }] : [...files.values()] });
    }
    if (url.pathname.startsWith('/drive/v3/files/') && method === 'GET') { const remote = files.get(url.pathname.split('/').pop()!); return remote ? Response.json(remote, { headers: { etag: '"baseline"' } }) : new Response(null, { status: 404 }); }
    if (url.pathname.startsWith('/upload/drive/v3/files') && (method === 'POST' || method === 'PATCH')) {
      const data = JSON.parse(String(init?.body)) as Remote; if (method === 'POST') creates++; else updates++;
      if (method === 'PATCH') expect(headers.get('if-match')).toBe('"baseline"');
      const id = method === 'PATCH' ? url.pathname.split('/').pop()! : data.id;
      const key = `s${++serial}`; sessions.set(key, { remote: { ...data, id, parents: data.parents || ['folder123'] }, md5: createHash('md5'), received: 0 });
      return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${key}` } });
    }
    if (url.searchParams.has('upload_id') && method === 'PUT') {
      const session = sessions.get(url.searchParams.get('upload_id')!)!;
      if (headers.get('content-range')?.startsWith('bytes */')) return new Response(null, { status: 308, headers: { range: `bytes=0-${session.received - 1}` } });
      if (blockChunk) {
        chunkStarted?.();
        return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
      }
      expect(Buffer.isBuffer(init?.body)).toBe(false);
      let length = 0; for await (const chunk of init?.body as unknown as AsyncIterable<Buffer>) { session.md5.update(chunk); length += chunk.length; }
      chunks.push(length); session.received += length;
      if (interrupt && !interrupted) { interrupted = true; return new Response(null, { status: 503 }); }
      const total = Number(headers.get('content-range')!.split('/')[1]);
      if (session.received < total) return new Response(null, { status: 308, headers: { range: `bytes=0-${session.received - 1}` } });
      session.remote.md5Checksum = session.md5.digest('hex'); session.remote.size = String(session.received); files.set(session.remote.id, session.remote); return Response.json(session.remote);
    }
    throw new Error(`Unexpected test HTTP ${method} ${url}`);
  });
  const service = new DriveSyncService({ userDataDirectory: path.join(directory, 'profile'), defaultSourceDirectory: path.join(directory, 'music'), openExternal: async () => undefined, onStatus: status => events.push(status), auth, cryptoStore: secure, fetch: fetchMock });
  return { service, files, events, fetchMock, chunks, counts: () => ({ creates, updates }), interrupt: () => { interrupt = true; }, paginate: () => { paginate = true; }, block: (started: () => void) => { blockChunk = true; chunkStarted = started; } };
}
async function source(bytes: number, value = 17) { const dir = path.join(directory, 'music'); await fs.mkdir(dir, { recursive: true }); const data = Buffer.alloc(bytes, value); data.write('fLaC'); const file = path.join(dir, 'recording.flac'); await fs.writeFile(file, data); return { file, data }; }
describe('PC to Google Drive incremental sync', () => {
  it('uses stable relative-path IDs, safe UTF-8 properties and validates resumable acknowledgements', () => {
    expect(driveTrackId('album\\song.flac')).toBe(driveTrackId('album/song.flac')); expect(driveTrackId('other/song.flac')).not.toBe(driveTrackId('album/song.flac'));
    const title = driveProperty('title', '🌷'.repeat(80)); expect(Buffer.byteLength('title' + title)).toBeLessThanOrEqual(124); expect(title).not.toContain('\ufffd');
    expect(resumableOffset('bytes=0-255', 512)).toBe(256); expect(resumableOffset(null, 512)).toBe(0); expect(() => resumableOffset('bytes=10-20', 512)).toThrow(); expect(() => resumableOffset('bytes=0-900', 512)).toThrow();
  });
  it('streams 8 MiB chunks, recovers a server interruption, skips unchanged data and updates the same remote ID', async () => {
    const original = await source(8 * 1024 * 1024 + 123); const { service, files, chunks, counts, interrupt } = fixture(); await service.initialize(); await service.saveConfig({ autoSync: false }); interrupt();
    const first = await service.syncNow(); expect(first).toMatchObject({ uploaded: 1, failed: 0, filesDone: 1 }); expect(chunks).toEqual([8 * 1024 * 1024, 123]); expect(counts()).toEqual({ creates: 1, updates: 0 });
    const remoteId = [...files.keys()][0]; expect(files.get(remoteId)!.md5Checksum).toBe(createHash('md5').update(original.data).digest('hex')); expect(files.get(remoteId)!.properties.lumaTrackId).toBe(driveTrackId('recording.flac'));
    expect((await service.syncNow()).skipped).toBe(1); expect(counts()).toEqual({ creates: 1, updates: 0 });
    await fs.writeFile(original.file, Buffer.from('fLaCchanged recording payload')); expect((await service.syncNow()).uploaded).toBe(1); expect(counts()).toEqual({ creates: 1, updates: 1 }); expect([...files.keys()]).toEqual([remoteId]);
    files.get(remoteId)!.md5Checksum = 'outside-edit'; const conflict = await service.syncNow(); expect(conflict.failed).toBe(1); expect(conflict.message).toContain('tránh ghi đè'); expect(counts()).toEqual({ creates: 1, updates: 1 }); await service.shutdown();
  });
  it('has one active run, cancels on disconnect and never publishes a late uploaded result', async () => {
    await source(10000); const { service, files, events, block, counts } = fixture(); await service.initialize(); await service.saveConfig({ autoSync: false });
    let started!: () => void; const chunkStarted = new Promise<void>(resolve => { started = resolve; }); block(started);
    const first = service.syncNow(); expect(service.syncNow()).toBe(first); await chunkStarted;
    const disconnected = await service.disconnect(); await first; expect(disconnected.connected).toBe(false); expect(files.size).toBe(0); expect(counts().creates).toBe(1);
    expect(events.at(-1)!.connected).toBe(false); expect(events.at(-1)!.phase).toBe('idle'); await expect(service.syncNow()).rejects.toThrow('Kết nối'); await service.shutdown();
  });
  it('reads all list pages and never overwrites a different remote file without a cached baseline', async () => {
    await source(1000); const { service, files, fetchMock, counts, paginate } = fixture();
    files.set('existing123', { id: 'existing123', md5Checksum: 'different-remote-checksum', parents: ['folder123'], properties: { lumaTrackId: driveTrackId('recording.flac'), lumaSource: 'desktop' } });
    paginate(); await service.initialize(); await service.saveConfig({ autoSync: false });
    const result = await service.syncNow(); expect(result.failed).toBe(1); expect(result.message).toContain('chưa có bản đối chiếu'); expect(counts()).toEqual({ creates: 0, updates: 0 });
    expect(fetchMock.mock.calls.filter(call => new URL(String(call[0])).searchParams.get('pageToken') === 'page-two')).toHaveLength(2);
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/files/existing123?'))).toBe(true); await service.shutdown();
  });
  it('reports a file above the Android 2 GiB limit without reading or uploading it', async () => {
    const original = await source(100); const { service, counts } = fixture(); await service.initialize(); await service.saveConfig({ autoSync: false });
    const stat = await fs.stat(original.file); vi.spyOn(fs, 'stat').mockResolvedValueOnce({ ...stat, size: 2 * 1024 * 1024 * 1024 + 1 } as Awaited<ReturnType<typeof fs.stat>>);
    const result = await service.syncNow(); expect(result.failed).toBe(1); expect(result.message).toContain('2 GiB'); expect(counts()).toEqual({ creates: 0, updates: 0 }); await service.shutdown();
  });
  it('redacts config secrets, preserves them when omitted and does not require OAuth for local startup', async () => {
    await source(100); const { service } = fixture(); await service.initialize();
    const status = await service.saveConfig({ desktopClientId: 'desktop.apps.googleusercontent.com', desktopClientSecret: 'top-secret', autoSync: false });
    expect(status.config.secretConfigured).toBe(true); expect(JSON.stringify(status)).not.toContain('top-secret');
    const publicFile = await fs.readFile(path.join(directory, 'profile', 'drive-config.json'), 'utf8'); expect(publicFile).not.toMatch(/top-secret|secret-bearer/);
    const secretFile = await fs.readFile(path.join(directory, 'profile', 'google-drive-credentials.enc')); expect(secretFile.toString()).not.toContain('top-secret');
    expect((await service.saveConfig({ autoSync: true })).config.secretConfigured).toBe(true); await service.shutdown();
    const local = new DriveSyncService({ userDataDirectory: path.join(directory, 'empty-profile'), defaultSourceDirectory: path.join(directory, 'music'), openExternal: async () => undefined, onStatus: () => undefined, cryptoStore: secure }); await local.initialize(); expect(local.status().connected).toBe(false); expect(local.status().config.desktopClientId).toBe(''); await local.shutdown();
  });
});
