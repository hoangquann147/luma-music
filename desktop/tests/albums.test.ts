import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LibraryStore } from '../electron/main/store';
import { ALBUM_MARKER, checksum, inside, retireCopy, ROOT_MARKER } from '../electron/main/managed-library';

const env = vi.hoisted(() => ({ root: '', metadata: new Map<string, { title: string; artist: string; album?: string; albumartist?: string }>() }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => path.join(env.root, 'app'), getPath: (name: string) => path.join(env.root, name === 'userData' ? 'profile' : 'Music') },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('music-metadata', () => ({ parseFile: vi.fn(async (filename: string) => ({ common: env.metadata.get(filename) || {}, format: { duration: 60, sampleRate: 96000, bitsPerSample: 24, numberOfChannels: 2 } })) }));
let store: LibraryStore;
async function fixture(name: string, metadata: { title?: string; artist?: string; album?: string; albumartist?: string } = {}): Promise<string> {
  const filename = path.join(env.root, 'originals', name + '.flac'); await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, Buffer.from('fLaC' + name + '-untouched-original'));
  env.metadata.set(filename, { title: metadata.title || name, artist: metadata.artist || 'Track artist', ...metadata }); return filename;
}
beforeEach(async () => {
  const root = path.resolve('node_modules/.cache/album-tests'); await fs.mkdir(root, { recursive: true });
  env.root = await fs.realpath(await fs.mkdtemp(path.join(root, 'case-'))); env.metadata.clear(); store = new LibraryStore(); await store.initialize();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(env.root, { recursive: true, force: true }); });

describe('managed album folders', () => {
  it('groups embedded album title plus album artist, copies without losing any original bytes and handles identical titles', async () => {
    const first = await fixture('one', { title: 'Same title', artist: 'Singer A', album: 'A/B: tuyển tập', albumartist: 'Various Artists' });
    const second = await fixture('two', { title: 'Same title', artist: 'Singer B', album: 'A/B: tuyển tập', albumartist: 'Various Artists' });
    const third = await fixture('three', { album: 'A/B: tuyển tập', albumartist: 'Other band' });
    const tracks = await Promise.all([store.addFile(first), store.addFile(second), store.addFile(third)]);
    expect(tracks[0].albumId).toBe(tracks[1].albumId); expect(tracks[2].albumId).not.toBe(tracks[0].albumId);
    expect(store.listAlbums().map(album => album.trackCount).sort()).toEqual([1,2]);
    expect(tracks[0].path).not.toBe(tracks[1].path);
    const root = store.publicSettings().libraryDirectory!;
    for (const [index, original] of [first,second,third].entries()) {
      expect(inside(root, tracks[index].path)).toBe(true); expect(path.dirname(path.dirname(tracks[index].path))).toBe(root);
      expect(await fs.readFile(tracks[index].path)).toEqual(await fs.readFile(original)); expect(tracks[index].originalPath).toBe(original);
    }
    const restored = new LibraryStore(); await restored.initialize(); expect(restored.listAlbums()).toEqual(store.listAlbums());
  });

  it('creates a real empty album, manually assigns tracks, cleans only previous managed copies and keeps deduplication stable', async () => {
    const original = await fixture('source', { album: 'Original album' }), track = await store.addFile(original);
    const album = await store.createAlbum({ name: '../CON: Nhạc của tôi?', artist: 'Nghệ sĩ' });
    const directory = path.join(store.publicSettings().libraryDirectory!, album.folder);
    expect((await fs.stat(directory)).isDirectory()).toBe(true); expect(album.trackCount).toBe(0);
    const result = await store.assignAlbum({ albumId: album.id, trackIds: [track.id, track.id] });
    expect(result.failed).toEqual([]); expect(result.copied).toBe(1);
    const assigned = store.get(track.id)!; expect(assigned.album).toBe(album.name); expect(path.dirname(assigned.path)).toBe(directory);
    expect(await fs.readFile(assigned.path)).toEqual(await fs.readFile(original));
    await expect(fs.stat(track.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.addFile(original)).id).toBe(track.id); expect(store.list()).toHaveLength(1);
    await store.remove(track.id); expect((await fs.stat(original)).isFile()).toBe(true); expect((await fs.stat(assigned.path)).isFile()).toBe(true);
  });

  it('leaves legacy paths unchanged at startup, then consolidates valid tracks while reporting missing files', async () => {
    const original = await fixture('legacy'), missing = path.join(env.root, 'missing.flac');
    const common = { title: 'Legacy', artist: 'Artist', album: 'Local collection', duration: 60, sampleRate: 96000, bitsPerSample: 24, channels: 2, addedAt: new Date().toISOString(), source: 'local' };
    await fs.mkdir(path.join(env.root, 'profile'), { recursive: true });
    await fs.writeFile(path.join(env.root, 'profile/library.json'), JSON.stringify({ version: 1, settings: { downloadDirectory: path.join(env.root, 'downloads') }, tracks: [{ ...common, id: '11111111-1111-4111-8111-111111111111', path: original }, { ...common, id: '22222222-2222-4222-8222-222222222222', path: missing }] }));
    store = new LibraryStore(); await store.initialize(); expect(store.list()[0].path).toBe(original); expect(store.listAlbums()).toHaveLength(1); expect(store.listAlbums()[0].name).toBe('Chưa phân album');
    const result = await store.consolidateLibrary(); expect(result.copied).toBe(1); expect(result.failed).toHaveLength(1);
    expect(store.list()[0].managed).toBe(true); expect(store.list()[1].path).toBe(missing); expect((await fs.stat(original)).isFile()).toBe(true);
  });

  it('relocates to a newly chosen root only on explicit consolidation, preserving the imported source', async () => {
    const original = await fixture('relocate', { album: 'Album' }), track = await store.addFile(original), selected = path.join(env.root, 'new-library');
    await store.updateSettings({ libraryDirectory: selected }); expect(store.get(track.id)?.path).toBe(track.path);
    const result = await store.consolidateLibrary(); expect(result.failed).toEqual([]); expect(result.copied).toBe(1);
    expect(inside(selected, store.get(track.id)!.path)).toBe(true); expect(await fs.readFile(original)).toEqual(await fs.readFile(store.get(track.id)!.path));
    await expect(fs.stat(track.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recognizes a legacy compilation album artist only on explicit consolidation and merges the old split groups', async () => {
    const first = await fixture('compilation-a', { artist: 'Singer A', album: 'Compilation', albumartist: 'Various Artists' });
    const second = await fixture('compilation-b', { artist: 'Singer B', album: 'Compilation', albumartist: 'Various Artists' });
    const common = { title: 'Legacy', album: 'Compilation', duration: 60, sampleRate: 96000, bitsPerSample: 24, channels: 2, addedAt: new Date().toISOString(), source: 'local' };
    await fs.mkdir(path.join(env.root, 'profile'), { recursive: true });
    await fs.writeFile(path.join(env.root, 'profile/library.json'), JSON.stringify({ version: 1, settings: {}, tracks: [{ ...common, id: '11111111-1111-4111-8111-111111111111', path: first, artist: 'Singer A' }, { ...common, id: '22222222-2222-4222-8222-222222222222', path: second, artist: 'Singer B' }] }));
    store = new LibraryStore(); await store.initialize(); expect(store.listAlbums()).toHaveLength(2); expect(store.list()[0].path).toBe(first);
    const result = await store.consolidateLibrary(); expect(result.failed).toEqual([]); expect(result.copied).toBe(2);
    expect(store.listAlbums()).toHaveLength(1); expect(store.listAlbums()[0]).toMatchObject({ name: 'Compilation', artist: 'Various Artists', trackCount: 2 });
    expect(store.list()[0].albumId).toBe(store.list()[1].albumId); expect(path.dirname(store.list()[0].path)).toBe(path.dirname(store.list()[1].path));
    expect((await fs.stat(first)).isFile()).toBe(true); expect((await fs.stat(second)).isFile()).toBe(true);
  });

  it('retains cached legacy album metadata when the source no longer contains an album tag', async () => {
    const original = await fixture('untagged'), common = { id: '11111111-1111-4111-8111-111111111111', title: 'Legacy', album: 'Saved album', artist: 'Saved artist', path: original, duration: 60, sampleRate: 96000, bitsPerSample: 24, channels: 2, addedAt: new Date().toISOString(), source: 'local' };
    await fs.mkdir(path.join(env.root, 'profile'), { recursive: true }); await fs.writeFile(path.join(env.root, 'profile/library.json'), JSON.stringify({ version: 1, settings: {}, tracks: [common] }));
    store = new LibraryStore(); await store.initialize(); const result = await store.consolidateLibrary(); expect(result.failed).toEqual([]);
    expect(store.listAlbums()[0]).toMatchObject({ name: 'Saved album', artist: 'Saved artist', trackCount: 1 });
  });

  it('rolls back a failed durable album assignment without deleting the previous playable copy', async () => {
    const original = await fixture('durable', { album: 'Existing' }), track = await store.addFile(original);
    const target = await store.createAlbum({ name: 'Target' }), targetDirectory = path.join(store.publicSettings().libraryDirectory!, target.folder);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.assignAlbum({ albumId: target.id, trackIds: [track.id] })).rejects.toThrow('disk full');
    expect(store.get(track.id)?.path).toBe(track.path); expect((await fs.stat(track.path)).isFile()).toBe(true);
    expect((await fs.readdir(targetDirectory)).filter(name => name !== ALBUM_MARKER)).toEqual([]);
  });

  it('refuses foreign folder collisions and never retires a modified file or an external original', async () => {
    const original = await fixture('guard', { album: 'Existing' }), track = await store.addFile(original);
    const album = store.listAlbums()[0], root = store.publicSettings().libraryDirectory!, hash = await checksum(track.path);
    await fs.appendFile(track.path, 'user edit');
    expect(await retireCopy({ path: track.path, root, albumId: album.id, trackId: track.id, sha256: hash })).toBe(false);
    expect(await retireCopy({ path: original, root, albumId: album.id, trackId: track.id, sha256: await checksum(original) })).toBe(false);
    expect((await fs.stat(track.path)).isFile()).toBe(true); expect((await fs.stat(original)).isFile()).toBe(true);
    const marker = path.join(path.dirname(track.path), ALBUM_MARKER); await fs.unlink(marker);
    const nextFile = await fixture('foreign', { album: 'Existing' }); await expect(store.addFile(nextFile)).rejects.toThrow(); expect(store.list()).toHaveLength(1);
    expect((await fs.stat(path.join(root, ROOT_MARKER))).isFile()).toBe(true);
  });

  it('rejects invalid IDs and unsafe configured locations without changing the library', async () => {
    await expect(store.createAlbum({ name: ' ' })).rejects.toThrow('không hợp lệ');
    await expect(store.assignAlbum({ albumId: '../bad', trackIds: [] })).rejects.toThrow('không hợp lệ');
    await expect(store.updateSettings({ libraryDirectory: 'relative/folder' })).rejects.toThrow('thư mục nhạc riêng');
    await expect(store.updateSettings({ libraryDirectory: path.join(env.root, 'profile/private') })).rejects.toThrow('thư mục nhạc riêng');
    expect(store.list()).toEqual([]);
  });
});
