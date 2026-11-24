import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { MusicAPI, BootstrapData } from '../shared/types';

declare global { interface Window { __LUMA_MEDIA_BASE__?: string } }
const call = <T>(action: string, ...args: unknown[]) => invoke<T>('music', { action, args });
const subscribe = (event: string, listener: (value: never) => void) => {
  let disposed = false;
  let remove: (() => void) | undefined;
  void listen(event, e => { if (!disposed) listener(e.payload as never); }).then(fn => { if (disposed) fn(); else remove = fn; });
  return () => { disposed = true; remove?.(); };
};
const names = ['discordStatus','audioCommand','audioState','importFiles','getAlbums','createAlbum','assignAlbum','consolidateLibrary','chooseLibraryDirectory','openLibraryDirectory','removeTrack','selectDownloadDirectory','saveSettings','checkTools','prepareSpotify','startDownload','cancelDownload','revealTrack','openExternal','spotifyStatus','connectSpotify','cancelSpotifyConnect','disconnectSpotify','importSpotifyPlaylist','importPlaylistFile','startPlaylistDownload','cancelPlaylistDownload','saveProfile','chooseProfilePhoto','driveStatus','saveDriveConfig','chooseDriveDirectory','connectDrive','cancelDriveConnect','disconnectDrive','syncDriveNow','cancelDriveSync'] as const;
const api: Record<string, unknown> = Object.fromEntries(names.map(name => [name, (...args: unknown[]) => call(name, ...args)]));
api.bootstrap = async () => {
  const value = await call<BootstrapData & { mediaBase: string }>('bootstrap');
  window.__LUMA_MEDIA_BASE__ = value.mediaBase;
  return value;
};
api.onDownloadUpdate = (f: (v: never) => void) => subscribe('music:download-update', f);
api.onPlaybackState = (f: (v: never) => void) => subscribe('music:playback-state', f);
api.onPlaylistUpdate = (f: (v: never) => void) => subscribe('music:playlist-update', f);
api.onPlaylistBatchUpdate = (f: (v: never) => void) => subscribe('music:playlist-batch-update', f);
api.onDriveStatus = (f: (v: never) => void) => subscribe('music:drive-status', f);
window.music = Object.freeze(api) as unknown as MusicAPI;
