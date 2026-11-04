import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { config as loadEnvironment } from 'dotenv';
import { LibraryStore } from './store';
import { Downloader, checkTools } from './downloader';
import { registerMediaProtocol } from './media';
import { downloadRequest, parseSourceUrl, settingsUpdate, stringValue, trackId } from './validation';
import { bundledJsRuntime, toolsDirectory } from './tool-paths';
import { SpotifyAuth } from './spotify-auth';
import { SpotifyClient } from './spotify';
import { PlaylistManager } from './playlists';
import { ProfileStore } from './profile';
import { DriveSyncService } from './drive-sync';
import type { DriveConfigUpdate } from '../../shared/drive-types';
import type { PlaylistDownloadRequest } from '../../shared/types';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
app.setName('Luma');
if (!app.isPackaged) loadEnvironment({ path: path.join(process.cwd(), '.env'), quiet: true });
const tools = toolsDirectory({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
const jsRuntime = bundledJsRuntime(tools, process.env.YTDLP_JS_RUNTIME, process.env.DENO_PATH);
if (jsRuntime) process.env.YTDLP_JS_RUNTIME = jsRuntime;
// Development smoke tests use a disposable profile, never the user's library.
if (!app.isPackaged && process.env.LUMA_USER_DATA_DIR && path.isAbsolute(process.env.LUMA_USER_DATA_DIR)) app.setPath('userData', process.env.LUMA_USER_DATA_DIR);
protocol.registerSchemesAsPrivileged([{ scheme: 'luma-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);

let window: BrowserWindow | null = null;
let downloader: Downloader | null = null;
let spotifyAuth: SpotifyAuth;
let playlists: PlaylistManager;
let profile: ProfileStore;
let driveSync: DriveSyncService;
let quitting = false;
let shutdownMedia: (() => Promise<void>) | undefined;
const library = new LibraryStore();

function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Yêu cầu IPC không được phép.');
}

function handle(channel: string, action: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    trusted(event);
    return action(event, ...args);
  });
}

function installHandlers(): void {
  handle('music:drive-status', () => driveSync.status());
  handle('music:save-drive-config', (_event, update) => driveSync.saveConfig(update as DriveConfigUpdate));
  handle('music:choose-drive-directory', async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Chọn thư mục FLAC để đồng bộ', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  handle('music:connect-drive', () => driveSync.connect());
  handle('music:cancel-drive-connect', () => driveSync.cancelConnect());
  handle('music:disconnect-drive', () => driveSync.disconnect());
  handle('music:sync-drive-now', () => driveSync.syncNow());
  handle('music:cancel-drive-sync', () => driveSync.cancelSync());
  handle('music:bootstrap', async () => ({ tracks: library.list(), settings: library.publicSettings(), tools: await checkTools(library.settings()), jobs: downloader!.listJobs(), spotifyAuth: spotifyAuth.status(), playlists: playlists.list(), playlistBatches: playlists.listBatches(), profile: profile.get(), albums: library.listAlbums() }));
  handle('music:albums', () => library.listAlbums());
  handle('music:create-album', (_event, input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Album không hợp lệ.');
    const value = input as Record<string, unknown>;
    return library.createAlbum({ name: stringValue(value.name, 'Tên album', 240).trim(), artist: value.artist === undefined ? undefined : stringValue(value.artist, 'Nghệ sĩ album', 240).trim() });
  });
  handle('music:assign-album', (_event, input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Yêu cầu gán album không hợp lệ.');
    const value = input as Record<string, unknown>;
    if (!Array.isArray(value.trackIds) || value.trackIds.length < 1 || value.trackIds.length > 10_000) throw new Error('Chọn từ 1 đến 10.000 bài hát.');
    return library.assignAlbum({ albumId: trackId(value.albumId), trackIds: value.trackIds.map(trackId) });
  });
  handle('music:consolidate-library', () => library.consolidateLibrary());
  handle('music:choose-library-directory', async () => {
    const selection = await dialog.showOpenDialog(window!, { title: 'Chọn thư mục thư viện nhạc', defaultPath: library.publicSettings().libraryDirectory, properties: ['openDirectory', 'createDirectory'] });
    return selection.canceled ? null : selection.filePaths[0] || null;
  });
  handle('music:open-library-directory', async () => {
    const directory = library.publicSettings().libraryDirectory;
    if (!directory) throw new Error('Chưa cấu hình thư mục thư viện.');
    await fs.mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  handle('music:save-profile', (_event, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hồ sơ không hợp lệ.');
    return profile.saveName(stringValue((value as Record<string, unknown>).name, 'Tên hồ sơ', 320));
  });
  handle('music:choose-profile-photo', async () => {
    const selection = await dialog.showOpenDialog(window!, { title: 'Chọn ảnh hồ sơ', properties: ['openFile'], filters: [{ name: 'Profile photos', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    return selection.canceled || !selection.filePaths[0] ? null : profile.choosePhoto(selection.filePaths[0]);
  });
  handle('music:check-tools', () => checkTools(library.settings()));
  handle('music:import', async () => {
    const selection = await dialog.showOpenDialog(window!, {
      title: 'Import FLAC / M4A files', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'FLAC / M4A audio', extensions: ['flac', 'm4a'] }, { name: 'FLAC lossless audio', extensions: ['flac'] }, { name: 'M4A (AAC / ALAC)', extensions: ['m4a'] }],
    });
    if (selection.canceled) return [];
    const tracks = [];
    const failures: string[] = [];
    for (const file of selection.filePaths) {
      try { tracks.push(await library.addFile(file)); }
      catch (error) { failures.push(`${path.basename(file)}: ${(error as Error).message}`); }
    }
    if (!tracks.length && failures.length) throw new Error(failures.join('\n'));
    if (failures.length) await dialog.showMessageBox(window!, { type: 'warning', title: 'Một số file chưa được nhập', message: `Đã nhập ${tracks.length} file.`, detail: failures.join('\n') });
    return tracks;
  });
  handle('music:remove', async (_event, value) => { await library.remove(trackId(value)); await playlists.reconcile(); });
  handle('music:select-directory', async () => {
    const selection = await dialog.showOpenDialog(window!, { title: 'Chọn thư mục lưu FLAC', defaultPath: library.publicSettings().downloadDirectory, properties: ['openDirectory', 'createDirectory'] });
    return selection.canceled ? null : selection.filePaths[0] || null;
  });
  handle('music:save-settings', async (_event, value) => {
    if (downloader!.listJobs().some(job => !['completed', 'cancelled', 'error'].includes(job.stage))) throw new Error('Hãy chờ tác vụ tải hoàn tất hoặc hủy tác vụ trước khi đổi cài đặt.');
    const update = settingsUpdate(value);
    if (update.spotifyClientId !== undefined && update.spotifyClientId !== library.publicSettings().spotifyClientId) spotifyAuth.cancelConnect();
    return library.updateSettings(update);
  });
  handle('music:prepare-spotify', (_event, value) => {
    const source = parseSourceUrl(value);
    if (source.kind !== 'spotify') throw new Error('Đường dẫn chưa phải bài hát Spotify.');
    const metadata = playlists.findMetadata(source.url);
    return metadata ? downloader!.prepareSpotifyMetadata(metadata) : downloader!.prepareSpotify(source.url);
  });
  handle('music:start-download', (_event, value) => downloader!.start(downloadRequest(value)));
  handle('music:cancel-download', (_event, value) => downloader!.cancel(trackId(value)));
  handle('music:spotify-status', () => spotifyAuth.status());
  handle('music:spotify-connect', () => spotifyAuth.connect());
  handle('music:spotify-cancel-connect', () => spotifyAuth.cancelConnect());
  handle('music:spotify-disconnect', () => spotifyAuth.disconnect());
  handle('music:import-spotify-playlist', (_event, url) => playlists.importSpotify(stringValue(url, 'Playlist URL', 2048)));
  handle('music:import-playlist-file', async () => {
    const selection = await dialog.showOpenDialog(window!, { title: 'Import Spotify playlist CSV / JSON', properties: ['openFile'], filters: [{ name: 'Playlist exports', extensions: ['csv', 'json'] }] });
    return selection.canceled || !selection.filePaths[0] ? null : playlists.importFile(selection.filePaths[0]);
  });
  handle('music:start-playlist-download', (_event, value) => {
    if (!value || typeof value !== 'object') throw new Error('Yêu cầu playlist không hợp lệ.');
    const request = value as Record<string, unknown>;
    if (!Array.isArray(request.entryIds) || request.entryIds.length > 10_000) throw new Error('Danh sách bài được chọn không hợp lệ.');
    const parsed: PlaylistDownloadRequest = { playlistId: trackId(request.playlistId), entryIds: request.entryIds.map(trackId), rightsConfirmed: request.rightsConfirmed === true, autoMatchConfirmed: request.autoMatchConfirmed === true };
    return playlists.start(parsed);
  });
  handle('music:cancel-playlist-download', (_event, id) => playlists.cancel(trackId(id)));
  handle('music:reveal', async (_event, value) => {
    const track = library.get(trackId(value));
    if (!track) throw new Error('Không tìm thấy bài hát trong thư viện.');
    shell.showItemInFolder(track.path);
  });
  handle('music:open-external', async (_event, value) => {
    const url = new URL(stringValue(value, 'Đường dẫn', 2048));
    const allowed = ['open.spotify.com', 'developer.spotify.com', 'github.com', 'www.youtube.com', 'youtube.com', 'youtu.be', 'ffmpeg.org', 'www.ffmpeg.org', 'deno.com', 'console.cloud.google.com', 'developers.google.com'];
    if (url.protocol !== 'https:' || url.username || url.password || !allowed.includes(url.hostname) || url.port) throw new Error('Không được mở đường dẫn bên ngoài này.');
    await shell.openExternal(url.toString());
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1000, minHeight: 680,
    title: 'Luma', backgroundColor: '#f7f8fd', show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(moduleDirectory, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => { if (process.env.LUMA_TEST_MODE !== '1' || app.isPackaged) window?.show(); });
  window.on('closed', () => { window = null; });
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const devUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(devUrl.hostname) || devUrl.protocol !== 'http:') throw new Error('Dev server phải chạy trên localhost.');
    void window.loadURL(devUrl.toString());
  } else void window.loadFile(path.join(moduleDirectory, '../../dist/index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    app.setAppUserModelId('app.luma.desktop');
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await library.initialize();
    profile = new ProfileStore(app.getPath('userData'));
    await profile.initialize();
    driveSync = new DriveSyncService({ userDataDirectory: app.getPath('userData'), defaultSourceDirectory: library.publicSettings().libraryDirectory || path.join(app.getPath('music'), 'Luma', 'Library'), openExternal: url => shell.openExternal(url),
      onStatus: status => { if (window && !window.isDestroyed()) window.webContents.send('music:drive-status', status); },
    });
    await driveSync.initialize();
    spotifyAuth = new SpotifyAuth({ userDataDirectory: app.getPath('userData'), clientId: () => library.settings().spotifyClientId, openExternal: url => shell.openExternal(url) });
    await spotifyAuth.initialize();
    const spotify = new SpotifyClient(() => library.settings(), spotifyAuth);
    shutdownMedia = registerMediaProtocol(library);
    downloader = new Downloader(() => library.settings(), library, job => {
      if (window && !window.isDestroyed()) window.webContents.send('music:download-update', job);
      if (playlists) void playlists.handleDownload(job).catch(error => console.error('Playlist mapping could not be saved:', error));
    }, spotify);
    playlists = new PlaylistManager({ userDataDirectory: app.getPath('userData'), library, spotify, downloader,
      onPlaylist: playlist => { if (window && !window.isDestroyed()) window.webContents.send('music:playlist-update', playlist); },
      onBatch: batch => { if (window && !window.isDestroyed()) window.webContents.send('music:playlist-batch-update', batch); },
    });
    await playlists.initialize();
    installHandlers();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => {
    dialog.showErrorBox('Luma không thể khởi động', (error as Error).message);
    app.quit();
  });
  app.on('before-quit', event => {
    if (!downloader || quitting) return;
    event.preventDefault();
    quitting = true;
    // Wait for child termination and temp-file cleanup before exiting.
    spotifyAuth?.cancelConnect();
    void Promise.allSettled([driveSync?.shutdown(), shutdownMedia?.(), playlists ? playlists.shutdown() : Promise.resolve()]).then(() => downloader!.shutdown()).then(() => library.cleanupManagedCopies()).catch(error => console.error('Library cleanup deferred:', error)).finally(() => app.quit());
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
