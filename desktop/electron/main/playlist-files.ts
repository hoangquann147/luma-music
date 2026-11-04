import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SpotifyMetadata, SpotifyPlaylist } from '../../shared/types';
import { metadataFromTrack, record, spotifyCover, spotifyTrackUrl, textValue } from './spotify';

const key = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const separators = [',', ';', '\t'];
  const separator = separators.sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else if (quoted) quoted = false;
      else if (!cell.trim()) quoted = true;
      else throw new Error('CSV có dấu ngoặc kép không hợp lệ.');
    } else if (!quoted && char === separator) { row.push(cell); cell = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell); if (row.some(value => value.trim())) rows.push(row); row = []; cell = '';
      if (rows.length > 10_001) throw new Error('File vượt giới hạn 10.000 bài hát.');
    } else cell += char;
  }
  if (quoted) throw new Error('CSV chưa đóng dấu ngoặc kép.');
  row.push(cell); if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

function metadataFromExport(value: unknown): SpotifyMetadata | undefined {
  const wrapper = record(value);
  if (wrapper.is_local === true) return undefined;
  const raw = record(wrapper.item ?? wrapper.track ?? wrapper.metadata ?? wrapper);
  const native = metadataFromTrack(raw); if (native) return native;
  if (raw.is_local === true || raw.is_playable === false || (raw.type && raw.type !== 'track')) return undefined;
  const fields = new Map(Object.entries(raw).map(([name, value]) => [key(name), value]));
  const pick = (...names: string[]) => names.map(name => fields.get(key(name))).find(value => value !== undefined && value !== '');
  const uri = pick('spotifyUrl', 'Track URI', 'Spotify URI', 'Track URL', 'Spotify URL', 'URI', 'url', 'Spotify Track Id', 'Track ID', 'id');
  const canonical = spotifyTrackUrl(uri) || (typeof uri === 'string' && /^[A-Za-z0-9]{22}$/.test(uri) ? `https://open.spotify.com/track/${uri}` : undefined);
  const title = textValue(pick('title', 'Track Name', 'track_name', 'Song', 'name')).trim();
  const artists = pick('artist', 'Artist Name(s)', 'Artist Names', 'Artist Name', 'artists', 'artist_name');
  const artist = Array.isArray(artists) ? artists.map(item => typeof item === 'string' ? item : textValue(record(item).name)).filter(Boolean).join(', ') : textValue(artists).trim();
  if (!canonical || !title || !artist) return undefined;
  const durationMs = Number(pick('Duration (ms)', 'duration_ms', 'durationMs'));
  const duration = Number(pick('duration', 'duration_seconds', 'Duration (s)'));
  return { spotifyUrl: canonical, title: title.slice(0, 1000), artist: artist.slice(0, 1000), album: textValue(pick('album', 'Album Name', 'album_name')).slice(0, 1000), duration: Math.max(0, Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : Number.isFinite(duration) ? duration : 0), coverUrl: spotifyCover(pick('coverUrl', 'cover_url', 'Album Image URL')), releaseDate: textValue(pick('releaseDate', 'release_date', 'Release Date')).slice(0, 32) || undefined, trackNumber: Number(pick('trackNumber', 'track_number', 'Track Number')) || undefined };
}

export function parsePlaylistFile(contents: Buffer, filename: string): SpotifyPlaylist {
  if (contents.length > 5 * 1024 * 1024) throw new Error('File playlist vượt giới hạn 5 MB.');
  const text = contents.toString('utf8').replace(/^\uFEFF/, '');
  const extension = path.extname(filename).toLowerCase();
  let rows: unknown[]; let name = path.basename(filename, extension);
  if (extension === '.json') {
    let parsed: unknown; try { parsed = JSON.parse(text); } catch { throw new Error('File JSON không hợp lệ.'); }
    const root = record(parsed); const tracks = root.tracks;
    rows = Array.isArray(parsed) ? parsed : Array.isArray(tracks) ? tracks : Array.isArray(record(tracks).items) ? record(tracks).items as unknown[] : Array.isArray(root.items) ? root.items : [];
    if (textValue(root.name)) name = textValue(root.name);
  } else if (extension === '.csv') {
    const csv = parseCsv(text); const headers = csv.shift() || [];
    rows = csv.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
  } else throw new Error('Chỉ hỗ trợ playlist .csv hoặc .json.');
  if (rows.length > 10_000) throw new Error('File vượt giới hạn 10.000 bài hát.');
  if (!rows.length) throw new Error('File chưa có danh sách bài hát. Dùng CSV có Track URI, Track Name, Artist Name(s), hoặc JSON tracks/items.');
  const tracks = []; const seen = new Set<string>(); let skipped = 0;
  for (const row of rows) {
    const metadata = metadataFromExport(row);
    if (!metadata || seen.has(metadata.spotifyUrl)) { skipped++; continue; }
    seen.add(metadata.spotifyUrl); tracks.push({ id: randomUUID(), metadata });
  }
  if (!tracks.length) throw new Error('Không tìm thấy bài hợp lệ. Mỗi dòng cần Spotify Track URI/URL, tên bài và nghệ sĩ; podcast, file local và mục không khả dụng được bỏ qua.');
  return { id: randomUUID(), name: name.slice(0, 300), tracks, total: rows.length, skipped, source: 'file', importedAt: new Date().toISOString() };
}
