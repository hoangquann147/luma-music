import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/** MP4 sample-entry rates can be legacy placeholders (e.g. 48kHz for 96kHz ALAC).
 * Ask the bundled codec probe for the actual first audio stream rather than guessing. */
export async function probeM4a(filename: string, executable: string): Promise<{
  codec: 'AAC' | 'ALAC'; sampleRate: number; channels: number; duration: number; bitsPerSample: number; bitrate?: number;
}> {
  const { stdout } = await execute(executable, ['-v', 'error', '-select_streams', 'a:0', '-show_streams', '-show_format', '-of', 'json', filename], { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const data = JSON.parse(stdout) as { streams?: { codec_name?: string; sample_rate?: string; channels?: number; duration?: string; bits_per_raw_sample?: string; bits_per_sample?: number; bit_rate?: string }[]; format?: { duration?: string; bit_rate?: string } };
  const stream = data.streams?.[0];
  const codec = stream?.codec_name === 'alac' ? 'ALAC' : stream?.codec_name === 'aac' ? 'AAC' : undefined;
  const firstPositive = (...values: unknown[]) => values.map(Number).find(value => Number.isFinite(value) && value > 0) || 0;
  const sampleRate = Number(stream?.sample_rate), channels = Number(stream?.channels), duration = firstPositive(stream?.duration, data.format?.duration);
  const bitsPerSample = codec === 'ALAC' ? firstPositive(stream?.bits_per_raw_sample, stream?.bits_per_sample) : 0;
  const bitrate = firstPositive(stream?.bit_rate, data.format?.bit_rate);
  if (!codec || !Number.isFinite(sampleRate) || sampleRate < 1 || !Number.isInteger(channels) || channels < 1 || !Number.isFinite(duration) || duration <= 0 || (codec === 'ALAC' && (!Number.isInteger(bitsPerSample) || bitsPerSample < 1 || bitsPerSample > 32)))
    throw new Error('File M4A không có luồng AAC / ALAC hợp lệ hoặc đang dùng codec chưa hỗ trợ.');
  return { codec, sampleRate, channels, duration, bitsPerSample, bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : undefined };
}
