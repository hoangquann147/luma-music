import { nativeImage } from 'electron';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { UserProfile } from '../../shared/types';

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_BYTES = 512 * 1024;
const DEFAULT_PROFILE: UserProfile = { name: 'Luma Listener' };

function profileName(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('Tên hồ sơ không được chứa ký tự điều khiển hoặc xuống dòng.');
  const name = value.trim();
  if (!name || Array.from(name).length > 80) throw new Error('Tên hồ sơ phải có từ 1 đến 80 ký tự.');
  return name;
}

function imageFormat(bytes: Buffer): 'png' | 'jpeg' | 'webp' | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return undefined;
}

function storedAvatar(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_AVATAR_BYTES) throw new Error('Ảnh hồ sơ đã lưu không hợp lệ.');
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || imageFormat(Buffer.from(match[2], 'base64')) !== match[1]) throw new Error('Ảnh hồ sơ đã lưu không hợp lệ.');
  return value;
}

/** A local Luma profile. No Spotify identity, file paths, or tokens reach the renderer. */
export class ProfileStore {
  private profile: UserProfile = { ...DEFAULT_PROFILE };
  private initialized = false;
  private pendingWrite: Promise<void> = Promise.resolve();
  private readonly filename: string;
  constructor(userDataDirectory: string) { this.filename = path.join(userDataDirectory, 'profile.json'); }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    let contents: string;
    try { contents = await fs.readFile(this.filename, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Không đọc được hồ sơ Luma: ${(error as Error).message}`);
      this.profile = { ...DEFAULT_PROFILE }; this.initialized = true; return;
    }
    try {
      if (Buffer.byteLength(contents, 'utf8') > MAX_AVATAR_BYTES + 4096) throw new Error('Profile exceeds size limit');
      const parsed = JSON.parse(contents) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) throw new Error('Unsupported profile');
      this.profile = { name: profileName(parsed.name), avatarDataUrl: storedAvatar(parsed.avatarDataUrl) };
    } catch {
      // A backup must succeed before a corrupt profile can be replaced later.
      await fs.copyFile(this.filename, `${this.filename}.backup-${Date.now()}-${randomUUID()}`);
      this.profile = { ...DEFAULT_PROFILE };
      console.warn('Invalid local profile; a backup has been preserved.');
    }
    this.initialized = true;
  }

  get(): UserProfile { return { ...this.profile }; }

  async saveName(name: string): Promise<UserProfile> {
    const validated = profileName(name);
    return this.commit(next => { next.name = validated; });
  }

  async choosePhoto(filePath: string): Promise<UserProfile> {
    this.assertInitialized();
    if (typeof filePath !== 'string' || filePath.includes('\0') || !['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(filePath).toLowerCase())) throw new Error('Hãy chọn ảnh PNG, JPG hoặc WebP.');
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('Ảnh hồ sơ phải là file ảnh không quá 5 MB.');
    const bytes = await fs.readFile(filePath);
    if (bytes.length > MAX_SOURCE_BYTES || !imageFormat(bytes)) throw new Error('File không chứa ảnh PNG, JPG hoặc WebP hợp lệ.');
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('Không giải mã được ảnh hồ sơ. Hãy chọn ảnh khác.');
    const size = image.getSize();
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) throw new Error('Kích thước ảnh hồ sơ không hợp lệ.');
    const ratio = Math.min(1, 256 / size.width, 256 / size.height);
    const thumbnail = ratio < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'best' }) : image;
    let dataUrl = `data:image/png;base64,${thumbnail.toPNG().toString('base64')}`;
    if (Buffer.byteLength(dataUrl, 'utf8') > MAX_AVATAR_BYTES) dataUrl = `data:image/jpeg;base64,${thumbnail.toJPEG(85).toString('base64')}`;
    if (Buffer.byteLength(dataUrl, 'utf8') > MAX_AVATAR_BYTES) throw new Error('Ảnh thu nhỏ vượt giới hạn 512 KB. Hãy chọn ảnh khác.');
    const avatar = storedAvatar(dataUrl)!;
    return this.commit(next => { next.avatarDataUrl = avatar; });
  }

  private assertInitialized(): void { if (!this.initialized) throw new Error('Hồ sơ Luma chưa được khởi tạo.'); }
  private commit(change: (next: UserProfile) => void): Promise<UserProfile> {
    this.assertInitialized();
    const operation = this.pendingWrite.then(async () => {
      const next = { ...this.profile }; change(next);
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, ...next }, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, this.filename);
        this.profile = next;
      } finally { await fs.unlink(temporary).catch(() => undefined); }
      return this.get();
    });
    this.pendingWrite = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
