import { constants, createReadStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const ROOT_MARKER = '.luma-library.json';
export const ALBUM_MARKER = '.luma-album.json';
export interface RetiredCopy { path: string; sha256: string; trackId: string; albumId: string; root: string }
export function samePath(first: string, second: string): boolean {
  return process.platform === 'win32' ? path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase() : path.resolve(first) === path.resolve(second);
}
export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
export function safeStem(value: string, fallback: string, limit = 48): string {
  const cleaned = value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, limit).trim().replace(/[. ]+$/, '');
  return !cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? fallback : cleaned;
}
export async function checksum(filename: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}
export async function libraryRoot(requested: string): Promise<string> {
  if (!path.isAbsolute(requested) || requested.includes('\0') || samePath(requested, path.parse(requested).root)) throw new Error('Chọn một thư mục nhạc riêng có đường dẫn tuyệt đối.');
  await fs.mkdir(requested, { recursive: true });
  const root = await fs.realpath(requested);
  const marker = path.join(root, ROOT_MARKER);
  try { await fs.writeFile(marker, JSON.stringify({ app: 'Luma', version: 1, layout: 'albums' }), { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = JSON.parse(await fs.readFile(marker, 'utf8')) as { app?: string; version?: number; layout?: string };
    if (existing.app !== 'Luma' || existing.version !== 1 || existing.layout !== 'albums') throw new Error('Thư mục đã có dấu quản lý Luma không hợp lệ.');
  }
  return root;
}
export async function albumDirectory(root: string, folder: string, albumId: string): Promise<string> {
  if (path.basename(folder) !== folder || folder === '.' || folder === '..') throw new Error('Tên thư mục album không hợp lệ.');
  const target = path.join(root, folder);
  if (!inside(root, target)) throw new Error('Thư mục album nằm ngoài thư viện.');
  let created = false;
  try { await fs.mkdir(target); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(target), target)) throw new Error('Thư mục album không được là liên kết tới vị trí khác.');
  const marker = path.join(target, ALBUM_MARKER);
  if (created) await fs.writeFile(marker, JSON.stringify({ app: 'Luma', version: 1, albumId }), { flag: 'wx' });
  else {
    const record = JSON.parse(await fs.readFile(marker, 'utf8')) as { app?: string; version?: number; albumId?: string };
    if (record.app !== 'Luma' || record.version !== 1 || record.albumId !== albumId) throw new Error('Thư mục album đã tồn tại và không thuộc album này.');
  }
  return target;
}
export async function copyVerified(source: string, destination: string, expected?: { size: number; mtimeMs: number }): Promise<{ created: boolean; sha256: string }> {
  const before = await fs.stat(source);
  if (!before.isFile() || (expected && (before.size !== expected.size || before.mtimeMs !== expected.mtimeMs))) throw new Error('File nguồn đã thay đổi khi nhập. Hãy thử lại.');
  if (samePath(source, destination)) return { created: false, sha256: await checksum(source) };
  let created = false;
  try {
    try { await fs.copyFile(source, destination, constants.COPYFILE_EXCL); created = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const occupied = await fs.lstat(destination);
      if (!occupied.isFile() || occupied.isSymbolicLink()) throw new Error('Vị trí bản sao nhạc đã bị chiếm bởi file/liên kết không hợp lệ.');
    }
    const [originalHash, copiedHash, after, copied] = await Promise.all([checksum(source), checksum(destination), fs.stat(source), fs.stat(destination)]);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || copied.size !== before.size || copiedHash !== originalHash) throw new Error('Bản sao nhạc chưa khớp nguồn hoặc file đã thay đổi.');
    return { created, sha256: copiedHash };
  } catch (error) { if (created) await fs.unlink(destination).catch(() => undefined); throw error; }
}
/** Delete only our exact retired, unchanged copy. Never delete external imported originals. */
export async function retireCopy(copy: RetiredCopy): Promise<boolean> {
  try {
    const actualRoot = await fs.realpath(copy.root);
    if (!samePath(actualRoot, copy.root) || !inside(actualRoot, copy.path)) return false;
    const directory = path.dirname(copy.path);
    if (!samePath(path.dirname(directory), actualRoot) || (await fs.lstat(directory)).isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) return false;
    const extension = path.extname(copy.path).toLowerCase();
    if (!['.flac', '.m4a'].includes(extension) || !path.basename(copy.path).endsWith(`--${copy.trackId}${extension}`)) return false;
    const marker = JSON.parse(await fs.readFile(path.join(directory, ALBUM_MARKER), 'utf8')) as { app?: string; albumId?: string };
    const rootMarker = JSON.parse(await fs.readFile(path.join(actualRoot, ROOT_MARKER), 'utf8')) as { app?: string; layout?: string };
    if (marker.app !== 'Luma' || marker.albumId !== copy.albumId || rootMarker.app !== 'Luma' || rootMarker.layout !== 'albums') return false;
    if ((await fs.lstat(copy.path)).isSymbolicLink() || await checksum(copy.path) !== copy.sha256) return false;
    await fs.unlink(copy.path); return true;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}
