import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';
import { Downloader } from '../electron/main/downloader';
import type { InternalSettings, LibraryStore } from '../electron/main/store';
import type { SpotifyMetadata } from '../shared/types';

const ffmpegPath = process.env.FFMPEG_TEST_PATH;
const execute = promisify(execFile);
type Converter = {
  convert(input: string, output: string, metadata: SpotifyMetadata, sourceUrl: string, cover: string | undefined, executable: string, signal: AbortSignal, progress: (percent: number) => void): Promise<void>;
};

// Opt in with a real FFmpeg binary and sibling ffprobe. No network or music
// downloads occur: every sample and image in this test is generated locally.
describe.skipIf(!ffmpegPath)('real FLAC conversion', () => {
  it('preserves 96 kHz / 24-bit stereo PCM and embeds Unicode tags and artwork', async () => {
    const root = path.join(process.cwd(), 'node_modules', '.cache', 'luma-conversion-tests');
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'case-'));
    try {
      const run = (args: string[]) => execute(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
      const raw = path.join(directory, 'synthetic.s24le');
      const input = path.join(directory, 'source.flac');
      const output = path.join(directory, 'converted.flac');
      const cover = path.join(directory, 'cover.png');
      // Deterministic full-range 24-bit stereo samples, 0.15 seconds long.
      const samples = Buffer.alloc(14_400 * 2 * 3);
      let state = 0x13579bdf;
      for (let offset = 0; offset < samples.length; offset += 3) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        samples.writeUIntLE(state >>> 8, offset, 3);
      }
      await fs.writeFile(raw, samples);
      await run(['-f', 's24le', '-ar', '96000', '-ac', '2', '-i', raw, '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', input]);
      await run(['-f', 'lavfi', '-i', 'color=c=0x5277a8:s=64x64:d=0.04', '-frames:v', '1', cover]);
      const metadata: SpotifyMetadata = {
        title: 'Bình minh dịu dàng', artist: 'Nghệ sĩ thử nghiệm', album: 'Những ngày yên bình',
        duration: 0.15, releaseDate: '2026-11-01', trackNumber: 3,
        spotifyUrl: 'https://open.spotify.com/track/0123456789ABCDEFGHIJKL',
      };
      const settings: InternalSettings = { downloadDirectory: directory, ytDlpPath: 'unused', ffmpegPath: ffmpegPath!, spotifyClientId: '', spotifyConfigured: false, spotifyMarket: 'VN' };
      const downloader = new Downloader(() => settings, {} as LibraryStore, () => undefined);
      await (downloader as unknown as Converter).convert(input, output, metadata, 'https://www.youtube.com/watch?v=abcdefghijk', cover, ffmpegPath!, new AbortController().signal, () => undefined);

      const result = await parseFile(output, { duration: true });
      expect(result.format).toMatchObject({ sampleRate: 96000, bitsPerSample: 24, numberOfChannels: 2 });
      expect(result.common).toMatchObject({ title: metadata.title, artist: metadata.artist, album: metadata.album, date: metadata.releaseDate, track: { no: 3 } });
      expect(result.common.picture).toHaveLength(1);
      expect(result.common.picture![0].format).toBe('image/png');
      expect(Buffer.from(result.common.picture![0].data)).toEqual(await fs.readFile(cover));

      // Re-decoding both FLAC files proves that adding metadata and artwork did
      // not resample, truncate, or otherwise change any source PCM sample.
      const decode = async (file: string, name: string) => {
        const decoded = path.join(directory, name);
        await run(['-i', file, '-map', '0:a:0', '-f', 's24le', '-c:a', 'pcm_s24le', decoded]);
        return createHash('sha256').update(await fs.readFile(decoded)).digest('hex');
      };
      expect(await decode(output, 'output.pcm')).toBe(await decode(input, 'input.pcm'));
      expect(await fs.readFile(path.join(directory, 'input.pcm'))).toEqual(samples);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }, 60_000);
});
