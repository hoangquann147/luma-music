import { describe, expect, it } from 'vitest';
import { downloadRequest, parseByteRange, parseSourceUrl, safeFilename, settingsUpdate, trackId } from '../electron/main/validation';

describe('source URL boundary', () => {
  it.each([
    'https://youtu.be/abcdefghijk?si=123',
    'https://music.youtube.com/watch?v=abcdefghijk&list=ignored',
    'https://www.youtube.com/shorts/abcdefghijk',
  ])('canonicalizes a single YouTube recording: %s', input => {
    expect(parseSourceUrl(input)).toEqual({ kind: 'youtube', id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  });
  it('accepts localized Spotify track URLs and removes tracking', () => {
    expect(parseSourceUrl('https://open.spotify.com/intl-vi/track/0123456789ABCDEFGHIJKL?si=secret').url).toBe('https://open.spotify.com/track/0123456789ABCDEFGHIJKL');
  });
  it.each([
    'file:///C:/Windows/win.ini', 'http://youtube.com/watch?v=abcdefghijk',
    'https://youtube.com.attacker.example/watch?v=abcdefghijk',
    'https://youtube.com@127.0.0.1/watch?v=abcdefghijk',
    'https://user:secret@youtube.com/watch?v=abcdefghijk',
    'https://youtube.com:444/watch?v=abcdefghijk',
    'https://youtube.com/playlist?list=PL123', 'https://youtu.be/too-short',
    'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL',
    '--exec cmd.exe',
  ])('rejects unsafe or unsupported input: %s', input => expect(() => parseSourceUrl(input)).toThrow());
  it('requires explicit rights and validates opaque IDs', () => {
    expect(() => downloadRequest({ url: 'https://youtu.be/abcdefghijk', rightsConfirmed: false })).toThrow();
    expect(() => downloadRequest({ url: 'https://youtu.be/abcdefghijk', rightsConfirmed: true, spotifyMatchId: '../../x' })).toThrow();
    expect(() => trackId('../path.flac')).toThrow();
  });
});

describe('range requests for audio seeking', () => {
  it('serves a full response without range', () => expect(parseByteRange(null, 100)).toBeUndefined());
  it.each([
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=20-', 100, { start: 20, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=-200', 100, { start: 0, end: 99 }],
    ['bytes=99-999', 100, { start: 99, end: 99 }],
  ] as const)('supports %s', (range, size, expected) => expect(parseByteRange(range, size)).toEqual(expected));
  it.each(['bytes=100-', 'bytes=8-2', 'bytes=-0', 'bytes=-', 'bytes=0-4,6-9', 'items=0-1', 'bytes=9007199254740993-'])('rejects invalid/unsatisfiable %s', header => expect(() => parseByteRange(header, 100)).toThrow());
  it('rejects a range against an empty file', () => expect(() => parseByteRange('bytes=0-', 0)).toThrow());
});

describe('settings and Windows output names', () => {
  it('rejects relative destinations and malformed markets', () => {
    expect(() => settingsUpdate({ downloadDirectory: '../music' })).toThrow();
    expect(() => settingsUpdate({ libraryDirectory: '../albums' })).toThrow();
    expect(() => settingsUpdate({ libraryDirectory: '' })).toThrow();
    expect(() => settingsUpdate({ spotifyMarket: 'Vietnam' })).toThrow();
    expect(() => settingsUpdate({ ffmpegPath: '' })).toThrow();
    expect(settingsUpdate({ spotifyMarket: 'vn' }).spotifyMarket).toBe('VN');
  });
  it('sanitizes reserved names and path separators without losing Vietnamese', () => {
    expect(safeFilename('CON')).not.toBe('CON');
    expect(safeFilename('Nắng / mưa: bản gốc. ')).toBe('Nắng _ mưa_ bản gốc');
    expect(safeFilename('a'.repeat(300)).length).toBeLessThanOrEqual(130);
  });
});
