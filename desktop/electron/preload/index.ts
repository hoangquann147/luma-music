import { contextBridge, ipcRenderer } from 'electron';
import type { DownloadJob, MusicAPI, SpotifyPlaylist, PlaylistBatch } from '../../shared/types';
import type { DriveStatus } from '../../shared/drive-types';

const api: MusicAPI = {
  bootstrap: () => ipcRenderer.invoke('music:bootstrap'),
  importFiles: () => ipcRenderer.invoke('music:import'),
  getAlbums: () => ipcRenderer.invoke('music:albums'),
  createAlbum: input => ipcRenderer.invoke('music:create-album', input),
  assignAlbum: input => ipcRenderer.invoke('music:assign-album', input),
  consolidateLibrary: () => ipcRenderer.invoke('music:consolidate-library'),
  chooseLibraryDirectory: () => ipcRenderer.invoke('music:choose-library-directory'),
  openLibraryDirectory: () => ipcRenderer.invoke('music:open-library-directory'),
  removeTrack: id => ipcRenderer.invoke('music:remove', id),
  selectDownloadDirectory: () => ipcRenderer.invoke('music:select-directory'),
  saveSettings: update => ipcRenderer.invoke('music:save-settings', update),
  checkTools: () => ipcRenderer.invoke('music:check-tools'),
  prepareSpotify: url => ipcRenderer.invoke('music:prepare-spotify', url),
  startDownload: request => ipcRenderer.invoke('music:start-download', request),
  cancelDownload: id => ipcRenderer.invoke('music:cancel-download', id),
  revealTrack: id => ipcRenderer.invoke('music:reveal', id),
  openExternal: url => ipcRenderer.invoke('music:open-external', url),
  spotifyStatus: () => ipcRenderer.invoke('music:spotify-status'),
  connectSpotify: () => ipcRenderer.invoke('music:spotify-connect'),
  cancelSpotifyConnect: () => ipcRenderer.invoke('music:spotify-cancel-connect'),
  disconnectSpotify: () => ipcRenderer.invoke('music:spotify-disconnect'),
  importSpotifyPlaylist: url => ipcRenderer.invoke('music:import-spotify-playlist', url),
  importPlaylistFile: () => ipcRenderer.invoke('music:import-playlist-file'),
  startPlaylistDownload: request => ipcRenderer.invoke('music:start-playlist-download', request),
  cancelPlaylistDownload: id => ipcRenderer.invoke('music:cancel-playlist-download', id),
  saveProfile: value => ipcRenderer.invoke('music:save-profile', value),
  chooseProfilePhoto: () => ipcRenderer.invoke('music:choose-profile-photo'),
  driveStatus: () => ipcRenderer.invoke('music:drive-status'),
  saveDriveConfig: update => ipcRenderer.invoke('music:save-drive-config', update),
  chooseDriveDirectory: () => ipcRenderer.invoke('music:choose-drive-directory'),
  connectDrive: () => ipcRenderer.invoke('music:connect-drive'),
  cancelDriveConnect: () => ipcRenderer.invoke('music:cancel-drive-connect'),
  disconnectDrive: () => ipcRenderer.invoke('music:disconnect-drive'),
  syncDriveNow: () => ipcRenderer.invoke('music:sync-drive-now'),
  cancelDriveSync: () => ipcRenderer.invoke('music:cancel-drive-sync'),
  onDriveStatus: listener => {
    const callback = (_event: Electron.IpcRendererEvent, status: DriveStatus) => listener(status);
    ipcRenderer.on('music:drive-status', callback);
    return () => ipcRenderer.removeListener('music:drive-status', callback);
  },
  onPlaylistUpdate: listener => {
    const callback = (_event: Electron.IpcRendererEvent, playlist: SpotifyPlaylist) => listener(playlist);
    ipcRenderer.on('music:playlist-update', callback);
    return () => ipcRenderer.removeListener('music:playlist-update', callback);
  },
  onPlaylistBatchUpdate: listener => {
    const callback = (_event: Electron.IpcRendererEvent, batch: PlaylistBatch) => listener(batch);
    ipcRenderer.on('music:playlist-batch-update', callback);
    return () => ipcRenderer.removeListener('music:playlist-batch-update', callback);
  },
  onDownloadUpdate: listener => {
    const callback = (_event: Electron.IpcRendererEvent, job: DownloadJob) => listener(job);
    ipcRenderer.on('music:download-update', callback);
    return () => ipcRenderer.removeListener('music:download-update', callback);
  },
};
contextBridge.exposeInMainWorld('music', Object.freeze(api));
