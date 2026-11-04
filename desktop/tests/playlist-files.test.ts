import { describe, expect, it } from 'vitest';
import { parseCsv, parsePlaylistFile } from '../electron/main/playlist-files';

describe('Spotify playlist CSV and JSON imports', () => {
  it('reads quoted commas, escaped quotes, Unicode, multiline cells, BOM and canonical duplicates', () => {
    const csv = '\uFEFFTrack URI,Track Name,Artist Name(s),Album Name,Duration (ms)\r\nspotify:track:1111111111111111111111,"Bình minh, \"\"dịu dàng\"\"","Nghệ sĩ","Album\nSecond line",180000\r\nhttps://open.spotify.com/track/1111111111111111111111?si=x,Duplicate,Artist,Album,180000\r\nspotify:local:Artist:Album:Song,Local,Artist,Album,1000';
    const result = parsePlaylistFile(Buffer.from(csv), 'My playlist.csv');
    expect(result.tracks).toHaveLength(1); expect(result.skipped).toBe(2); expect(result.total).toBe(3);
    expect(result.tracks[0].metadata).toMatchObject({ title: 'Bình minh, "dịu dàng"', artist: 'Nghệ sĩ', album: 'Album\nSecond line', duration: 180, spotifyUrl: 'https://open.spotify.com/track/1111111111111111111111' });
    expect(JSON.stringify(result)).not.toContain('My playlist.csv');
  });
  it('accepts Spotify item wrappers and a saved metadata list without credentials', () => {
    const native = { id: '2222222222222222222222', type: 'track', name: 'Native song', artists: [{ name: 'Artist' }], album: { name: 'Album' }, duration_ms: 90000 };
    const result = parsePlaylistFile(Buffer.from(JSON.stringify({ name: 'Export', tracks: { items: [{ item: native }, { track: null }, { item: { ...native, type: 'episode' } }, { track: { ...native, id: '3333333333333333333333', is_playable: false } }] } })), 'input.json');
    expect(result.name).toBe('Export'); expect(result.tracks).toHaveLength(1); expect(result.skipped).toBe(3);
    const saved = parsePlaylistFile(Buffer.from(JSON.stringify([{ metadata: result.tracks[0].metadata }])), 'saved.json');
    expect(saved.tracks[0].metadata.spotifyUrl).toBe(result.tracks[0].metadata.spotifyUrl);
  });
  it('supports semicolon CSV and rejects malformed, missing-ID or oversized input', () => {
    const result = parsePlaylistFile(Buffer.from('Track URI;Track Name;Artist Name(s);Duration (ms)\nspotify:track:1111111111111111111111;Song;Artist;1000'), 'data.csv'); expect(result.tracks[0].metadata.duration).toBe(1);
    expect(() => parseCsv('name,artist\n"unfinished,Artist')).toThrow('chưa đóng');
    expect(() => parsePlaylistFile(Buffer.from('Track Name,Artist Name(s)\nSong,Artist'), 'missing.csv')).toThrow('Spotify Track URI/URL');
    expect(() => parsePlaylistFile(Buffer.alloc(5 * 1024 * 1024 + 1), 'large.json')).toThrow('5 MB');
    expect(() => parsePlaylistFile(Buffer.from(JSON.stringify(Array.from({ length: 10001 }, () => ({})))), 'large.json')).toThrow('10.000');
  });
});
