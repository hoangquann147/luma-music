import { randomUUID } from 'node:crypto';
import type { SpotifyMetadata, SpotifyPlaylist } from '../../shared/types';
import type { InternalSettings } from './store';
import type { SpotifyAuth } from './spotify-auth';
import { parseSourceUrl } from './validation';

export const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const textValue = (value: unknown): string => typeof value === 'string' ? value : '';
export function spotifyTrackUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const uri = /^spotify:track:([A-Za-z0-9]{22})$/.exec(value.trim());
  if (uri) return `https://open.spotify.com/track/${uri[1]}`;
  try { const source = parseSourceUrl(value); return source.kind === 'spotify' ? source.url : undefined; } catch { return undefined; }
}
export function spotifyPlaylistUrl(value: unknown): { id: string; url: string } {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Đường dẫn playlist Spotify không hợp lệ.');
  let url: URL; try { url = new URL(value.trim()); } catch { throw new Error('Hãy dán đường dẫn https://open.spotify.com/playlist/...'); }
  const id = /^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname)?.[1];
  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.username || url.password || url.port || !id) throw new Error('Chỉ hỗ trợ đường dẫn Spotify của một playlist.');
  return { id, url: `https://open.spotify.com/playlist/${id}` };
}
export function spotifyCover(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'i.scdn.co' && !url.username && !url.password && !url.port ? url.toString() : undefined; } catch { return undefined; }
}
export function metadataFromTrack(value: unknown): SpotifyMetadata | undefined {
  const item = record(value);
  if (item.is_local === true || item.is_playable === false || (item.type && item.type !== 'track')) return undefined;
  const url = spotifyTrackUrl(item.uri) || spotifyTrackUrl(record(item.external_urls).spotify) || (/^[A-Za-z0-9]{22}$/.test(textValue(item.id)) ? `https://open.spotify.com/track/${item.id}` : undefined);
  const album = record(item.album);
  const artists = Array.isArray(item.artists) ? item.artists.map(artist => typeof artist === 'string' ? artist : textValue(record(artist).name)).filter(Boolean) : [];
  const title = textValue(item.name);
  if (!url || !title || !artists.length) return undefined;
  const images = Array.isArray(album.images) ? album.images : [];
  const cover = images.map(image => spotifyCover(record(image).url)).find(Boolean);
  return { title: title.slice(0, 1000), artist: artists.join(', ').slice(0, 1000), album: textValue(album.name).slice(0, 1000), duration: Math.max(0, Number(item.duration_ms) / 1000 || 0), coverUrl: cover, releaseDate: textValue(album.release_date) || undefined, trackNumber: Number(item.track_number) || undefined, spotifyUrl: url };
}

/** Uses the connected user's token for metadata; client credentials remain a single-track fallback. */
export class SpotifyClient {
  private token?: { value: string; expiresAt: number; credentials: string };
  constructor(private readonly settings: () => InternalSettings, private readonly auth?: Pick<SpotifyAuth, 'status' | 'accessToken'>) {}
  private async appToken(force = false, signal?: AbortSignal): Promise<string> {
    const settings = this.settings(); const clientId = settings.spotifyClientId.trim(); const secret = settings.spotifyClientSecret?.trim();
    if (!clientId || !secret) throw new Error('Kết nối Spotify trong Settings, hoặc thêm Client ID và Client Secret để đọc metadata từng bài.');
    const credentials = `${clientId}:${secret}`;
    if (!force && this.token?.credentials === credentials && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(credentials).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Spotify đang giới hạn yêu cầu. Hãy thử lại sau.' : 'Spotify từ chối thông tin ứng dụng. Kiểm tra Client ID và Client Secret.');
    const result = record(await response.json()); const value = textValue(result.access_token);
    if (!value) throw new Error('Spotify không trả về access token hợp lệ.');
    this.token = { value, expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000, credentials }; return value;
  }
  private async request(url: string, userOnly: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const user = Boolean(this.auth?.status().connected);
    if (userOnly && !user) throw new Error('Kết nối tài khoản Spotify trong Settings để nhập playlist.');
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = user ? await this.auth!.accessToken(attempt === 1, signal) : await this.appToken(attempt === 1, signal);
      response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
      if (response.status !== 401) break;
    }
    if (!response?.ok) {
      if (response?.status === 403) throw new Error(userOnly ? 'Spotify chỉ cho phép đọc các playlist bạn sở hữu hoặc cộng tác trong chế độ API hiện tại. Kiểm tra tài khoản Premium của chủ ứng dụng Development, danh sách người dùng được cấp phép và quyền playlist; có thể dùng file CSV/JSON xuất sẵn.' : 'Ứng dụng Spotify chưa được cấp quyền endpoint này. Kiểm tra tài khoản Premium, quyền ứng dụng và chế độ Development trong Spotify Dashboard.');
      if (response?.status === 429) throw new Error(`Spotify đang giới hạn yêu cầu. Thử lại sau ${response.headers.get('retry-after') || 'ít'} giây.`);
      if (response?.status === 401) throw new Error('Phiên Spotify đã hết hạn. Hãy ngắt kết nối và đăng nhập lại.');
      if (response?.status === 404) throw new Error('Không tìm thấy nội dung Spotify trong thị trường đã chọn.');
      throw new Error(`Không đọc được Spotify (HTTP ${response?.status || 'không xác định'}).`);
    }
    return record(await response.json());
  }
  async track(url: string, signal?: AbortSignal): Promise<SpotifyMetadata> {
    const source = parseSourceUrl(url);
    if (source.kind !== 'spotify') throw new Error('Cần liên kết Spotify của một bài hát.');
    const data = await this.request(`https://api.spotify.com/v1/tracks/${source.id}?market=${encodeURIComponent(this.settings().spotifyMarket || 'VN')}`, false, signal);
    const metadata = metadataFromTrack({ ...data, id: source.id });
    if (!metadata) throw new Error('Bài hát Spotify không khả dụng hoặc thiếu metadata.');
    return metadata;
  }
  async playlist(url: string, signal?: AbortSignal): Promise<SpotifyPlaylist> {
    const source = spotifyPlaylistUrl(url); const details = await this.request(`https://api.spotify.com/v1/playlists/${source.id}`, true, signal);
    const endpoint = `https://api.spotify.com/v1/playlists/${source.id}/items`;
    let next: string | undefined = `${endpoint}?limit=50&offset=0&market=${encodeURIComponent(this.settings().spotifyMarket || 'VN')}`;
    const pages = new Set<string>(); const uris = new Set<string>(); const tracks = []; let skipped = 0; let count = 0; let total = 0;
    while (next) {
      if (pages.has(next)) throw new Error('Spotify trả về phân trang lặp; chưa lưu playlist không đầy đủ.');
      pages.add(next);
      const page = await this.request(next, true, signal);
      const items = Array.isArray(page.items) ? page.items : [];
      total = Math.max(total, Number(page.total) || 0);
      if (total > 10_000 || count + items.length > 10_000) throw new Error('Playlist vượt giới hạn 10.000 mục. Hãy chia thành các playlist nhỏ hơn.');
      for (const wrapped of items) {
        count++; const wrapper = record(wrapped); const metadata = wrapper.is_local === true ? undefined : metadataFromTrack(wrapper.item ?? wrapper.track);
        if (!metadata || uris.has(metadata.spotifyUrl)) { skipped++; continue; }
        uris.add(metadata.spotifyUrl); tracks.push({ id: randomUUID(), metadata });
      }
      const link = textValue(page.next);
      if (!link) next = undefined;
      else {
        const candidate = new URL(link);
        if (candidate.origin !== 'https://api.spotify.com' || candidate.pathname !== new URL(endpoint).pathname || candidate.username || candidate.password) throw new Error('Spotify trả về đường dẫn phân trang không hợp lệ.');
        next = candidate.toString();
      }
    }
    const images = Array.isArray(details.images) ? details.images : [];
    return { id: randomUUID(), name: textValue(details.name).slice(0, 300) || 'Spotify playlist', url: source.url, coverUrl: images.map(image => spotifyCover(record(image).url)).find(Boolean), owner: textValue(record(details.owner).display_name).slice(0, 300) || undefined, tracks, total: Math.max(total, count), skipped, importedAt: new Date().toISOString(), source: 'spotify' };
  }
}
