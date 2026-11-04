import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import type { Track } from '../../shared/types';

export interface PlaybackLease { path: string; release(): void }
interface CacheEntry {
  key: string; filename: string; size: number; leases: number; waiters: number;
  touched: number; finished: boolean; controller: AbortController; promise: Promise<void>;
}
interface Options {
  tempDirectory: string;
  ffmpegPath: () => string;
  maxCacheBytes?: number;
  maxFileBytes?: number;
  timeoutMs?: number;
}
const abortError = () => new DOMException('Đã hủy chuẩn bị âm thanh.', 'AbortError');

/** Bounded, app-owned playback proxies. User M4A files are never written or converted in place. */
export class M4aCompatibilityCache {
  private readonly entries = new Map<string, CacheEntry>();
  private root?: Promise<string>;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly maxCacheBytes: number;
  private readonly maxFileBytes: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: Options) {
    this.maxCacheBytes = options.maxCacheBytes ?? 512 * 1024 * 1024;
    this.maxFileBytes = Math.min(options.maxFileBytes ?? 256 * 1024 * 1024, this.maxCacheBytes);
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async acquire(track: Track, signal: AbortSignal): Promise<PlaybackLease> {
    if (this.closed || signal.aborted) throw abortError();
    const original = await fs.realpath(track.path);
    const before = await fs.stat(original);
    if (!before.isFile()) throw new Error('Không tìm thấy file M4A.');
    if (this.closed || signal.aborted) throw abortError();
    const key = createHash('sha256').update(JSON.stringify([original, before.size, before.mtimeMs])).digest('hex');
    let entry = this.entries.get(key);
    if (entry && !entry.finished && entry.controller.signal.aborted) { this.entries.delete(key); entry = undefined; }
    if (!entry) {
      if ([...this.entries.values()].filter(item => !item.finished).length >= 4) throw new Error('Có quá nhiều file M4A đang chờ giải mã. Hãy phát lại sau.');
      const root = await this.directory();
      if (this.closed || signal.aborted) throw abortError();
      // Concurrent requests can both await the creation of the private directory.
      entry = this.entries.get(key);
      if (!entry) {
        entry = { key, filename: path.join(root, `${key}.flac`), size: 0, leases: 0, waiters: 0, touched: Date.now(), finished: false, controller: new AbortController(), promise: Promise.resolve() };
        this.entries.set(key, entry);
        const pending = entry;
        pending.promise = this.queue.catch(() => undefined).then(async () => {
          if (this.closed || pending.controller.signal.aborted) throw abortError();
          await this.reserve(this.maxFileBytes);
          const temporary = path.join(root, `${key}.partial.flac`);
          try {
            await this.convert(track, original, temporary, pending.controller.signal);
            const after = await fs.stat(original);
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('File M4A đã thay đổi khi giải mã. Hãy phát lại.');
            if (this.closed || pending.controller.signal.aborted) throw abortError();
            pending.size = (await fs.stat(temporary)).size;
            if (pending.size >= this.maxFileBytes) throw new Error('Bản giải mã M4A vượt giới hạn bộ nhớ tạm.');
            await fs.rename(temporary, pending.filename);
            pending.finished = true;
          } finally { await fs.unlink(temporary).catch(() => undefined); }
        }).catch(async error => {
          if (this.entries.get(key) === pending) this.entries.delete(key);
          await fs.unlink(pending.filename).catch(() => undefined);
          throw error;
        });
        // Install a rejection handler even if every renderer request is cancelled.
        this.queue = pending.promise.then(() => undefined, () => undefined);
      }
    }
    const selected = entry;
    selected.waiters++; selected.touched = Date.now();
    let acquired = false;
    try {
      await this.waitFor(selected.promise, signal);
      if (this.closed || signal.aborted) throw abortError();
      selected.leases++; acquired = true;
      let released = false;
      return { path: selected.filename, release: () => {
        if (released) return; released = true;
        selected.leases = Math.max(0, selected.leases - 1); selected.touched = Date.now();
      } };
    } finally {
      selected.waiters--;
      if (!acquired && !selected.finished && selected.waiters === 0 && selected.leases === 0) selected.controller.abort();
    }
  }

  private directory(): Promise<string> {
    return this.root ??= fs.mkdir(this.options.tempDirectory, { recursive: true })
      .then(() => fs.mkdtemp(path.join(this.options.tempDirectory, 'luma-m4a-')));
  }

  private async reserve(bytes: number): Promise<void> {
    const total = () => [...this.entries.values()].reduce((sum, entry) => sum + (entry.finished ? entry.size : 0), 0);
    const candidates = [...this.entries.values()].filter(entry => entry.finished && entry.leases === 0 && entry.waiters === 0).sort((a, b) => a.touched - b.touched);
    for (const entry of candidates) {
      if (total() + bytes <= this.maxCacheBytes) break;
      await fs.unlink(entry.filename);
      this.entries.delete(entry.key);
    }
    if (total() + bytes > this.maxCacheBytes) throw new Error('Bộ nhớ tạm đang phục vụ file khác. Hãy dừng bài đang phát rồi thử lại.');
  }

  private async convert(track: Track, input: string, output: string, signal: AbortSignal): Promise<void> {
    // FLAC proxies for AAC are compatibility decodes, not restoration of lost data.
    // ALAC keeps its original precision/rate; padding 20-bit PCM to 24 bits is lossless.
    const precision = track.codec === 'ALAC' ? (track.bitsPerSample > 24 ? 32 : track.bitsPerSample > 16 ? 24 : 16) : 24;
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-c:a', 'flac', '-compression_level', '1', '-sample_fmt', precision > 16 ? 's32' : 's16', '-bits_per_raw_sample', String(precision), '-strict', 'experimental', '-fs', String(this.maxFileBytes), output];
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      const child = spawn(this.options.ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
      let stderr = '', timedOut = false;
      const stop = () => child.kill();
      signal.addEventListener('abort', stop, { once: true });
      const timeout = setTimeout(() => { timedOut = true; stop(); }, this.timeoutMs);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
      child.once('error', error => { clearTimeout(timeout); signal.removeEventListener('abort', stop); reject(new Error(`Không mở được FFmpeg để phát M4A: ${error.message}`)); });
      child.once('close', code => {
        clearTimeout(timeout); signal.removeEventListener('abort', stop);
        if (signal.aborted || this.closed) reject(abortError());
        else if (timedOut) reject(new Error('Giải mã M4A mất quá nhiều thời gian. Hãy thử file ngắn hơn.'));
        else if (code !== 0) reject(new Error(`Không giải mã được M4A bằng FFmpeg: ${stderr.trim() || `mã ${code}`}`));
        else resolve();
      });
      if (signal.aborted) stop();
    });
    if (signal.aborted || this.closed) throw abortError();
    const stat = await fs.stat(output);
    if (stat.size >= this.maxFileBytes) throw new Error('Bản giải mã M4A vượt giới hạn bộ nhớ tạm 256 MB.');
    const converted = await parseFile(output, { duration: true, skipCovers: true });
    if (!converted.format.duration || converted.format.duration < track.duration - .1 || converted.format.duration > track.duration + .25 || converted.format.sampleRate !== track.sampleRate || converted.format.numberOfChannels !== track.channels || (track.codec === 'ALAC' && (converted.format.bitsPerSample || 0) < track.bitsPerSample))
      throw new Error('Bản giải mã M4A thiếu dữ liệu hoặc thay đổi định dạng âm thanh.');
  }

  private waitFor(promise: Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
      if (signal.aborted) { reject(abortError()); return; }
      signal.addEventListener('abort', abort, { once: true });
      promise.then(() => { signal.removeEventListener('abort', abort); resolve(); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) entry.controller.abort();
    await this.queue;
    this.entries.clear();
    if (this.root) await fs.rm(await this.root, { recursive: true, force: true });
  }
}
