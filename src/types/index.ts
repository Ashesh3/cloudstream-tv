export type CloudProvider = "google" | "onedrive";

export interface CloudConnection {
  id: string;
  provider: CloudProvider;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number;
  email: string;
  folders: CloudFolder[];
}

export interface CloudFolder {
  id: string;
  name: string;
  provider: CloudProvider;
  connectionId: string;
}

export interface VideoFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  thumbnailUrl: string | null;
  provider: CloudProvider;
  connectionId: string;
  folderId: string;
  createdAt: string;
  modifiedAt: string;
}

export interface FolderItem {
  id: string;
  name: string;
  provider: CloudProvider;
  connectionId: string;
  parentId: string;
}

export type BrowseItem =
  | ({ type: "video" } & VideoFile)
  | ({ type: "folder" } & FolderItem);

export interface WatchHistory {
  fileId: string;
  provider: CloudProvider;
  position: number;
  duration: number;
  lastWatched: string;
}

export interface PairingSession {
  code: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

export interface StreamUrlResponse {
  url: string;
  expiresAt: number;
}
