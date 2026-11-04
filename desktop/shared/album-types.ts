import type { Track } from './types';

export interface Album {
  id: string;
  name: string;
  artist: string;
  folder: string;
  createdAt: string;
  kind: 'metadata' | 'manual';
  trackCount: number;
  coverDataUrl?: string;
}
export interface AlbumCreate { name: string; artist?: string }
export interface AlbumAssign { albumId: string; trackIds: string[] }
export interface LibraryOrganizeResult {
  tracks: Track[];
  albums: Album[];
  copied: number;
  failed: { trackId: string; title: string; error: string }[];
}
