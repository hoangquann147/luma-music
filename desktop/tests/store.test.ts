import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { safeStorage } from 'electron';
import { LibraryStore } from '../electron/main/store';

const environment = vi.hoisted(() => ({ directory: '', appDirectory: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => environment.appDirectory, getPath: (name: string) => name === 'userData' ? environment.directory : `${environment.directory}/Music` },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa7))),
    decryptString: vi.fn((value: Buffer) => Buffer.from(value.map(byte => byte ^ 0xa7)).toString()),
  },
}));
vi.mock('music-metadata', () => ({ parseFile: vi.fn() }));

const metadata = {
  common: { title: 'Bình minh', artist: 'Test artist', album: 'Test collection' },
  format: { duration: 120, sampleRate: 96000, bitsPerSample: 24, numberOfChannels: 2 },
};
const diskPath = () => path.join(environment.directory, 'library.json');
const readDisk = async () => JSON.parse(await fs.readFile(diskPath(), 'utf8')) as { tracks: { title: string; path: string }[]; settings: Record<string, unknown> };
async function fixture(name: string): Promise<string> {
  const target = path.join(environment.directory, `${name}.flac`);
  // This test isolates filesystem transactions; codec parsing is mocked above.
  await fs.writeFile(target, Buffer.from('fLaCtest-fixture'));
  return target;
}

beforeEach(async () => {
  // Keep filesystem fixtures inside the checkout, including sandboxed Windows runs.
  const testRoot = path.join(process.cwd(), 'node_modules', '.cache', 'luma-store-tests');
  await fs.mkdir(testRoot, { recursive: true });
  environment.directory = await fs.mkdtemp(path.join(testRoot, 'case-'));
  environment.appDirectory = environment.directory;
  vi.clearAllMocks();
  vi.stubEnv('SPOTIFY_CLIENT_ID', '');
  vi.stubEnv('SPOTIFY_CLIENT_SECRET', '');
  vi.stubEnv('SPOTIFY_MARKET', '');
  vi.stubEnv('YT_DLP_PATH', '');
  vi.stubEnv('FFMPEG_PATH', '');
  vi.mocked(parseFile).mockResolvedValue(metadata as Awaited<ReturnType<typeof parseFile>>);
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(environment.directory, { recursive: true, force: true });
});

describe('durable FLAC library', () => {
  it('keeps bundled tool settings valid across a portable extraction move', async () => {
    const oldApp = path.join(environment.directory, 'old-app');
    const newApp = path.join(environment.directory, 'new-app');
    const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    for (const app of [oldApp, newApp]) {
      await fs.mkdir(path.join(app, 'resources', 'tools'), { recursive: true });
      await fs.writeFile(path.join(app, 'resources', 'tools', executable), 'test placeholder');
    }
    environment.appDirectory = oldApp;
    const original = new LibraryStore(); await original.initialize();
    expect(original.publicSettings().ffmpegPath).toBe(path.join(oldApp, 'resources', 'tools', executable));
    await original.updateSettings({ ffmpegPath: original.publicSettings().ffmpegPath });
    expect((await readDisk()).settings.ffmpegPath).toBe('bundled');
    environment.appDirectory = newApp;
    const moved = new LibraryStore(); await moved.initialize();
    expect(moved.publicSettings().ffmpegPath).toBe(path.join(newApp, 'resources', 'tools', executable));
    expect(moved.publicSettings()).not.toHaveProperty('bundledToolsDirectory');
    const custom = path.join(environment.directory, 'custom-ffmpeg.exe');
    await moved.updateSettings({ ffmpegPath: custom });
    expect(moved.publicSettings().ffmpegPath).toBe(custom);
    vi.stubEnv('FFMPEG_PATH', path.join(environment.directory, 'environment-ffmpeg.exe'));
    expect(moved.publicSettings().ffmpegPath).toBe(path.join(environment.directory, 'environment-ffmpeg.exe'));
  });

  it('deduplicates simultaneous imports and preserves the source file on removal', async () => {
    const library = new LibraryStore(); await library.initialize();
    const file = await fixture('same-recording');
    const [first, second] = await Promise.all([library.addFile(file), library.addFile(file)]);
    expect(first.id).toBe(second.id);
    expect(library.list()).toHaveLength(1);
    expect(first).toMatchObject({ sampleRate: 96000, bitsPerSample: 24, channels: 2 });
    expect((await readDisk()).tracks).toHaveLength(1);
    const restored = new LibraryStore(); await restored.initialize();
    expect(restored.list()[0].id).toBe(first.id);
    await restored.remove(first.id);
    expect(await fs.readFile(file, 'utf8')).toBe('fLaCtest-fixture');
    expect((await readDisk()).tracks).toEqual([]);
  });

  it('does not resurrect a failed import when a concurrent import succeeds', async () => {
    const library = new LibraryStore(); await library.initialize();
    const files = await Promise.all([fixture('first'), fixture('second')]);
    const actualRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' })).mockImplementation(actualRename);
    const results = await Promise.allSettled(files.map(file => library.addFile(file)));
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const success = results.find(result => result.status === 'fulfilled');
    if (!success || success.status !== 'fulfilled') throw new Error('Expected one committed import');
    expect(library.list().map(track => track.id)).toEqual([success.value.id]);
    expect((await readDisk()).tracks.map(track => track.path)).toEqual([success.value.path]);
    expect((await fs.readdir(environment.directory)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('keeps the last durable settings and track when a later write fails', async () => {
    const library = new LibraryStore(); await library.initialize();
    const track = await library.addFile(await fixture('durable'));
    await library.updateSettings({ spotifyClientId: 'original-id' });
    const rename = vi.spyOn(fs, 'rename');
    rename.mockRejectedValueOnce(new Error('write denied'));
    await expect(library.remove(track.id)).rejects.toThrow('write denied');
    expect(library.list()[0].id).toBe(track.id);
    rename.mockRejectedValueOnce(new Error('write denied'));
    await expect(library.updateSettings({ spotifyClientId: 'uncommitted-id' })).rejects.toThrow('write denied');
    expect(library.publicSettings().spotifyClientId).toBe('original-id');
    expect((await readDisk()).settings.spotifyClientId).toBe('original-id');
  });

  it('protects stored credentials and never includes secrets in renderer settings', async () => {
    const library = new LibraryStore(); await library.initialize();
    const publicSettings = await library.updateSettings({ spotifyClientId: 'app-id', spotifyClientSecret: 'sensitive-value' });
    expect(safeStorage.encryptString).toHaveBeenCalledWith('sensitive-value');
    expect(publicSettings.spotifyConfigured).toBe(true);
    expect(publicSettings).not.toHaveProperty('spotifyClientSecret');
    expect(publicSettings).not.toHaveProperty('encryptedSpotifySecret');
    expect(await fs.readFile(diskPath(), 'utf8')).not.toContain('sensitive-value');
    const restored = new LibraryStore(); await restored.initialize();
    expect(restored.settings().spotifyClientSecret).toBe('sensitive-value');
    expect(restored.publicSettings()).not.toHaveProperty('spotifyClientSecret');
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
    await expect(restored.updateSettings({ spotifyClientSecret: 'new-secret' })).rejects.toThrow('kho khóa an toàn');
    expect((await readDisk()).settings.encryptedSpotifySecret).toBeDefined();
  });

  it('fails safely on a read permission error and preserves corrupted JSON before resetting', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('read denied'), { code: 'EACCES' }));
    await expect(new LibraryStore().initialize()).rejects.toThrow('Không đọc được thư viện');
    vi.restoreAllMocks();
    await fs.writeFile(diskPath(), '{broken library');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const library = new LibraryStore(); await library.initialize();
    const backup = (await fs.readdir(environment.directory)).find(name => name.startsWith('library.json.backup-'));
    expect(backup).toBeDefined();
    expect(await fs.readFile(path.join(environment.directory, backup!), 'utf8')).toBe('{broken library');
    expect(library.list()).toEqual([]);
  });
});
