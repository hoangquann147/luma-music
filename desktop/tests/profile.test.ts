import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { ProfileStore } from '../electron/main/profile';

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: vi.fn() } }));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
let directory: string;
let resize: ReturnType<typeof vi.fn>;
let encoded: { toPNG: ReturnType<typeof vi.fn>; toJPEG: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  const root = path.resolve('node_modules/.cache/luma-profile-tests'); await fs.mkdir(root, { recursive: true }); directory = await fs.mkdtemp(path.join(root, 'case-'));
  vi.clearAllMocks();
  encoded = { toPNG: vi.fn(() => png), toJPEG: vi.fn(() => Buffer.from([255, 216, 255, 217])) };
  resize = vi.fn(() => encoded);
  vi.mocked(nativeImage.createFromBuffer).mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 800, height: 400 }), resize, ...encoded } as unknown as ReturnType<typeof nativeImage.createFromBuffer>);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
const stored = async () => JSON.parse(await fs.readFile(path.join(directory, 'profile.json'), 'utf8')) as { version: number; name: string; avatarDataUrl?: string };
async function photo(name = 'avatar.png', contents = png): Promise<string> { const filename = path.join(directory, name); await fs.writeFile(filename, contents); return filename; }

describe('local Luma profile persistence', () => {
  it('saves trimmed Unicode names and a bounded natural-aspect avatar across restarts', async () => {
    const profile = new ProfileStore(directory); await profile.initialize();
    expect(profile.get()).toEqual({ name: 'Luma Listener' });
    expect(await profile.saveName('  Nguyễn Ánh 🌷  ')).toEqual({ name: 'Nguyễn Ánh 🌷' });
    const selected = await photo(); const result = await profile.choosePhoto(selected);
    expect(resize).toHaveBeenCalledWith({ width: 256, height: 128, quality: 'best' });
    expect(result.name).toBe('Nguyễn Ánh 🌷'); expect(result.avatarDataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(Buffer.byteLength(result.avatarDataUrl!)).toBeLessThanOrEqual(512 * 1024);
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(await stored()).toEqual({ version: 1, ...result });
    const restored = new ProfileStore(directory); await restored.initialize(); expect(restored.get()).toEqual(result);
    const returned = restored.get(); returned.name = 'Changed in renderer'; expect(restored.get().name).toBe('Nguyễn Ánh 🌷');
  });
  it('preserves simultaneous name and photo changes and keeps the avatar on later name saves', async () => {
    const profile = new ProfileStore(directory); await profile.initialize(); const filename = await photo();
    await Promise.all([profile.choosePhoto(filename), profile.saveName('New listener')]);
    expect(profile.get().name).toBe('New listener'); expect(profile.get().avatarDataUrl).toBeDefined();
    const avatar = profile.get().avatarDataUrl;
    await profile.saveName('Another name'); expect(profile.get().avatarDataUrl).toBe(avatar);
    expect(await stored()).toEqual({ version: 1, ...profile.get() });
    expect((await fs.readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
  });
  it('does not publish a failed save or poison the following queued change', async () => {
    const profile = new ProfileStore(directory); await profile.initialize(); await profile.saveName('Durable listener');
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full')).mockImplementation(rename);
    const results = await Promise.allSettled([profile.saveName('Failed listener'), profile.saveName('Committed listener')]);
    expect(results[0].status).toBe('rejected'); expect(results[1].status).toBe('fulfilled');
    expect(profile.get().name).toBe('Committed listener'); expect((await stored()).name).toBe('Committed listener');
  });
  it('rejects invalid names, SVG, disguised files, oversized input and decoder failures', async () => {
    const profile = new ProfileStore(directory); await profile.initialize();
    await expect(profile.saveName(' \t ')).rejects.toThrow();
    await expect(profile.saveName('x'.repeat(81))).rejects.toThrow('80');
    await expect(profile.saveName('Name\nNew line')).rejects.toThrow('điều khiển');
    await expect(profile.saveName('🌷'.repeat(80))).resolves.toMatchObject({ name: '🌷'.repeat(80) });
    await expect(profile.choosePhoto(await photo('picture.svg', Buffer.from('<svg/>')))).rejects.toThrow('PNG');
    await expect(profile.choosePhoto(await photo('disguised.png', Buffer.from('<svg/>')))).rejects.toThrow('hợp lệ');
    await expect(profile.choosePhoto(await photo('too-large.jpg', Buffer.alloc(5 * 1024 * 1024 + 1)))).rejects.toThrow('5 MB');
    vi.mocked(nativeImage.createFromBuffer).mockReturnValueOnce({ isEmpty: () => true } as ReturnType<typeof nativeImage.createFromBuffer>);
    await expect(profile.choosePhoto(await photo('broken.png'))).rejects.toThrow('giải mã');
    expect(profile.get().avatarDataUrl).toBeUndefined();
  });
  it('never stores an encoder result above the data URL budget', async () => {
    const profile = new ProfileStore(directory); await profile.initialize();
    encoded.toPNG.mockReturnValue(Buffer.alloc(512 * 1024)); encoded.toJPEG.mockReturnValue(Buffer.alloc(512 * 1024));
    await expect(profile.choosePhoto(await photo())).rejects.toThrow('512 KB');
    expect(profile.get().avatarDataUrl).toBeUndefined(); await expect(fs.stat(path.join(directory, 'profile.json'))).rejects.toThrow();
  });
  it('backs up corrupt JSON and refuses to replace an unreadable profile', async () => {
    const filename = path.join(directory, 'profile.json'); await fs.writeFile(filename, '{corrupt profile');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const profile = new ProfileStore(directory); await profile.initialize();
    const backup = (await fs.readdir(directory)).find(name => name.startsWith('profile.json.backup-'))!;
    expect(backup).toBeDefined(); expect(await fs.readFile(path.join(directory, backup), 'utf8')).toBe('{corrupt profile');
    await profile.saveName('Recovered'); expect((await stored()).name).toBe('Recovered');
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('read denied'), { code: 'EACCES' }));
    await expect(new ProfileStore(directory).initialize()).rejects.toThrow('Không đọc được hồ sơ');
    expect((await stored()).name).toBe('Recovered');
  });
});
