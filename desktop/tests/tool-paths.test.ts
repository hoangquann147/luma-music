import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { bundledJsRuntime, resolveToolPath, storedToolPath, toolFilename, toolsDirectory } from '../electron/main/tool-paths';

describe('portable bundled tools', () => {
  const current = path.resolve('portable/current/resources/tools');
  const previous = path.resolve('portable/previous/resources/tools');
  const binary = (tool: 'ffmpeg' | 'yt-dlp' | 'deno', directory = current) => path.join(directory, toolFilename(tool));
  const available = () => true;

  it('uses unpacked resources outside app.asar, with a separate development root', () => {
    expect(toolsDirectory({ packaged: true, resourcesPath: '/app/resources', appPath: '/app/resources/app.asar' })).toBe(path.join('/app/resources', 'tools'));
    expect(toolsDirectory({ packaged: false, resourcesPath: '/electron/resources', appPath: '/checkout/luma' })).toBe(path.join('/checkout/luma', 'resources', 'tools'));
    expect(toolFilename('ffmpeg', 'win32')).toBe('ffmpeg.exe');
    expect(toolFilename('deno', 'linux')).toBe('deno');
  });

  it('automatically prefers bundled binaries over PATH defaults', () => {
    expect(resolveToolPath('ffmpeg', 'bundled', current, undefined, process.platform, available)).toBe(binary('ffmpeg'));
    expect(resolveToolPath('yt-dlp', 'yt-dlp', current, undefined, process.platform, available)).toBe(binary('yt-dlp'));
    expect(resolveToolPath('ffmpeg', 'bundled', current, undefined, process.platform, () => false)).toBe('ffmpeg');
  });

  it('stores a token so moving or re-extracting a portable executable cannot stale its paths', () => {
    const saved = storedToolPath('ffmpeg', binary('ffmpeg', previous), previous);
    expect(saved).toBe('bundled');
    expect(resolveToolPath('ffmpeg', saved, current, undefined, process.platform, available)).toBe(binary('ffmpeg'));
    const migrated = storedToolPath('ffmpeg', binary('ffmpeg', previous), current, previous);
    expect(migrated).toBe('bundled');
    expect(resolveToolPath('ffmpeg', migrated, current, undefined, process.platform, available)).toBe(binary('ffmpeg'));
  });

  it('preserves user custom paths and gives environment overrides priority', () => {
    const custom = path.resolve('my-tools/ffmpeg-custom.exe');
    const override = path.resolve('override/ffmpeg.exe');
    expect(storedToolPath('ffmpeg', custom, current, previous)).toBe(custom);
    expect(resolveToolPath('ffmpeg', custom, current, undefined, process.platform, available)).toBe(custom);
    expect(resolveToolPath('ffmpeg', custom, current, override, process.platform, available)).toBe(override);
    expect(resolveToolPath('ffmpeg', 'bundled', current, 'ffmpeg-custom', process.platform, available)).toBe('ffmpeg-custom');
  });

  it('selects bundled Deno without replacing an explicit JavaScript runtime override', () => {
    expect(bundledJsRuntime(current, undefined, undefined, process.platform, available)).toBe(`deno:${binary('deno')}`);
    expect(bundledJsRuntime(current, 'node:C:/Node/node.exe', undefined, process.platform, available)).toBe('node:C:/Node/node.exe');
    expect(bundledJsRuntime(current, undefined, '/custom/deno', process.platform, available)).toBe('deno:/custom/deno');
    expect(bundledJsRuntime(current, undefined, undefined, process.platform, () => false)).toBeUndefined();
  });
});
