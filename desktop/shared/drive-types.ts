export interface DriveConfig {
  desktopClientId: string;
  secretConfigured: boolean;
  sourceDirectory: string;
  autoSync: boolean;
}
export interface DriveConfigUpdate {
  desktopClientId?: string;
  desktopClientSecret?: string;
  sourceDirectory?: string;
  autoSync?: boolean;
}
export interface DriveStatus {
  config: DriveConfig;
  connected: boolean;
  connecting: boolean;
  phase: 'idle' | 'connecting' | 'scanning' | 'uploading' | 'error';
  message?: string;
  folderId?: string;
  filesTotal: number;
  filesDone: number;
  uploaded: number;
  skipped: number;
  failed: number;
  bytesUploaded: number;
  bytesTotal: number;
  progress: number;
  lastSyncAt?: string;
}
