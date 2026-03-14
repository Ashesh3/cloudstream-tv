import { ONEDRIVE_OAUTH, VIDEO_EXTENSIONS } from "../constants";
import { updateTokens } from "../kv/storage";
import type { CloudConnection, BrowseItem } from "@/types";

function isVideoFile(mimeType: string | undefined, name: string): boolean {
  if (mimeType?.startsWith("video/")) return true;
  if (mimeType === "application/x-matroska") return true;
  const ext = name.toLowerCase().slice(name.lastIndexOf("."));
  return VIDEO_EXTENSIONS.includes(ext);
}

function resolveVideoMimeType(mimeType: string | undefined, name: string): string {
  if (mimeType?.startsWith("video/")) return mimeType;
  const ext = name.toLowerCase().slice(name.lastIndexOf("."));
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".ts": "video/mp2t",
    ".flv": "video/x-flv",
  };
  return map[ext] || "video/mp4";
}

/**
 * Refresh the OneDrive access token if it is expired or about to expire.
 * Updates KV storage with the new token. Returns the current (or refreshed) access token.
 */
async function refreshAccessToken(
  sessionId: string,
  connection: CloudConnection
): Promise<string> {
  // Refresh if token expires within the next 60 seconds
  if (Date.now() < connection.tokenExpiry - 60_000) {
    return connection.accessToken;
  }

  const response = await fetch(ONEDRIVE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.ONEDRIVE_CLIENT_ID!,
      client_secret: process.env.ONEDRIVE_CLIENT_SECRET!,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token",
      scope: ONEDRIVE_OAUTH.scope,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh OneDrive token: ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  const newExpiry = Date.now() + data.expires_in * 1000;
  await updateTokens(sessionId, connection.id, data.access_token, newExpiry);

  return data.access_token;
}

/**
 * Build the children endpoint URL for either root or a subfolder.
 */
function getChildrenEndpoint(folderId: string): string {
  if (folderId === "root") {
    return `${ONEDRIVE_OAUTH.apiBase}/me/drive/root/children`;
  }
  return `${ONEDRIVE_OAUTH.apiBase}/me/drive/items/${folderId}/children`;
}

/**
 * Attempt to fetch a thumbnail URL for a OneDrive item. Returns null on failure.
 */
async function fetchThumbnailUrl(
  accessToken: string,
  itemId: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `${ONEDRIVE_OAUTH.apiBase}/me/drive/items/${itemId}/thumbnails/0/large`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { url?: string };
    return data.url ?? null;
  } catch {
    return null;
  }
}

/**
 * List files and folders in a OneDrive folder.
 * Returns them as BrowseItem[] (folders first, then videos).
 */
export async function listOneDriveFiles(
  sessionId: string,
  connection: CloudConnection,
  folderId: string
): Promise<BrowseItem[]> {
  const accessToken = await refreshAccessToken(sessionId, connection);
  const endpoint = getChildrenEndpoint(folderId);

  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list OneDrive files: ${errorText}`);
  }

  const data = (await response.json()) as {
    value: Array<{
      id: string;
      name: string;
      size?: number;
      folder?: object;
      file?: { mimeType?: string };
      createdDateTime?: string;
      lastModifiedDateTime?: string;
    }>;
  };

  const items: BrowseItem[] = [];

  // Separate folders and video items so we can fetch thumbnails in parallel
  const videoItems: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    createdDateTime: string;
    lastModifiedDateTime: string;
  }> = [];

  for (const item of data.value) {
    if (item.folder) {
      items.push({
        type: "folder",
        id: item.id,
        name: item.name,
        provider: "onedrive",
        connectionId: connection.id,
        parentId: folderId,
      });
    } else if (isVideoFile(item.file?.mimeType, item.name)) {
      videoItems.push({
        id: item.id,
        name: item.name,
        mimeType: resolveVideoMimeType(item.file?.mimeType, item.name),
        size: item.size ?? 0,
        createdDateTime: item.createdDateTime ?? "",
        lastModifiedDateTime: item.lastModifiedDateTime ?? "",
      });
    }
  }

  // Fetch all video thumbnails in parallel
  const thumbnailUrls = await Promise.all(
    videoItems.map((v) => fetchThumbnailUrl(accessToken, v.id))
  );

  for (let i = 0; i < videoItems.length; i++) {
    const v = videoItems[i];
    items.push({
      type: "video",
      id: v.id,
      name: v.name,
      mimeType: v.mimeType,
      size: v.size,
      thumbnailUrl: thumbnailUrls[i],
      provider: "onedrive",
      connectionId: connection.id,
      folderId,
      createdAt: v.createdDateTime,
      modifiedAt: v.lastModifiedDateTime,
    });
  }

  return items;
}

/**
 * Get a direct download/stream URL for a OneDrive file.
 * Uses the @microsoft.graph.downloadUrl field from the item metadata.
 */
export async function getOneDriveStreamUrl(
  sessionId: string,
  connection: CloudConnection,
  fileId: string
): Promise<string> {
  const accessToken = await refreshAccessToken(sessionId, connection);

  const response = await fetch(
    `${ONEDRIVE_OAUTH.apiBase}/me/drive/items/${fileId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get OneDrive stream URL: ${errorText}`);
  }

  const data = (await response.json()) as {
    "@microsoft.graph.downloadUrl"?: string;
  };

  const downloadUrl = data["@microsoft.graph.downloadUrl"];
  if (!downloadUrl) {
    throw new Error("No download URL available for this OneDrive file");
  }

  return downloadUrl;
}

/**
 * Build the OneDrive/Microsoft OAuth authorization URL.
 */
export function getOneDriveOAuthUrl(
  redirectUri: string,
  state: string
): string {
  const url = new URL(ONEDRIVE_OAUTH.authUrl);
  url.searchParams.set("client_id", process.env.ONEDRIVE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ONEDRIVE_OAUTH.scope);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Exchange an authorization code for tokens and fetch the user's email.
 */
export async function exchangeOneDriveCode(
  code: string,
  redirectUri: string
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  email: string;
}> {
  const tokenResponse = await fetch(ONEDRIVE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.ONEDRIVE_CLIENT_ID!,
      client_secret: process.env.ONEDRIVE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: ONEDRIVE_OAUTH.scope,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Failed to exchange OneDrive auth code: ${errorText}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Fetch user email from Microsoft Graph /me endpoint
  const userResponse = await fetch(`${ONEDRIVE_OAUTH.apiBase}/me`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  let email = "unknown";
  if (userResponse.ok) {
    const userData = (await userResponse.json()) as {
      mail?: string;
      userPrincipalName?: string;
    };
    email = userData.mail ?? userData.userPrincipalName ?? "unknown";
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    email,
  };
}

/**
 * List only folders in a OneDrive parent folder (for folder picker).
 */
export async function listOneDriveFolders(
  token: string,
  parentId: string
): Promise<Array<{ id: string; name: string }>> {
  const endpoint = getChildrenEndpoint(parentId);

  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list OneDrive folders: ${errorText}`);
  }

  const data = (await response.json()) as {
    value: Array<{
      id: string;
      name: string;
      folder?: object;
    }>;
  };

  return data.value
    .filter((item) => item.folder)
    .map((item) => ({ id: item.id, name: item.name }));
}
