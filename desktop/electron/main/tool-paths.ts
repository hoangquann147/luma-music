import path from 'node:path';
import { existsSync } from 'node:fs';

export type ToolName = 'yt-dlp' | 'ffmpeg' | 'ffprobe' | 'deno';
export interface ToolLocation {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
}

export function toolsDirectory(location: ToolLocation): string {
  return location.packaged ? path.join(location.resourcesPath, 'tools') : path.join(location.appPath, 'resources', 'tools');
}

export function toolFilename(tool: ToolName, platform: NodeJS.Platform = process.platform): string {
  return `${tool}${platform === 'win32' ? '.exe' : ''}`;
}

function samePath(first: string, second: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => {
    const normalized = path.resolve(value);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(first) === normalize(second);
}

/** Store a stable token instead of a portable .exe's temporary extraction path. */
export function storedToolPath(tool: ToolName, value: string, currentDirectory: string, previousDirectory?: string, platform: NodeJS.Platform = process.platform): string {
  if (value === 'bundled' || value === tool || value === toolFilename(tool, platform)) return 'bundled';
  if ([currentDirectory, previousDirectory].some(directory => directory && samePath(value, path.join(directory, toolFilename(tool, platform)), platform))) return 'bundled';
  return value;
}

export function resolveToolPath(tool: ToolName, configured: string, directory: string, environmentOverride?: string, platform: NodeJS.Platform = process.platform, fileExists: (file: string) => boolean = existsSync): string {
  if (environmentOverride?.trim()) return environmentOverride.trim();
  if (storedToolPath(tool, configured, directory, undefined, platform) !== 'bundled') return configured;
  const bundled = path.join(directory, toolFilename(tool, platform));
  return fileExists(bundled) ? bundled : tool;
}

export function bundledJsRuntime(directory: string, existingOverride?: string, denoOverride?: string, platform: NodeJS.Platform = process.platform, fileExists: (file: string) => boolean = existsSync): string | undefined {
  if (existingOverride?.trim()) return existingOverride;
  const deno = resolveToolPath('deno', 'bundled', directory, denoOverride, platform, fileExists);
  return deno !== 'deno' ? `deno:${deno}` : undefined;
}
