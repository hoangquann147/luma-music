import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpotifyClient } from '../electron/main/spotify';
import type { InternalSettings } from '../electron/main/store';
const settings: InternalSettings = { downloadDirectory: '', ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', spotifyClientId: 'id', spotifyClientSecret: 'secret', spotifyConfigured: true, spotifyMarket: 'VN' };
const url = 'https://open.spotify.com/track/0123456789ABCDEFGHIJKL';
const track = { name: 'Bình minh', artists: [{ name: 'Nghệ sĩ' }], duration_ms: 180000, track_number: 2, album: { name: 'Album', release_date: '2026-01-01', images: [{ url: 'https://i.scdn.co/image/cover' }] } };
afterEach(() => vi.unstubAllGlobals());
describe('Spotify metadata adapter', () => {
  it('reads every playlist page with user auth, current item schema, and explicit skipped counts', async () => {
    const first = { ...track, id: '1111111111111111111111', type: 'track', uri: 'spotify:track:1111111111111111111111' };
    const second = { ...track, id: '2222222222222222222222', type: 'track', uri: 'spotify:track:2222222222222222222222', name: 'Second song' };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ name: 'My playlist', owner: { display_name: 'Listener' } }))
      .mockResolvedValueOnce(Response.json({ total: 6, items: [{ item: first }, { item: first }, { item: null }, { item: { ...first, is_local: true } }, { item: { ...first, type: 'episode' } }], next: 'https://api.spotify.com/v1/playlists/0123456789ABCDEFGHIJKL/items?limit=50&offset=50' }))
      .mockResolvedValueOnce(Response.json({ total: 6, items: [{ track: second }], next: null }));
    vi.stubGlobal('fetch', fetchMock);
    const accessToken = vi.fn(async () => 'user-token');
    const playlist = await new SpotifyClient(() => ({ ...settings, spotifyClientSecret: '' }), { status: () => ({ connected: true, redirectUri: '' }), accessToken }).playlist('https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL');
    expect(playlist.tracks.map(entry => entry.metadata.title)).toEqual(['Bình minh', 'Second song']);
    expect(playlist.total).toBe(6); expect(playlist.skipped).toBe(4);
    expect(new Set(playlist.tracks.map(entry => entry.id)).size).toBe(2);
    expect(fetchMock.mock.calls[1][0]).toContain('/items?limit=50&offset=0');
    expect(fetchMock.mock.calls.every(call => call[1].headers.Authorization === 'Bearer user-token')).toBe(true);
  });
  it('requires a user session for playlists and refuses foreign pagination URLs', async () => {
    const playlistUrl = 'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL';
    await expect(new SpotifyClient(() => settings).playlist(playlistUrl)).rejects.toThrow('Kết nối tài khoản');
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ name: 'Own playlist' })).mockResolvedValueOnce(Response.json({ items: [], next: 'http://127.0.0.1/private' })); vi.stubGlobal('fetch', fetchMock);
    await expect(new SpotifyClient(() => settings, { status: () => ({ connected: true, redirectUri: '' }), accessToken: async () => 'user' }).playlist(playlistUrl)).rejects.toThrow('phân trang không hợp lệ');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('keeps credentials server side, uses market, and reuses a token', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'token', expires_in: 3600 })).mockImplementation(async () => Response.json(track));
    vi.stubGlobal('fetch', fetchMock);
    const client = new SpotifyClient(() => settings);
    expect(await client.track(url)).toMatchObject({ title: 'Bình minh', artist: 'Nghệ sĩ', duration: 180, trackNumber: 2, spotifyUrl: url });
    await client.track(url);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    expect(fetchMock.mock.calls[1][0]).toContain('?market=VN');
  });
  it('refreshes credentials once after an expired token', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'old', expires_in: 3600 })).mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(Response.json({ access_token: 'new', expires_in: 3600 })).mockResolvedValueOnce(Response.json(track));
    vi.stubGlobal('fetch', fetchMock);
    expect((await new SpotifyClient(() => settings).track(url)).title).toBe('Bình minh');
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer new');
  });
  it('does not pass arbitrary cover hosts to the downloader', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'token' })).mockResolvedValueOnce(Response.json({ ...track, album: { ...track.album, images: [{ url: 'http://127.0.0.1/private' }] } })));
    expect((await new SpotifyClient(() => settings).track(url)).coverUrl).toBeUndefined();
  });
  it('reports API access restrictions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'token' })).mockResolvedValueOnce(new Response(null, { status: 403 })));
    await expect(new SpotifyClient(() => settings).track(url)).rejects.toThrow('Development');
  });
});
