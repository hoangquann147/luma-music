import type { DriveConfigUpdate, DriveStatus } from './drive-types';
import type { Album, AlbumCreate, AlbumAssign, LibraryOrganizeResult } from './album-types';
export type TrackSource = 'local' | 'youtube' | 'spotify';
export interface Track {
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
  coverDataUrl?: string;
  addedAt: string;
  source: TrackSource;
  sourceUrl?: string;
  spotifyUrl?: string;
  /** Missing on older library entries, which were FLAC-only. */
  container?: 'FLAC' | 'M4A';
  codec?: string;
  lossless?: boolean;
  bitrate?: number;
  albumId?: string;
  albumArtist?: string;
  originalPath?: string;
  managed?: boolean;
}
export interface DiscordStatus { connected: boolean; message: string; activity?: { details?: string; state?: string } | null; }
export interface Settings {
  discordEnabled?: boolean;
  discordApplicationId?: string;
  discordShowQuality?: boolean;
  minimizeToTray?: boolean;
  crossfadeSeconds?: number;
  automix?: boolean;
  exclusiveMode?: boolean;
  libraryDirectory?: string;
  downloadDirectory: string;
  ytDlpPath: string;
  ffmpegPath: string;
  spotifyClientId: string;
  spotifyConfigured: boolean;
  spotifyMarket: string;
}
export interface SettingsUpdate {
  discordEnabled?: boolean;
  discordApplicationId?: string;
  discordShowQuality?: boolean;
  minimizeToTray?: boolean;
  crossfadeSeconds?: number;
  automix?: boolean;
  exclusiveMode?: boolean;
  libraryDirectory?: string;
  downloadDirectory?: string;
  ytDlpPath?: string;
  ffmpegPath?: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  spotifyMarket?: string;
}
export interface ToolStatus {
  ytDlp: { available: boolean; version?: string; error?: string };
  ffmpeg: { available: boolean; version?: string; error?: string };
}
export interface SpotifyMetadata {
  title: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl?: string;
  releaseDate?: string;
  trackNumber?: number;
  spotifyUrl: string;
}
export interface SourceCandidate {
  id: string;
  title: string;
  channel: string;
  duration: number;
  url: string;
}
export interface SpotifyMatch {
  id: string;
  metadata: SpotifyMetadata;
  candidates: SourceCandidate[];
}
export type DownloadStage = 'queued' | 'resolving' | 'downloading' | 'converting' | 'tagging' | 'completed' | 'cancelled' | 'error';
export interface DownloadJob {
  id: string;
  url: string;
  title: string;
  stage: DownloadStage;
  progress: number;
  message?: string;
  track?: Track;
  createdAt: string;
}
export interface DownloadRequest {
  url: string;
  rightsConfirmed: boolean;
  spotifyMatchId?: string;
  candidateId?: string;
}
export interface SpotifyAuthStatus {
  connected: boolean;
  redirectUri: string;
  displayName?: string;
}
export interface PlaylistTrack {
  id: string;
  metadata: SpotifyMetadata;
  localTrackId?: string;
}
export interface SpotifyPlaylist {
  id: string;
  name: string;
  url?: string;
  coverUrl?: string;
  owner?: string;
  tracks: PlaylistTrack[];
  total: number;
  skipped: number;
  importedAt: string;
  source: 'spotify' | 'file';
}
export type PlaylistItemStage = 'queued' | 'resolving' | 'downloading' | 'completed' | 'error' | 'needs-review' | 'cancelled';
export interface PlaylistBatchItem {
  entryId: string;
  stage: PlaylistItemStage;
  jobId?: string;
  message?: string;
}
export interface PlaylistBatch {
  id: string;
  playlistId: string;
  stage: 'running' | 'completed' | 'cancelled';
  total: number;
  completed: number;
  failed: number;
  reviewRequired: number;
  items: PlaylistBatchItem[];
}
export interface PlaylistDownloadRequest {
  playlistId: string;
  entryIds: string[];
  rightsConfirmed: boolean;
  autoMatchConfirmed: boolean;
}
export interface UserProfile { name: string; avatarDataUrl?: string }
export interface BootstrapData {
  tracks: Track[]; settings: Settings; tools: ToolStatus; jobs: DownloadJob[];
  spotifyAuth: SpotifyAuthStatus; playlists: SpotifyPlaylist[]; playlistBatches: PlaylistBatch[];
  profile: UserProfile;
  albums?: Album[];
}
export interface NativePlaybackState {
  shuffle: boolean;
  repeatMode: 'off' | 'all' | 'one';
  trackId?: string | null;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  queueIds: string[];
  requestedMode: 'shared' | 'exclusive';
  outputMode: 'shared' | 'exclusive';
  bitPerfect: boolean;
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
  crossfading: boolean;
  error?: string | null;
  notice?: string | null;
}
export type NativePlaybackCommand =
  | { op: 'shuffle'; enabled: boolean }
  | { op: 'repeat'; mode: 'off' | 'all' | 'one' }
  | { op: 'play'; trackId: string; queueIds?: string[] }
  | { op: 'setQueue'; queueIds: string[] }
  | { op: 'pause' | 'resume' | 'toggle' | 'next' | 'previous' | 'configure' }
  | { op: 'seek'; position: number }
  | { op: 'volume'; volume: number }
  | { op: 'equalizer'; settings: { enabled: boolean; preampDb: number; autoHeadroom: boolean; gains: number[] } };
export interface MusicAPI {
  discordStatus(): Promise<DiscordStatus>;
  audioCommand(input: NativePlaybackCommand): Promise<NativePlaybackState>;
  audioState(): Promise<NativePlaybackState>;
  onPlaybackState(listener: (state: NativePlaybackState) => void): () => void;
  bootstrap(): Promise<BootstrapData>;
  importFiles(): Promise<Track[]>;
  getAlbums(): Promise<Album[]>;
  createAlbum(input: AlbumCreate): Promise<Album>;
  assignAlbum(input: AlbumAssign): Promise<LibraryOrganizeResult>;
  consolidateLibrary(): Promise<LibraryOrganizeResult>;
  chooseLibraryDirectory(): Promise<string | null>;
  openLibraryDirectory(): Promise<void>;
  removeTrack(id: string): Promise<void>;
  selectDownloadDirectory(): Promise<string | null>;
  saveSettings(update: SettingsUpdate): Promise<Settings>;
  checkTools(): Promise<ToolStatus>;
  prepareSpotify(url: string): Promise<SpotifyMatch>;
  startDownload(request: DownloadRequest): Promise<DownloadJob>;
  cancelDownload(id: string): Promise<void>;
  revealTrack(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onDownloadUpdate(listener: (job: DownloadJob) => void): () => void;
  spotifyStatus(): Promise<SpotifyAuthStatus>;
  connectSpotify(): Promise<SpotifyAuthStatus>;
  cancelSpotifyConnect(): Promise<void>;
  disconnectSpotify(): Promise<SpotifyAuthStatus>;
  importSpotifyPlaylist(url: string): Promise<SpotifyPlaylist>;
  importPlaylistFile(): Promise<SpotifyPlaylist | null>;
  startPlaylistDownload(request: PlaylistDownloadRequest): Promise<PlaylistBatch>;
  cancelPlaylistDownload(id: string): Promise<void>;
  onPlaylistUpdate(listener: (playlist: SpotifyPlaylist) => void): () => void;
  onPlaylistBatchUpdate(listener: (batch: PlaylistBatch) => void): () => void;
  saveProfile(profile: Pick<UserProfile, 'name'>): Promise<UserProfile>;
  chooseProfilePhoto(): Promise<UserProfile | null>;
  driveStatus(): Promise<DriveStatus>;
  saveDriveConfig(update: DriveConfigUpdate): Promise<DriveStatus>;
  chooseDriveDirectory(): Promise<string | null>;
  connectDrive(): Promise<DriveStatus>;
  cancelDriveConnect(): Promise<void>;
  disconnectDrive(): Promise<DriveStatus>;
  syncDriveNow(): Promise<DriveStatus>;
  cancelDriveSync(): Promise<DriveStatus>;
  onDriveStatus(listener: (status: DriveStatus) => void): () => void;
}
export const mediaUrl = (id: string) => `${window.__LUMA_MEDIA_BASE__ || ''}/track/${encodeURIComponent(id)}`;
