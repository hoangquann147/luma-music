import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DownloadJob, DownloadRequest, PlaylistBatch, SpotifyMatch, SpotifyMetadata, Track } from '../shared/types';
import { chooseSafeCandidate, PlaylistManager } from '../electron/main/playlists';

let directory: string;
beforeEach(async () => { const root = path.resolve('node_modules/.cache/luma-playlist-tests'); await fs.mkdir(root, { recursive: true }); directory = await fs.mkdtemp(path.join(root, 'case-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const metadata = (index: number, title = `Song ${index}`): SpotifyMetadata => ({ title, artist: 'Real Artist', album: 'Album', duration: 180, spotifyUrl: `https://open.spotify.com/track/${String(index).padStart(22, '0')}` });
function setup(automaticCompletion = true) {
  const locals: Track[] = []; const jobs = new Map<string, DownloadJob>(); const matches = new Map<string, SpotifyMetadata>(); const events: PlaylistBatch[] = [];
  let active = 0; let maximum = 0; let manager: PlaylistManager;
  const downloader = {
    listJobs: () => [...jobs.values()],
    prepareSpotifyMetadata: vi.fn(async (info: SpotifyMetadata, signal?: AbortSignal): Promise<SpotifyMatch> => {
      if (signal?.aborted) throw new Error('cancelled');
      const id = randomUUID(); matches.set(id, info);
      return { id, metadata: info, candidates: [{ id: 'abcdefghijk', title: info.title === 'Needs review' ? 'Wrong recording' : `Real Artist - ${info.title} (Official Audio)`, channel: 'Real Artist - Topic', duration: 180, url: 'https://www.youtube.com/watch?v=abcdefghijk' }] };
    }),
    start: vi.fn((request: DownloadRequest): DownloadJob => {
      const info = matches.get(request.spotifyMatchId!)!; const job: DownloadJob = { id: randomUUID(), url: request.url, title: info.title, stage: 'downloading', progress: 0, createdAt: new Date().toISOString() };
      jobs.set(job.id, job); active++; maximum = Math.max(maximum, active);
      if (automaticCompletion) setTimeout(() => {
        active--; job.stage = info.title === 'Failure' ? 'error' : 'completed'; job.message = info.title === 'Failure' ? 'Fixture failed' : 'Saved';
        if (job.stage === 'completed') { const track = { id: randomUUID(), spotifyUrl: info.spotifyUrl } as Track; locals.push(track); job.track = track; }
        void manager.handleDownload({ ...job });
      }, 10);
      return { ...job };
    }),
    cancel: vi.fn((id: string) => { const job = jobs.get(id)!; active--; job.stage = 'cancelled'; void manager.handleDownload({ ...job }); }),
  };
  manager = new PlaylistManager({ userDataDirectory: directory, library: { list: () => locals }, spotify: { playlist: async () => { throw new Error('No Spotify API should be called'); } }, downloader, onPlaylist: () => undefined, onBatch: batch => events.push(batch) });
  return { manager, downloader, locals, events, maximum: () => maximum };
}
async function file(manager: PlaylistManager, rows: SpotifyMetadata[]) {
  const filename = path.join(directory, 'list.json'); await fs.writeFile(filename, JSON.stringify(rows)); return manager.importFile(filename);
}

describe('playlist matching and queued downloads', () => {
  it('requires artist, duration and recording version agreement for automatic matching', () => {
    const info = metadata(1, 'Morning');
    const candidate = { id: 'abcdefghijk', title: 'Real Artist - Morning (Official Audio)', channel: 'Real Artist', duration: 181, url: 'https://www.youtube.com/watch?v=abcdefghijk' };
    expect(chooseSafeCandidate(info, [candidate])).toBe(candidate);
    expect(chooseSafeCandidate(info, [{ ...candidate, title: 'Real Artist - Morning Live' }])).toBeUndefined();
    expect(chooseSafeCandidate(info, [{ ...candidate, title: 'Other Artist - Morning', channel: 'Other Artist' }])).toBeUndefined();
    expect(chooseSafeCandidate(info, [{ ...candidate, duration: 230 }])).toBeUndefined();
    expect(chooseSafeCandidate({ ...info, duration: 0 }, [candidate])).toBeUndefined();
  });
  it('continues past item failures, flags uncertain matches, skips local tracks and maps successful downloads', async () => {
    const { manager, downloader, locals, maximum } = setup(); await manager.initialize();
    locals.push({ id: randomUUID(), spotifyUrl: metadata(4).spotifyUrl } as Track);
    const playlist = await file(manager, [metadata(1), metadata(2, 'Failure'), metadata(3, 'Needs review'), metadata(4)]);
    expect(playlist.tracks[3].localTrackId).toBe(locals[0].id);
    const batch = manager.start({ playlistId: playlist.id, entryIds: playlist.tracks.map(entry => entry.id), rightsConfirmed: true, autoMatchConfirmed: true });
    await vi.waitFor(() => expect(manager.listBatches()[0].stage).toBe('completed'));
    const final = manager.listBatches()[0]; expect(final).toMatchObject({ id: batch.id, completed: 2, failed: 1, reviewRequired: 1 });
    expect(downloader.start).toHaveBeenCalledTimes(2); expect(maximum()).toBeLessThanOrEqual(2);
    await manager.shutdown();
    const restored = setup().manager; await restored.initialize(); expect(restored.list()[0].tracks[0].metadata.spotifyUrl).toBe(metadata(1).spotifyUrl); await restored.shutdown();
  });
  it('cancels queued and active items without starting the next queued recording', async () => {
    const { manager, downloader } = setup(false); await manager.initialize();
    const playlist = await file(manager, [metadata(1), metadata(2), metadata(3), metadata(4)]);
    const batch = manager.start({ playlistId: playlist.id, entryIds: playlist.tracks.map(entry => entry.id), rightsConfirmed: true, autoMatchConfirmed: true });
    await vi.waitFor(() => expect(downloader.start).toHaveBeenCalledTimes(2));
    manager.cancel(batch.id); await manager.shutdown();
    expect(downloader.cancel).toHaveBeenCalledTimes(2); expect(downloader.start).toHaveBeenCalledTimes(2);
    expect(manager.listBatches()[0].items.every(item => item.stage === 'cancelled')).toBe(true);
    expect(manager.listBatches()[0].stage).toBe('cancelled');
  });
});
