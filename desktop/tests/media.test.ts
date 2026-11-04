import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LibraryStore } from '../electron/main/store';
const registered = vi.hoisted(() => ({ handler: undefined as undefined | ((request: Request) => Promise<Response>) }));
vi.mock('electron', () => ({ protocol: { handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => { registered.handler = handler; } } }));
import { registerMediaProtocol } from '../electron/main/media';
const id = '01234567-89ab-4cde-8fab-0123456789ab';
const url = `luma-media://track/${id}`;
let directory: string;
beforeAll(async () => {
  const cache = path.resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(path.join(cache, 'media-test-'));
  const file = path.join(directory, 'sample.flac');
  await writeFile(file, Buffer.from('fLaC0123456789'));
  registerMediaProtocol({ get: (key: string) => key === id ? { path: file } : undefined } as LibraryStore);
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
const request = (init?: RequestInit, target = url) => registered.handler!(new Request(target, init));
describe('library-only media protocol', () => {
  it('streams the original bytes without loading or changing the audio', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/flac');
    expect(await response.text()).toBe('fLaC0123456789');
  });
  it('serves byte-exact partial content for seeks', async () => {
    const response = await request({ headers: { Range: 'bytes=4-7' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 4-7/14');
    expect(response.headers.get('content-length')).toBe('4');
    expect(await response.text()).toBe('0123');
  });
  it('returns HEAD metadata with no audio body', async () => {
    const response = await request({ method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('14');
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });
  it('returns an explicit unsatisfiable range', async () => {
    const response = await request({ headers: { Range: 'bytes=14-' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */14');
  });
  it.each([
    'luma-media://track/00000000-0000-0000-0000-000000000000',
    'luma-media://track/C:/Windows/win.ini',
    'luma-media://other/01234567-89ab-4cde-8fab-0123456789ab',
  ])('never resolves arbitrary files or unknown library entries: %s', async target => expect((await request(undefined, target)).status).toBe(404));
  it('disallows writes', async () => expect((await request({ method: 'POST' })).status).toBe(405));
});
