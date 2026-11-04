import { app, protocol } from 'electron';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { LibraryStore } from './store';
import { parseByteRange, trackId } from './validation';
import { M4aCompatibilityCache, type PlaybackLease } from './m4a-cache';

export function registerMediaProtocol(library: LibraryStore): () => Promise<void> {
  let compatibility: M4aCompatibilityCache | undefined;
  protocol.handle('luma-media', async request => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    let id: string, forceCompatible = false;
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'track' || !/^\/[a-f0-9-]{36}$/i.test(url.pathname)) return new Response(null, { status: 404 });
      id = trackId(url.pathname.slice(1));
      forceCompatible = url.searchParams.get('compat') === '1';
    } catch { return new Response(null, { status: 400 }); }
    const track = library.get(id);
    if (!track) return new Response(null, { status: 404 });
    let lease: PlaybackLease | undefined;
    try {
      const m4a = track.container === 'M4A' || path.extname(track.path).toLowerCase() === '.m4a';
      const compatible = m4a && (forceCompatible || track.codec === 'ALAC');
      if (compatible) {
        compatibility ??= new M4aCompatibilityCache({ tempDirectory: app.getPath('temp'), ffmpegPath: () => library.settings().ffmpegPath });
        lease = await compatibility.acquire(track, request.signal);
      }
      const filename = lease?.path || track.path;
      const stat = await fs.stat(filename);
      if (!stat.isFile()) return new Response(null, { status: 404 });
      let range;
      try { range = parseByteRange(request.headers.get('range'), stat.size); }
      catch { return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } }); }
      const headers = new Headers({
        'Content-Type': m4a && !compatible ? 'audio/mp4' : 'audio/flac', 'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': String(range ? range.end - range.start + 1 : stat.size),
        'Cache-Control': 'no-store',
      });
      if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      const status = range ? 206 : 200;
      if (request.method === 'HEAD' || stat.size === 0) return new Response(null, { status, headers });
      const stream = createReadStream(filename, range ? { start: range.start, end: range.end } : undefined);
      const streamLease = lease; lease = undefined;
      const abort = () => stream.destroy();
      const release = () => { request.signal.removeEventListener('abort', abort); streamLease?.release(); };
      stream.once('close', release); stream.once('error', release);
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) stream.destroy();
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
    } catch (error) {
      if ((error as Error).name === 'AbortError') return new Response(null, { status: 499 });
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 });
      return new Response((error as Error).message || 'Không mở được file âm thanh.', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    } finally { lease?.release(); }
  });
  return () => compatibility?.shutdown() || Promise.resolve();
}
