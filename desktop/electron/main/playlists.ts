import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DownloadJob, PlaylistBatch, PlaylistBatchItem, PlaylistDownloadRequest, SourceCandidate, SpotifyMetadata, SpotifyPlaylist, Track } from '../../shared/types';
import type { Downloader } from './downloader';
import type { SpotifyClient } from './spotify';
import { spotifyTrackUrl } from './spotify';
import { parsePlaylistFile } from './playlist-files';

type DownloaderPort = Pick<Downloader, 'prepareSpotifyMetadata' | 'start' | 'cancel' | 'listJobs'>;
const terminal = (job: DownloadJob) => ['completed', 'error', 'cancelled'].includes(job.stage);
const normalize = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function chooseSafeCandidate(metadata: SpotifyMetadata, candidates: SourceCandidate[]): SourceCandidate | undefined {
  if (!(metadata.duration > 0)) return undefined;
  const title = normalize(metadata.title); const artist = normalize(metadata.artist.split(/,|;| feat\.? | ft\.? /i)[0]);
  const versions = ['live', 'remix', 'cover', 'karaoke', 'instrumental', 'slowed', 'nightcore', 'sped up', 'acoustic', 'remaster'];
  const tokens = title.split(' ').filter(Boolean);
  const permitted = new Set([...tokens, ...artist.split(' '), 'official', 'audio', 'video', 'music', 'lyrics', 'lyric', 'hd', 'hq', '4k', 'visualizer', 'topic', 'vevo']);
  if (!tokens.length || !artist) return undefined;
  return candidates.filter(candidate => {
    const candidateTitle = normalize(candidate.title); const combined = normalize(`${candidate.title} ${candidate.channel}`);
    if (!(candidate.duration > 0) || Math.abs(candidate.duration - metadata.duration) > Math.min(8, Math.max(3, metadata.duration * 0.02))) return false;
    if (!artist.split(' ').every(token => combined.split(' ').includes(token))) return false;
    if (!tokens.every(token => candidateTitle.split(' ').includes(token))) return false;
    if (candidateTitle.split(' ').some(token => !permitted.has(token))) return false;
    return versions.every(version => new RegExp(`\\b${version}\\b`).test(candidateTitle) === new RegExp(`\\b${version}\\b`).test(title));
  }).sort((a, b) => Math.abs(a.duration - metadata.duration) - Math.abs(b.duration - metadata.duration))[0];
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('Đã hủy.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}

export class PlaylistManager {
  private playlists: SpotifyPlaylist[] = [];
  private readonly batches = new Map<string, PlaylistBatch>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: { batch: PlaylistBatch; item: PlaylistBatchItem }[] = [];
  private readonly executions = new Set<Promise<void>>();
  private readonly waiters = new Map<string, (job: DownloadJob) => void>();
  private pendingWrite: Promise<void> = Promise.resolve();
  private closing = false;
  private readonly imports = new Map<AbortController, Promise<SpotifyPlaylist>>();
  private readonly filename: string;
  constructor(private readonly options: { userDataDirectory: string; library: { list(): Track[] }; spotify: Pick<SpotifyClient, 'playlist'>; downloader: DownloaderPort; onPlaylist: (playlist: SpotifyPlaylist) => void; onBatch: (batch: PlaylistBatch) => void }) {
    this.filename = path.join(options.userDataDirectory, 'playlists.json');
  }
  async initialize(): Promise<void> {
    let text: string;
    try { text = await fs.readFile(this.filename, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const parsed = JSON.parse(text) as { version: number; playlists: SpotifyPlaylist[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.playlists)) throw new Error('Dữ liệu playlist không hợp lệ.');
    this.playlists = parsed.playlists;
    await this.reconcile();
  }
  list(): SpotifyPlaylist[] { return structuredClone(this.playlists); }
  listBatches(): PlaylistBatch[] { return structuredClone([...this.batches.values()]); }
  findMetadata(url: string): SpotifyMetadata | undefined {
    const canonical = spotifyTrackUrl(url); return structuredClone(this.playlists.flatMap(list => list.tracks).find(entry => entry.metadata.spotifyUrl === canonical)?.metadata);
  }
  private commit(change: (next: SpotifyPlaylist[]) => void): Promise<void> {
    const operation = this.pendingWrite.then(async () => {
      const next = structuredClone(this.playlists); change(next);
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify({ version: 1, playlists: next }, null, 2), { mode: 0o600 }); await fs.rename(temporary, this.filename); this.playlists = next; }
      finally { await fs.unlink(temporary).catch(() => undefined); }
    });
    this.pendingWrite = operation.catch(() => undefined); return operation;
  }
  async reconcile(): Promise<void> {
    const local = new Map(this.options.library.list().filter(track => track.spotifyUrl).map(track => [track.spotifyUrl!, track.id]));
    await this.commit(next => { for (const playlist of next) for (const entry of playlist.tracks) entry.localTrackId = local.get(entry.metadata.spotifyUrl); });
    for (const playlist of this.playlists) this.options.onPlaylist(structuredClone(playlist));
  }
  private async save(playlist: SpotifyPlaylist): Promise<SpotifyPlaylist> {
    await this.commit(next => {
      const previous = playlist.url ? next.find(item => item.url === playlist.url) : undefined;
      if (previous) {
        playlist.id = previous.id;
        const entries = new Map(previous.tracks.map(entry => [entry.metadata.spotifyUrl, entry.id]));
        for (const entry of playlist.tracks) entry.id = entries.get(entry.metadata.spotifyUrl) || entry.id;
        next.splice(next.indexOf(previous), 1, playlist);
      } else next.push(playlist);
      const local = new Map(this.options.library.list().filter(track => track.spotifyUrl).map(track => [track.spotifyUrl!, track.id]));
      for (const entry of playlist.tracks) entry.localTrackId = local.get(entry.metadata.spotifyUrl);
    });
    this.options.onPlaylist(structuredClone(playlist)); return structuredClone(playlist);
  }
  importSpotify(url: string): Promise<SpotifyPlaylist> {
    if (this.closing) return Promise.reject(new Error('Ứng dụng đang đóng.'));
    const controller = new AbortController();
    const task = this.options.spotify.playlist(url, controller.signal).then(playlist => {
      if (controller.signal.aborted || this.closing) throw new Error('Đã hủy nhập playlist.');
      return this.save(playlist);
    });
    this.imports.set(controller, task);
    void task.finally(() => this.imports.delete(controller)).catch(() => undefined);
    return task;
  }
  async importFile(file: string): Promise<SpotifyPlaylist> {
    if (this.closing) throw new Error('Ứng dụng đang đóng.');
    const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('File playlist phải nhỏ hơn 5 MB.');
    return this.save(parsePlaylistFile(await fs.readFile(file), path.basename(file)));
  }
  start(request: PlaylistDownloadRequest): PlaylistBatch {
    if (this.closing) throw new Error('Ứng dụng đang đóng.');
    if (request.rightsConfirmed !== true || request.autoMatchConfirmed !== true) throw new Error('Hãy xác nhận quyền tải và việc tự ghép nguồn YouTube cho các bài đã chọn.');
    const playlist = this.playlists.find(item => item.id === request.playlistId);
    if (!playlist) throw new Error('Không tìm thấy playlist.');
    if ([...this.batches.values()].some(batch => batch.playlistId === playlist.id && batch.stage === 'running')) throw new Error('Playlist này đang được tải. Hãy chờ hoặc hủy tác vụ trước.');
    const entries = [...new Set(request.entryIds)];
    if (!entries.length || entries.length > 10_000 || entries.some(id => !playlist.tracks.some(entry => entry.id === id))) throw new Error('Danh sách bài được chọn không hợp lệ.');
    const batch: PlaylistBatch = { id: randomUUID(), playlistId: playlist.id, stage: 'running', total: entries.length, completed: 0, failed: 0, reviewRequired: 0, items: entries.map(entryId => ({ entryId, stage: 'queued' })) };
    this.batches.set(batch.id, batch); this.controllers.set(batch.id, new AbortController());
    for (const item of batch.items) this.queue.push({ batch, item });
    this.emit(batch); this.pump(); return structuredClone(batch);
  }
  private emit(batch: PlaylistBatch): void {
    batch.completed = batch.items.filter(item => item.stage === 'completed').length;
    batch.failed = batch.items.filter(item => item.stage === 'error').length;
    batch.reviewRequired = batch.items.filter(item => item.stage === 'needs-review').length;
    if (batch.stage === 'running' && batch.items.every(item => ['completed', 'error', 'needs-review', 'cancelled'].includes(item.stage))) { batch.stage = 'completed'; this.controllers.delete(batch.id); }
    this.options.onBatch(structuredClone(batch));
  }
  private pump(): void {
    while (!this.closing && this.executions.size < 2 && this.queue.length) {
      const next = this.queue.shift()!;
      const execution = this.run(next.batch, next.item).finally(() => { this.executions.delete(execution); this.pump(); });
      this.executions.add(execution); void execution.catch(error => console.error('Playlist task failed:', error));
    }
  }
  private async run(batch: PlaylistBatch, item: PlaylistBatchItem): Promise<void> {
    const signal = this.controllers.get(batch.id)?.signal;
    if (!signal || signal.aborted) { item.stage = 'cancelled'; this.emit(batch); return; }
    try {
      const entry = this.playlists.find(playlist => playlist.id === batch.playlistId)?.tracks.find(track => track.id === item.entryId);
      if (!entry) throw new Error('Bài hát không còn trong playlist.');
      if (this.options.library.list().some(track => track.spotifyUrl === entry.metadata.spotifyUrl)) { item.stage = 'completed'; item.message = 'Đã có trong Library; bỏ qua tải lại.'; this.emit(batch); return; }
      // Do not consume the source-choice cache lifetime while unrelated manual
      // downloads occupy both slots. Check capacity again after resolution too.
      while (this.options.downloader.listJobs().filter(job => !terminal(job)).length >= 2 || this.options.downloader.listJobs().some(job => !terminal(job) && job.url === entry.metadata.spotifyUrl)) await abortableDelay(200, signal);
      if (signal.aborted) throw new Error('Đã hủy.');
      item.stage = 'resolving'; this.emit(batch);
      const match = await this.options.downloader.prepareSpotifyMetadata(entry.metadata, signal);
      if (signal.aborted) throw new Error('Đã hủy.');
      const candidate = chooseSafeCandidate(entry.metadata, match.candidates);
      if (!candidate) { item.stage = 'needs-review'; item.message = 'Chưa có nguồn khớp tên, nghệ sĩ và thời lượng. Chọn nguồn thủ công trong Downloader.'; this.emit(batch); return; }
      while (this.options.downloader.listJobs().filter(job => !terminal(job)).length >= 2 || this.options.downloader.listJobs().some(job => !terminal(job) && job.url === entry.metadata.spotifyUrl)) await abortableDelay(200, signal);
      if (signal.aborted) throw new Error('Đã hủy.');
      if (this.options.library.list().some(track => track.spotifyUrl === entry.metadata.spotifyUrl)) { item.stage = 'completed'; item.message = 'Đã có trong Library; bỏ qua tải lại.'; this.emit(batch); return; }
      const job = this.options.downloader.start({ url: entry.metadata.spotifyUrl, spotifyMatchId: match.id, candidateId: candidate.id, rightsConfirmed: true });
      item.jobId = job.id; item.stage = 'downloading'; this.emit(batch);
      const final = await this.waitForJob(job.id, signal);
      item.stage = final.stage === 'completed' ? 'completed' : final.stage === 'cancelled' ? 'cancelled' : 'error'; item.message = final.message;
    } catch (error) { item.stage = signal.aborted ? 'cancelled' : 'error'; item.message = signal.aborted ? 'Đã hủy.' : (error as Error).message; }
    this.emit(batch);
  }
  private waitForJob(id: string, signal: AbortSignal): Promise<DownloadJob> {
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiters.delete(id); reject(new Error('Đã hủy.')); };
      const done = (job: DownloadJob) => { signal.removeEventListener('abort', abort); this.waiters.delete(id); resolve(job); };
      this.waiters.set(id, done); signal.addEventListener('abort', abort, { once: true });
      const existing = this.options.downloader.listJobs().find(job => job.id === id && terminal(job));
      if (existing) done(existing); else if (signal.aborted) abort();
    });
  }
  async handleDownload(job: DownloadJob): Promise<void> {
    if (terminal(job)) this.waiters.get(job.id)?.(job);
    if (job.stage === 'completed' && job.track?.spotifyUrl) await this.reconcile();
  }
  cancel(id: string): void {
    const batch = this.batches.get(id); if (!batch) throw new Error('Không tìm thấy tác vụ playlist.');
    if (batch.stage !== 'running') return;
    batch.stage = 'cancelled'; this.controllers.get(id)?.abort(); this.controllers.delete(id);
    for (let index = this.queue.length - 1; index >= 0; index--) if (this.queue[index].batch.id === id) this.queue.splice(index, 1);
    for (const item of batch.items) {
      if (!['completed', 'error', 'needs-review'].includes(item.stage)) { if (item.jobId) this.options.downloader.cancel(item.jobId); item.stage = 'cancelled'; }
    }
    this.emit(batch);
  }
  async shutdown(): Promise<void> {
    this.closing = true; for (const batch of this.batches.values()) if (batch.stage === 'running') this.cancel(batch.id);
    for (const controller of this.imports.keys()) controller.abort();
    await Promise.allSettled([...this.executions, ...this.imports.values()]); await this.pendingWrite;
  }
}
