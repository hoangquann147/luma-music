import type { Track } from '../../shared/types';

/** Older library entries predate format metadata; their original extension stays authoritative. */
export function trackContainer(track: Track): 'FLAC' | 'M4A' {
  return track.container === 'M4A' || /\.m4a$/i.test(track.path) ? 'M4A' : 'FLAC';
}

export function trackFormatLabel(track: Track): string {
  if (trackContainer(track) === 'FLAC') return 'FLAC';
  const codec = (track.codec || '').toUpperCase();
  if (codec.includes('ALAC')) return 'M4A · ALAC';
  if (codec.includes('AAC')) return 'M4A · AAC';
  return 'M4A';
}

export function trackQualityLabel(track: Track): string {
  const lossless = track.lossless ?? (trackContainer(track) === 'FLAC' || /ALAC/i.test(track.codec || ''));
  const detail = lossless
    ? (track.bitsPerSample ? `${track.bitsPerSample}-bit` : 'Lossless')
    : (track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : 'Theo nguồn');
  return detail + (track.sampleRate ? ` / ${Number((track.sampleRate / 1000).toFixed(2))} kHz` : '');
}
