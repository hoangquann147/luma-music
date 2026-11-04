import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';
import type { Track } from '../shared/types';

const environment = vi.hoisted(() => ({ directory: '', appDirectory: '', handler: undefined as undefined | ((request: Request) => Promise<Response>) }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => environment.appDirectory, getPath: (name: string) => name === 'userData' ? environment.directory : path.join(environment.directory, name) },
  safeStorage: { isEncryptionAvailable: () => false },
  protocol: { handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => { environment.handler = handler; } },
}));
import { LibraryStore } from '../electron/main/store';
import { registerMediaProtocol } from '../electron/main/media';
import { M4aCompatibilityCache } from '../electron/main/m4a-cache';

const execute = promisify(execFile);
const bundled = path.resolve('resources/tools/ffmpeg.exe');
const ffmpeg = process.env.FFMPEG_TEST_PATH || (existsSync(bundled) ? bundled : '');
const run = (args: string[]) => execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
let alac: string, aac: string, raw: Buffer, directory: string;
let library: LibraryStore;
let shutdown: () => Promise<void>;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!ffmpeg)('real local M4A (AAC / ALAC) support', () => {
  beforeAll(async () => {
    const testRoot = path.resolve('node_modules/.cache/luma-m4a-tests');
    await fs.mkdir(testRoot, { recursive: true }); directory = await fs.realpath(await fs.mkdtemp(path.join(testRoot, 'case-')));
    environment.directory = directory; environment.appDirectory = process.cwd();
    alac = path.join(directory, 'Nguồn ALAC.M4A'); aac = path.join(directory, 'Nguồn AAC.m4a');
    const pcm = path.join(directory, 'source.s24le');
    const cover = path.join(directory, 'cover.png');
    raw = Buffer.alloc(19_200 * 2 * 3); let state = 0x24681357;
    for (let offset = 0; offset < raw.length; offset += 3) { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; raw.writeUIntLE(state >>> 8, offset, 3); }
    await fs.writeFile(pcm, raw);
    await run(['-f', 'lavfi', '-i', 'color=c=0x5277a8:s=32x32:d=0.04', '-frames:v', '1', cover]);
    await run(['-f', 's24le', '-ar', '96000', '-ac', '2', '-i', pcm, '-i', cover, '-map', '0:a:0', '-map', '1:v:0', '-c:a', 'alac', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', '-metadata', 'title=Bình minh ALAC', '-metadata', 'artist=Nghệ sĩ thử nghiệm', '-metadata', 'album=M4A collection', alac]);
    await run(['-f', 's24le', '-ar', '96000', '-ac', '2', '-i', pcm, '-c:a', 'aac', '-b:a', '192k', '-metadata', 'title=Bình minh AAC', '-metadata', 'artist=Nghệ sĩ thử nghiệm', aac]);
    library = new LibraryStore(); await library.initialize(); await library.updateSettings({ ffmpegPath: ffmpeg });
    shutdown = registerMediaProtocol(library);
  }, 60_000);
  afterAll(async () => { await shutdown?.(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

  it('imports AAC and 24-bit ALAC as verified managed copies, retaining original paths, Unicode tags and truthful quality', async () => {
    const alacHash = digest(await fs.readFile(alac)), aacHash = digest(await fs.readFile(aac));
    const [lossless, lossy] = await Promise.all([library.addFile(alac), library.addFile(aac)]);
    expect(lossless).toMatchObject({ originalPath: await fs.realpath(alac), managed: true, container: 'M4A', codec: 'ALAC', lossless: true, sampleRate: 96000, bitsPerSample: 24, channels: 2, title: 'Bình minh ALAC', artist: 'Nghệ sĩ thử nghiệm' });
    expect(lossy).toMatchObject({ originalPath: await fs.realpath(aac), managed: true, container: 'M4A', codec: 'AAC', lossless: false, title: 'Bình minh AAC', sampleRate: 96000 });
    expect(lossless.path).not.toBe(alac); expect(lossy.path).not.toBe(aac);
    expect(digest(await fs.readFile(lossless.path))).toBe(alacHash); expect(digest(await fs.readFile(lossy.path))).toBe(aacHash);
    expect(lossy.bitrate).toBeGreaterThan(0);
    expect(lossless.coverDataUrl).toBe(`data:image/png;base64,${(await fs.readFile(path.join(directory, 'cover.png'))).toString('base64')}`);
    expect((await library.addFile(alac)).id).toBe(lossless.id);
    expect(digest(await fs.readFile(alac))).toBe(alacHash); expect(digest(await fs.readFile(aac))).toBe(aacHash);
    const restored = new LibraryStore(); await restored.initialize(); expect(restored.get(lossless.id)?.codec).toBe('ALAC');
  });

  it('serves AAC original audio/mp4 bytes, exact seek ranges and HEAD', async () => {
    const track = await library.addFile(aac), bytes = await fs.readFile(aac), url = `luma-media://track/${track.id}`;
    const full = await environment.handler!(new Request(url));
    expect(full.headers.get('content-type')).toBe('audio/mp4'); expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
    const partial = await environment.handler!(new Request(url, { headers: { Range: 'bytes=16-47' } }));
    expect(partial.status).toBe(206); expect(Buffer.from(await partial.arrayBuffer())).toEqual(bytes.subarray(16, 48));
    const head = await environment.handler!(new Request(url, { method: 'HEAD' }));
    expect(head.headers.get('content-length')).toBe(String(bytes.length)); expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it('decodes ALAC through a temporary FLAC proxy without changing one PCM sample', async () => {
    const track = await library.addFile(alac), url = `luma-media://track/${track.id}`;
    const response = await environment.handler!(new Request(url));
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('audio/flac');
    const proxy = path.join(directory, 'served-alac.flac'); await fs.writeFile(proxy, Buffer.from(await response.arrayBuffer()));
    const meta = await parseFile(proxy); expect(meta.format).toMatchObject({ sampleRate: 96000, bitsPerSample: 24, numberOfChannels: 2 });
    const decoded = path.join(directory, 'served-alac.s24le'); await run(['-i', proxy, '-f', 's24le', '-c:a', 'pcm_s24le', decoded]);
    expect(await fs.readFile(decoded)).toEqual(raw);
    const seek = await environment.handler!(new Request(url, { headers: { Range: 'bytes=4-35' } }));
    expect(seek.status).toBe(206); expect(Buffer.from(await seek.arrayBuffer())).toEqual((await fs.readFile(proxy)).subarray(4, 36));
    expect(await fs.readFile(alac)).not.toEqual(await fs.readFile(proxy));
  });

  it('offers AAC compatibility decode only on explicit fallback and retains the source file', async () => {
    const track = await library.addFile(aac), original = await fs.readFile(aac);
    const response = await environment.handler!(new Request(`luma-media://track/${track.id}?compat=1`));
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('audio/flac');
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString()).toBe('fLaC');
    await library.remove(track.id); expect(await fs.readFile(aac)).toEqual(original);
  });

  it('rejects renamed, truncated, unsupported and video-only containers', async () => {
    const renamed = path.join(directory, 'renamed.m4a'); await fs.writeFile(renamed, 'fLaCnot-an-mp4');
    await expect(library.addFile(renamed)).rejects.toThrow('container M4A');
    const truncated = path.join(directory, 'truncated.m4a'); await fs.writeFile(truncated, Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypM4A '), 0, 0, 0, 0]));
    await expect(library.addFile(truncated)).rejects.toThrow();
    const video = path.join(directory, 'video-only.m4a');
    await run(['-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.2', '-an', '-c:v', 'mpeg4', '-f', 'mp4', video]);
    await expect(library.addFile(video)).rejects.toThrow('AAC / ALAC');
    const mp3 = path.join(directory, 'unsupported.mp3'); await fs.writeFile(mp3, 'unsupported');
    await expect(library.addFile(mp3)).rejects.toThrow('.flac và .m4a');
  });

  it('deduplicates concurrent proxies, invalidates changed sources and cleans only its own temporary directory', async () => {
    const source = path.join(directory, 'mutable.m4a'); await fs.copyFile(alac, source);
    const imported = await library.addFile(source), controller = new AbortController();
    const cache = new M4aCompatibilityCache({ tempDirectory: path.join(directory, 'cache-dedup'), ffmpegPath: () => ffmpeg });
    const [first, second] = await Promise.all([cache.acquire(imported, controller.signal), cache.acquire(imported, controller.signal)]);
    expect(first.path).toBe(second.path); first.release(); second.release();
    await fs.appendFile(imported.path, Buffer.from([0, 0, 0, 8, ...Buffer.from('free')]));
    const changed = await cache.acquire(imported, controller.signal); expect(changed.path).not.toBe(first.path); changed.release();
    const firstRoot = path.dirname(first.path); await cache.shutdown();
    await expect(fs.stat(firstRoot)).rejects.toMatchObject({ code: 'ENOENT' }); expect((await fs.stat(source)).isFile()).toBe(true);
  });

  it('honors cancellation and rejects a proxy larger than the configured cache budget', async () => {
    const track = await library.addFile(alac), cache = new M4aCompatibilityCache({ tempDirectory: path.join(directory, 'cache-budget'), ffmpegPath: () => ffmpeg, maxCacheBytes: 4096, maxFileBytes: 4096 });
    const aborted = new AbortController(); aborted.abort();
    await expect(cache.acquire(track, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(cache.acquire(track, new AbortController().signal)).rejects.toThrow('vượt giới hạn');
    await cache.shutdown();
  });

  it('cancels one waiting request without cancelling the other consumer of the same decode', async () => {
    const track = await library.addFile(alac), cache = new M4aCompatibilityCache({ tempDirectory: path.join(directory, 'cache-abort'), ffmpegPath: () => ffmpeg });
    const cancelled = new AbortController(), retained = new AbortController();
    const first = cache.acquire(track, cancelled.signal), second = cache.acquire(track, retained.signal);
    const timer = setTimeout(() => cancelled.abort(), 5);
    try {
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      const lease = await second; expect((await fs.readFile(lease.path)).subarray(0, 4).toString()).toBe('fLaC'); lease.release();
    } finally { clearTimeout(timer); await cache.shutdown(); }
  });

  it('protects active playback leases and evicts idle proxies before exceeding the total budget', async () => {
    const cache = new M4aCompatibilityCache({ tempDirectory: path.join(directory, 'cache-eviction'), ffmpegPath: () => ffmpeg, maxFileBytes: 200_000, maxCacheBytes: 300_000 });
    const secondSource = path.join(directory, 'second-budget.m4a'); await fs.copyFile(alac, secondSource);
    const first = await library.addFile(alac), second = await library.addFile(secondSource), signal = new AbortController().signal;
    try {
      const lease = await cache.acquire(first, signal);
      expect((await fs.stat(lease.path)).size).toBeGreaterThan(100_000);
      await expect(cache.acquire(second, signal)).rejects.toThrow('đang phục vụ file khác');
      expect((await fs.stat(lease.path)).isFile()).toBe(true); lease.release();
      const replacement = await cache.acquire(second, signal); expect((await fs.stat(replacement.path)).size).toBeLessThan(200_000); replacement.release();
      await expect(fs.stat(lease.path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await cache.shutdown(); }
  });
});
