import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import type { DownloadJob, DownloadRequest, SourceCandidate, SpotifyMatch, SpotifyMetadata, ToolStatus } from '../../shared/types';
import type { InternalSettings, LibraryStore } from './store';
import { parseSourceUrl, safeFilename } from './validation';
import { SpotifyClient } from './spotify';
export { safeFilename } from './validation';

interface ProcessOptions { signal?: AbortSignal; timeoutMs?: number; onLine?: (line: string) => void }
interface ProcessResult { stdout: string; stderr: string }

/** Arguments are always passed separately; no shell or user yt-dlp config is executed. */
export function runProcess(binary: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('Đã hủy.')); return; }
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(binary, args, { shell: false, windowsHide: true, stdio: 'pipe' }); }
    catch (error) { reject(error); return; }
    let stdout = ''; let stderr = ''; let pending = ''; let settled = false; let timedOut = false; let terminating = false;
    const abort = () => {
      if (terminating || child.exitCode !== null || child.signalCode !== null) return;
      terminating = true;
      if (process.platform !== 'win32' || !child.pid) { child.kill('SIGKILL'); return; }
      // yt-dlp may start a JavaScript runtime. End its entire process tree on Windows.
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      const fallback = setTimeout(() => child.kill('SIGKILL'), 5000);
      killer.once('error', () => { clearTimeout(fallback); child.kill('SIGKILL'); });
      killer.once('close', (code) => { clearTimeout(fallback); if (code !== 0) child.kill('SIGKILL'); });
    };
    const timer = setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs ?? 120_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve({ stdout, stderr });
    };
    child.stdin.end();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-8_000_000);
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/); pending = lines.pop() || '';
      lines.forEach((line) => options.onLine?.(line));
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16_000); });
    child.once('error', (error) => finish(new Error(`Không chạy được ${path.basename(binary)}: ${error.message}`)));
    child.once('close', (code) => {
      if (pending) options.onLine?.(pending);
      if (options.signal?.aborted) finish(new Error('Đã hủy.'));
      else if (timedOut) finish(new Error(`${path.basename(binary)} quá thời gian cho phép.`));
      else if (code !== 0) finish(new Error(`${path.basename(binary)} lỗi: ${stderr.trim().slice(-1800) || `mã ${code}`}`));
      else finish();
    });
  });
}

export async function checkTools(settings: InternalSettings): Promise<ToolStatus> {
  const check = async (binary: string, args: string[]) => {
    try { const result = await runProcess(binary, args, { timeoutMs: 10_000 }); return { available: true, version: (result.stdout || result.stderr).split(/\r?\n/)[0].slice(0, 160) }; }
    catch (error) { return { available: false, error: error instanceof Error ? error.message : String(error) }; }
  };
  const probe = path.isAbsolute(settings.ffmpegPath)
    ? path.join(path.dirname(settings.ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : 'ffprobe';
  const [ytDlp, ffmpegStatus, ffprobeStatus] = await Promise.all([
    check(settings.ytDlpPath, ['--ignore-config', '--version']),
    check(settings.ffmpegPath, ['-version']),
    check(probe, ['-version']),
  ]);
  return {
    ytDlp,
    ffmpeg: !ffmpegStatus.available ? ffmpegStatus : !ffprobeStatus.available
      ? { available: false, error: `Thiếu ffprobe đi kèm FFmpeg: ${ffprobeStatus.error}` }
      : ffmpegStatus,
  };
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const terminal = (job: DownloadJob): boolean => ['completed', 'cancelled', 'error'].includes(job.stage);

export class Downloader {
  private readonly jobs = new Map<string, DownloadJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly preparations = new Map<string, { controller: AbortController; task: Promise<SpotifyMatch> }>();
  private readonly matches = new Map<string, { value: SpotifyMatch; url: string; expiresAt: number }>();
  private readonly spotify: SpotifyClient;
  private closing = false;

  constructor(private readonly settings: () => InternalSettings, private readonly library: LibraryStore, private readonly onUpdate: (job: DownloadJob) => void, spotifyClient?: SpotifyClient) {
    this.spotify = spotifyClient || new SpotifyClient(settings);
  }

  listJobs(): DownloadJob[] { return [...this.jobs.values()].map((job) => ({ ...job })); }

  private args(): string[] {
    return ['--ignore-config', '--no-playlist', ...(process.env.YTDLP_JS_RUNTIME ? ['--js-runtimes', process.env.YTDLP_JS_RUNTIME] : [])];
  }

  prepareSpotify(url: string): Promise<SpotifyMatch> {
    return this.preparation(signal => this.spotify.track(url, signal));
  }

  /** Trusted, validated playlist metadata avoids Spotify requests for exported files. */
  prepareSpotifyMetadata(metadata: SpotifyMetadata, externalSignal?: AbortSignal): Promise<SpotifyMatch> {
    const source = parseSourceUrl(metadata.spotifyUrl);
    if (source.kind !== 'spotify' || !metadata.title || !metadata.artist) return Promise.reject(new Error('Metadata playlist không hợp lệ.'));
    return this.preparation(async () => ({ ...metadata, spotifyUrl: source.url }), externalSignal);
  }

  private preparation(loadMetadata: (signal: AbortSignal) => Promise<SpotifyMetadata>, externalSignal?: AbortSignal): Promise<SpotifyMatch> {
    if (this.closing) return Promise.reject(new Error('Ứng dụng đang đóng.'));
    const id = randomUUID(); const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const task = loadMetadata(controller.signal).then(metadata => this.resolveSpotify(metadata, controller.signal));
    this.preparations.set(id, { controller, task });
    void task.finally(() => { this.preparations.delete(id); externalSignal?.removeEventListener('abort', abort); }).catch(() => undefined);
    return task;
  }

  private async resolveSpotify(metadata: SpotifyMetadata, signal: AbortSignal): Promise<SpotifyMatch> {
    const source = parseSourceUrl(metadata.spotifyUrl);
    if (source.kind !== 'spotify') throw new Error('Cần liên kết Spotify của một bài hát.');
    const query = `${metadata.artist} ${metadata.title} audio`.slice(0, 400);
    const result = await runProcess(this.settings().ytDlpPath, [...this.args(), '--flat-playlist', '--dump-single-json', '--skip-download', '--', `ytsearch3:${query}`], { signal });
    const data = object(JSON.parse(result.stdout));
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const candidates = entries.map((entry): SourceCandidate | undefined => {
      const item = object(entry); const id = text(item.id);
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return undefined;
      return { id, title: text(item.title) || id, channel: text(item.channel) || text(item.uploader), duration: Math.max(0, Number(item.duration) || 0), url: `https://www.youtube.com/watch?v=${id}` };
    }).filter((candidate): candidate is SourceCandidate => Boolean(candidate));
    if (!candidates.length) throw new Error('Không tìm thấy nguồn YouTube tương ứng. Thử dán trực tiếp liên kết YouTube.');
    const match: SpotifyMatch = { id: randomUUID(), metadata, candidates };
    for (const [id, item] of this.matches) if (item.expiresAt < Date.now()) this.matches.delete(id);
    this.matches.set(match.id, { value: match, url: source.url, expiresAt: Date.now() + 15 * 60_000 });
    return match;
  }

  start(request: DownloadRequest): DownloadJob {
    if (this.closing) throw new Error('Ứng dụng đang đóng.');
    if (request.rightsConfirmed !== true) throw new Error('Xác nhận bạn có quyền tải nguồn âm thanh đã chọn.');
    if ([...this.jobs.values()].filter((job) => !terminal(job)).length >= 2) throw new Error('Đang xử lý tối đa 2 tác vụ. Hãy chờ hoặc hủy một tác vụ.');
    const source = parseSourceUrl(request.url);
    let sourceUrl = source.url; let metadata: SpotifyMetadata | undefined;
    if (source.kind === 'spotify') {
      const cached = request.spotifyMatchId ? this.matches.get(request.spotifyMatchId) : undefined;
      const candidate = cached?.value.candidates.find((item) => item.id === request.candidateId);
      if (!cached || cached.expiresAt < Date.now() || cached.url !== source.url || !candidate) throw new Error('Hãy tìm và chọn lại nguồn YouTube cho bài hát Spotify.');
      metadata = cached.value.metadata; sourceUrl = candidate.url;
    }
    const job: DownloadJob = { id: randomUUID(), url: source.url, title: metadata ? `${metadata.artist} — ${metadata.title}` : 'YouTube audio', stage: 'queued', progress: 0, createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    const controller = new AbortController(); this.controllers.set(job.id, controller);
    // Keep memory bounded without losing active work.
    for (const [id, previous] of this.jobs) if (this.jobs.size > 100 && terminal(previous)) this.jobs.delete(id);
    this.onUpdate({ ...job });
    const execution = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.execute(job, sourceUrl, metadata, controller));
    this.executions.set(job.id, execution);
    void execution.finally(() => this.executions.delete(job.id)).catch((error) => console.error('Download task failed during shutdown:', error));
    return { ...job };
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Không tìm thấy tác vụ.');
    if (!terminal(job)) this.controllers.get(id)?.abort();
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    for (const { controller } of this.preparations.values()) controller.abort();
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.cancelAll();
    await Promise.allSettled([...this.executions.values(), ...[...this.preparations.values()].map(({ task }) => task)]);
  }

  private update(job: DownloadJob, change: Partial<DownloadJob>): void { Object.assign(job, change); this.onUpdate({ ...job }); }

  private async cover(metadata: SpotifyMetadata, directory: string, signal: AbortSignal): Promise<string | undefined> {
    if (!metadata.coverUrl) return undefined;
    const url = new URL(metadata.coverUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'i.scdn.co') return undefined;
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), redirect: 'error' });
    if (!response.ok || !/image\/(?:jpeg|png)/i.test(response.headers.get('content-type') || '')) return undefined;
    if (Number(response.headers.get('content-length') || 0) > 10_000_000) return undefined;
    const reader = response.body?.getReader(); if (!reader) return undefined;
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 10_000_000) { await reader.cancel(); throw new Error('Ảnh bìa vượt giới hạn 10 MB.'); } chunks.push(value); }
    const target = path.join(directory, /png/i.test(response.headers.get('content-type') || '') ? 'cover.png' : 'cover.jpg');
    await writeFile(target, Buffer.concat(chunks)); return target;
  }

  private convert(input: string, output: string, metadata: SpotifyMetadata, sourceUrl: string, cover: string | undefined, ffmpegPath: string, signal: AbortSignal, progress: (percent: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Đã hủy.')); return; }
      const command = ffmpeg(input).setFfmpegPath(ffmpegPath);
      if (path.isAbsolute(ffmpegPath)) command.setFfprobePath(path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
      if (cover) command.input(cover);
      const options = ['-map', '0:a:0', '-compression_level', '8', '-metadata', `title=${metadata.title}`, '-metadata', `artist=${metadata.artist}`, '-metadata', `album=${metadata.album}`, '-metadata', `comment=Audio source: ${sourceUrl}. Metadata: ${metadata.spotifyUrl}. FLAC conversion preserves the downloaded source; it does not restore lossy data.`];
      if (metadata.releaseDate) options.push('-metadata', `date=${metadata.releaseDate}`);
      if (metadata.trackNumber) options.push('-metadata', `track=${metadata.trackNumber}`);
      if (cover) options.push('-map', '1:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', '-metadata:s:v:0', 'title=Album cover', '-metadata:s:v:0', 'comment=Cover (front)');
      // Varargs disables fluent-ffmpeg's single-space splitting of option strings,
      // keeping metadata such as "title=Two Words" as one process argument.
      command.audioCodec('flac').format('flac').outputOptions(...options);
      let timedOut = false;
      const abort = () => { try { command.kill('SIGKILL'); } catch { /* process may not have started or may have ended */ } };
      const timer = setTimeout(() => { timedOut = true; abort(); }, 30 * 60_000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { cleanup(); reject(new Error('Đã hủy.')); return; }
      // fluent-ffmpeg probes capabilities asynchronously before spawning. An early
      // abort can happen before kill() has a process; repeat it at actual startup.
      command.once('start', () => { if (signal.aborted || timedOut) abort(); });
      command.on('progress', (value) => { if (Number.isFinite(value.percent)) progress(Math.min(99, Math.max(0, value.percent ?? 0))); });
      command.once('end', () => { cleanup(); signal.aborted ? reject(new Error('Đã hủy.')) : timedOut ? reject(new Error('FFmpeg quá thời gian 30 phút.')) : resolve(); });
      command.once('error', (error: Error) => { cleanup(); reject(signal.aborted ? new Error('Đã hủy.') : timedOut ? new Error('FFmpeg quá thời gian 30 phút.') : new Error(`FFmpeg: ${error.message.slice(0, 1800)}`)); });
      command.save(output);
    });
  }

  private async execute(job: DownloadJob, sourceUrl: string, spotifyMetadata: SpotifyMetadata | undefined, controller: AbortController): Promise<void> {
    let directory: string | undefined; let published: string | undefined; let committed = false;
    const signal = controller.signal;
    try {
      const settings = this.settings();
      if (signal.aborted) throw new Error('Đã hủy.');
      this.update(job, { stage: 'resolving', message: 'Đang đọc thông tin nguồn…' });
      directory = await mkdtemp(path.join(tmpdir(), 'luma-download-'));
      const metadataResult = await runProcess(settings.ytDlpPath, [...this.args(), '--dump-single-json', '--skip-download', '--', sourceUrl], { signal });
      const info = object(JSON.parse(metadataResult.stdout));
      if (info.is_live === true || info.live_status === 'is_live') throw new Error('Chưa hỗ trợ tải livestream đang phát.');
      const title = text(info.track) || text(info.title) || 'Untitled';
      const artist = text(info.artist) || text(info.uploader) || 'Unknown artist';
      const metadata: SpotifyMetadata = spotifyMetadata || { title, artist, album: text(info.album), duration: Math.max(0, Number(info.duration) || 0), spotifyUrl: sourceUrl, releaseDate: text(info.release_date) || text(info.upload_date) || undefined };
      this.update(job, { title: `${metadata.artist} — ${metadata.title}`, stage: 'downloading', progress: 0, message: 'Đang tải luồng âm thanh chất lượng cao nhất…' });
      const inputTemplate = path.join(directory, 'source.%(ext)s');
      await runProcess(settings.ytDlpPath, [...this.args(), '--format', 'bestaudio/best', '--no-simulate', '--newline', '--progress', '--progress-template', 'download:LUMA_PROGRESS:%(progress._percent_str)s', '--no-part', '--fixup', 'never', '--output', inputTemplate, '--', sourceUrl], {
        signal, timeoutMs: 30 * 60_000,
        onLine: (line) => { const match = /LUMA_PROGRESS:\s*([\d.]+)%/.exec(line); if (match) this.update(job, { progress: Math.min(69, Number(match[1]) * 0.69) }); },
      });
      const files = await readdir(directory);
      const input = files.find((name) => /^source\./.test(name) && !/\.(part|ytdl|json)$/.test(name));
      if (!input) throw new Error('yt-dlp không tạo được file âm thanh.');
      let cover: string | undefined;
      if (spotifyMetadata?.coverUrl) {
        this.update(job, { stage: 'tagging', progress: 70, message: 'Đang lấy ảnh bìa và metadata Spotify…' });
        cover = await this.cover(spotifyMetadata, directory, signal);
        if (!cover) throw new Error('Không đọc được ảnh bìa Spotify. Tác vụ chưa được lưu; hãy thử lại.');
      }
      this.update(job, { stage: 'converting', progress: 72, message: 'Đang mã hóa FLAC và gắn metadata…' });
      const converted = path.join(directory, 'converted.flac');
      await this.convert(path.join(directory, input), converted, metadata, sourceUrl, cover, settings.ffmpegPath, signal, (percent) => this.update(job, { progress: 72 + percent * 0.25 }));
      if (signal.aborted) throw new Error('Đã hủy.');
      await mkdir(settings.downloadDirectory, { recursive: true });
      // COPYFILE_EXCL prevents races and never replaces an existing recording.
      const base = safeFilename(`${metadata.artist} - ${metadata.title}`);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const target = path.join(settings.downloadDirectory, `${base}${attempt ? ` (${attempt + 1})` : ''}.flac`);
        try { await copyFile(converted, target, constants.COPYFILE_EXCL); published = target; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      if (!published) throw new Error('Có quá nhiều file trùng tên trong thư mục đích.');
      if (signal.aborted) throw new Error('Đã hủy.');
      this.update(job, { stage: 'tagging', progress: 99, message: 'Đang thêm file vào thư viện…' });
      const track = await this.library.addFile(published, spotifyMetadata ? 'spotify' : 'youtube', sourceUrl, spotifyMetadata?.spotifyUrl);
      committed = true;
      this.update(job, { stage: 'completed', progress: 100, track, message: 'Đã lưu FLAC và thêm vào Library.' });
    } catch (error) {
      this.update(job, { stage: signal.aborted ? 'cancelled' : 'error', message: signal.aborted ? 'Đã hủy tác vụ.' : error instanceof Error ? error.message : String(error) });
    } finally {
      this.controllers.delete(job.id);
      if (published && !committed) await rm(published, { force: true }).catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
