export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
export const POLL_INTERVAL_MS = 3000;
export const WATCH_HISTORY_SAVE_INTERVAL_MS = 30_000; // 30 seconds
export const CONTROLS_AUTO_HIDE_MS = 5000;
export const SEEK_STEP_SECONDS = 10;
export const SEEK_LONG_STEP_SECONDS = 30;
export const BUFFER_AHEAD_SECONDS = 120;
export const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".m4v"];
export const VIDEO_MIME_PREFIXES = ["video/mp4", "video/webm", "video/quicktime"];

export const KV_KEYS = {
  connections: (sessionId: string) => `connections:${sessionId}`,
  watchHistory: (sessionId: string, fileId: string) =>
    `watch-history:${sessionId}:${fileId}`,
  pairing: (code: string) => `pairing:${code}`,
  session: (sessionId: string) => `session:${sessionId}`,
} as const;

export const GOOGLE_OAUTH = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scope: "https://www.googleapis.com/auth/drive.readonly",
  apiBase: "https://www.googleapis.com/drive/v3",
} as const;

export const ONEDRIVE_OAUTH = {
  authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scope: "Files.Read offline_access",
  apiBase: "https://graph.microsoft.com/v1.0",
} as const;
