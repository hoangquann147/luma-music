import path from 'node:path';
import type { DownloadRequest, SettingsUpdate } from '../../shared/types';

export function stringValue(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`${name} không hợp lệ.`);
  return value;
}

export function trackId(value: unknown): string {
  const id = stringValue(value, 'Mã bài hát', 80);
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Mã bài hát không hợp lệ.');
  return id;
}

export function parseSourceUrl(value: unknown): { kind: 'youtube' | 'spotify'; url: string; id: string } {
  const input = stringValue(value, 'Đường dẫn', 2048).trim();
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Hãy dán đường dẫn HTTPS của YouTube hoặc một bài hát Spotify.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Chỉ hỗ trợ đường dẫn HTTPS công khai.');
  const hostname = url.hostname.toLowerCase();
  if (['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'].includes(hostname)) {
    let id = hostname === 'youtu.be' ? url.pathname.slice(1).split('/')[0] : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(shorts|embed|live)\/([\w-]+)\/?$/.exec(url.pathname)?.[2];
    if (!id || !/^[\w-]{11}$/.test(id)) throw new Error('Chỉ hỗ trợ video YouTube đơn lẻ; đường dẫn chưa có mã video hợp lệ.');
    return { kind: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (hostname === 'open.spotify.com') {
    const id = /^\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname)?.[1];
    if (!id) throw new Error('Hãy dùng đường dẫn Spotify của một bài hát (track), không phải album hoặc playlist.');
    return { kind: 'spotify', id, url: `https://open.spotify.com/track/${id}` };
  }
  throw new Error('Đường dẫn phải thuộc YouTube hoặc open.spotify.com.');
}

export function downloadRequest(value: unknown): DownloadRequest {
  if (!value || typeof value !== 'object') throw new Error('Yêu cầu tải không hợp lệ.');
  const raw = value as Record<string, unknown>;
  const parsed = parseSourceUrl(raw.url);
  if (raw.rightsConfirmed !== true) throw new Error('Hãy xác nhận bạn có quyền tải nội dung này.');
  return {
    url: parsed.url,
    rightsConfirmed: true,
    spotifyMatchId: raw.spotifyMatchId === undefined ? undefined : trackId(raw.spotifyMatchId),
    candidateId: raw.candidateId === undefined ? undefined : stringValue(raw.candidateId, 'Nguồn âm thanh', 100),
  };
}

export function settingsUpdate(value: unknown): SettingsUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cài đặt không hợp lệ.');
  const raw = value as Record<string, unknown>;
  const result: SettingsUpdate = {};
  for (const key of ['libraryDirectory', 'downloadDirectory', 'ytDlpPath', 'ffmpegPath', 'spotifyClientId', 'spotifyClientSecret', 'spotifyMarket'] as const) {
    if (raw[key] === undefined) continue;
    result[key] = stringValue(raw[key], key, key === 'spotifyClientSecret' ? 1024 : 4096).trim();
  }
  if (result.downloadDirectory !== undefined && (!result.downloadDirectory || !path.isAbsolute(result.downloadDirectory))) throw new Error('Thư mục tải phải là đường dẫn tuyệt đối.');
  if (result.libraryDirectory !== undefined && (!result.libraryDirectory || !path.isAbsolute(result.libraryDirectory))) throw new Error('Thư mục thư viện phải là đường dẫn tuyệt đối.');
  for (const key of ['ytDlpPath', 'ffmpegPath'] as const) {
    if (result[key] !== undefined && !result[key]) throw new Error('Đường dẫn công cụ không được để trống.');
  }
  if (result.spotifyMarket !== undefined) {
    result.spotifyMarket = result.spotifyMarket.toUpperCase();
    if (!/^[A-Z]{2}$/.test(result.spotifyMarket)) throw new Error('Thị trường Spotify dùng mã quốc gia hai ký tự, ví dụ VN.');
  }
  return result;
}

export interface ByteRange { start: number; end: number }
export function parseByteRange(header: string | null, size: number): ByteRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size < 1) throw new Error('Unsatisfiable range');
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error('Unsatisfiable range');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) throw new Error('Unsatisfiable range');
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function safeFilename(value: string): string {
  const base = value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 130).replace(/[. ]+$/, '') || 'Untitled';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base;
}
