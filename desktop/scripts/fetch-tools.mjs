#!/usr/bin/env node
// Developer-only helper. The packaged application never downloads tools at launch.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const toolsRoot = path.join(projectRoot, 'resources', 'tools');
const cacheRoot = path.join(projectRoot, '.tools-cache');
const expectedRepos = ['yt-dlp/yt-dlp', 'BtbN/FFmpeg-Builds', 'denoland/deno'];

function errorText(error) { return error instanceof Error ? error.message : String(error); }
function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function cachePath(file) {
  if (!within(cacheRoot, file)) throw new Error('Refusing to operate outside the project tool cache.');
  return file;
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function validateManifest(value) {
  if (!Array.isArray(value) || value.length !== expectedRepos.length) throw new Error('Tool manifest must contain exactly three pinned official assets.');
  const seen = new Set();
  for (const item of value) {
    if (!item || !expectedRepos.includes(item.repo) || seen.has(item.repo)) throw new Error('Unexpected or duplicate repository in tool manifest.');
    seen.add(item.repo);
    if (typeof item.asset !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.asset)) throw new Error('Invalid asset filename in tool manifest.');
    if (typeof item.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(item.sha256)) throw new Error(`Missing SHA-256 for ${item.asset}.`);
    const url = new URL(item.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || !url.pathname.startsWith(`/${item.repo}/releases/download/`)) throw new Error(`Expected an official GitHub release URL for ${item.asset}.`);
    if (item.repo === 'yt-dlp/yt-dlp' && item.asset !== 'yt-dlp.exe') throw new Error('Expected the Windows yt-dlp executable.');
    if (item.repo === 'denoland/deno' && !/^deno-x86_64-pc-windows-msvc\.zip$/.test(item.asset)) throw new Error('Expected the Windows x86-64 Deno archive.');
    if (item.repo === 'BtbN/FFmpeg-Builds' && !/^ffmpeg-.*-win64-lgpl-shared-.*\.zip$/.test(item.asset)) throw new Error('Expected an LGPL shared Windows x86-64 FFmpeg archive.');
  }
  return value;
}

async function download(item) {
  const file = cachePath(path.join(cacheRoot, `${item.sha256.slice(0, 16)}-${item.asset}`));
  const expected = item.sha256.toLowerCase();
  try {
    if (await digest(file) === expected) { console.log(`Using verified cache: ${item.asset}`); return file; }
    console.warn(`Discarding cache with a different SHA-256: ${item.asset}`);
    await fs.unlink(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const temporary = cachePath(`${file}.download-${randomUUID()}`);
    try {
      console.log(`Downloading ${item.asset} (attempt ${attempt}/3)…`);
      const response = await fetch(item.url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${item.url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
      const actual = await digest(temporary);
      if (actual !== expected) {
        const error = new Error(`SHA-256 mismatch for ${item.asset}: expected ${expected}, received ${actual}. The source asset changed; update manifest deliberately after verifying its release and license provenance. No tool was installed from this download.`);
        error.code = 'CHECKSUM_MISMATCH';
        throw error;
      }
      await fs.rename(temporary, file);
      console.log(`Verified SHA-256: ${item.asset}`);
      return file;
    } catch (error) {
      lastError = error;
      await fs.unlink(temporary).catch(() => undefined);
      if (error.code === 'CHECKSUM_MISMATCH') throw error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  throw new Error(`Could not obtain ${item.asset}: ${errorText(lastError)}\nCheck the network and manifest. A floating upstream URL may no longer serve the pinned archive; never bypass checksum verification.`);
}

function tar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'tar.exe' : 'tar', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 5 * 60_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16_000_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Cannot run tar: ${errorText(error)}. On Windows, use the built-in tar.exe.`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('Archive extraction exceeded five minutes.'));
      else if (code !== 0) reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}

async function withArchive(archive, use) {
  const staging = cachePath(await fs.mkdtemp(path.join(cacheRoot, 'unpack-')));
  try {
    // Check paths before invoking tar, even though the archive hash is pinned.
    const entries = (await tar(['-tf', archive])).split(/\r?\n/).filter(Boolean);
    if (!entries.length) throw new Error('The verified archive is empty.');
    for (const entry of entries) {
      const portable = entry.replaceAll('\\', '/');
      if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable) || portable.split('/').includes('..')) throw new Error(`Unsafe archive entry: ${entry}`);
      const destination = path.resolve(staging, ...portable.split('/'));
      if (destination !== staging && !within(staging, destination)) throw new Error(`Archive entry escapes extraction directory: ${entry}`);
    }
    await tar(['-xf', archive, '-C', staging]);
    return await use(staging);
  } finally {
    // Only remove the exact directory made by mkdtemp inside .tools-cache.
    if (!path.basename(staging).startsWith('unpack-')) throw new Error('Unexpected extraction directory.');
    await fs.rm(cachePath(staging), { recursive: true, force: true });
  }
}

async function installFile(source, name) {
  const destination = path.join(toolsRoot, name);
  if (path.basename(name) !== name) throw new Error('Expected a plain tool filename.');
  const temporary = `${destination}.incoming-${randomUUID()}`;
  try { await fs.copyFile(source, temporary); await fs.rename(temporary, destination); }
  finally { await fs.unlink(temporary).catch(() => undefined); }
}

async function install(item, file) {
  if (item.repo === 'yt-dlp/yt-dlp') { await installFile(file, 'yt-dlp.exe'); return; }
  await withArchive(file, async staging => {
    if (item.repo === 'denoland/deno') { await installFile(path.join(staging, 'deno.exe'), 'deno.exe'); return; }
    const roots = [staging, ...(await fs.readdir(staging, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(staging, entry.name))];
    let distribution;
    for (const root of roots) {
      try { if ((await fs.stat(path.join(root, 'bin', 'ffmpeg.exe'))).isFile()) { distribution = root; break; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!distribution) throw new Error('FFmpeg archive has no bin/ffmpeg.exe.');
    const bin = path.join(distribution, 'bin');
    const files = (await fs.readdir(bin, { withFileTypes: true })).filter(entry => entry.isFile() && /\.(exe|dll)$/i.test(entry.name) && entry.name.toLowerCase() !== 'ffplay.exe');
    if (!files.some(entry => entry.name.toLowerCase() === 'ffprobe.exe')) throw new Error('FFmpeg archive does not contain ffprobe.exe.');
    for (const entry of files) await installFile(path.join(bin, entry.name), entry.name);
    const accompanying = path.join(toolsRoot, 'ffmpeg-distribution');
    await fs.mkdir(accompanying, { recursive: true });
    for (const entry of await fs.readdir(distribution, { withFileTypes: true })) {
      if (entry.name === 'bin') continue;
      await fs.cp(path.join(distribution, entry.name), path.join(accompanying, entry.name), { recursive: true });
    }
  });
}

async function main() {
  const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(toolsRoot, 'manifest.json'), 'utf8')));
  await fs.mkdir(cacheRoot, { recursive: true });
  await fs.mkdir(toolsRoot, { recursive: true });
  // Complete and verify all downloads before replacing any installed tool.
  const downloads = [];
  for (const item of manifest) downloads.push({ item, file: await download(item) });
  for (const { item, file } of downloads) { await install(item, file); console.log(`Installed ${item.asset}`); }
  console.log('Bundled Windows tools are ready in resources/tools. License files and manifest were preserved.');
}

main().catch(error => {
  console.error(`Tool setup failed: ${errorText(error)}\nClose Luma before replacing tools that may be in use, then run this helper again. Verified downloads remain cached.`);
  process.exitCode = 1;
});
