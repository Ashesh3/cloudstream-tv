import { GOOGLE_OAUTH } from "../constants";
import { updateTokens } from "../kv/storage";
import type { CloudConnection, BrowseItem } from "@/types";

/**
 * Refresh the Google access token if it is expired or about to expire.
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

  const response = await fetch(GOOGLE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Google token: ${errorText}`);
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
 * List files and folders in a Google Drive folder.
 * Returns them as BrowseItem[] (folders first, then videos).
 */
export async function listGoogleDriveFiles(
  sessionId: string,
  connection: CloudConnection,
  folderId: string
): Promise<BrowseItem[]> {
  const accessToken = await refreshAccessToken(sessionId, connection);

  const query = `'${folderId}' in parents and trashed = false`;
  const fields =
    "files(id,name,mimeType,size,thumbnailLink,createdTime,modifiedTime)";

  const url = new URL(`${GOOGLE_OAUTH.apiBase}/files`);
  url.searchParams.set("q", query);
  url.searchParams.set("fields", fields);
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set("orderBy", "folder,name");

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list Google Drive files: ${errorText}`);
  }

  const data = (await response.json()) as {
    files: Array<{
      id: string;
      name: string;
      mimeType: string;
      size?: string;
      thumbnailLink?: string;
      createdTime?: string;
      modifiedTime?: string;
    }>;
  };

  const items: BrowseItem[] = [];

  for (const file of data.files) {
    if (file.mimeType === "application/vnd.google-apps.folder") {
      items.push({
        type: "folder",
        id: file.id,
        name: file.name,
        provider: "google",
        connectionId: connection.id,
        parentId: folderId,
      });
    } else if (file.mimeType.startsWith("video/")) {
      items.push({
        type: "video",
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size ? parseInt(file.size, 10) : 0,
        thumbnailUrl: file.thumbnailLink ?? null,
        provider: "google",
        connectionId: connection.id,
        folderId,
        createdAt: file.createdTime ?? "",
        modifiedAt: file.modifiedTime ?? "",
      });
    }
  }

  return items;
}

/**
 * Get a direct download/stream URL for a Google Drive file.
 * Uses the alt=media endpoint with an access token.
 */
export async function getGoogleDriveStreamUrl(
  sessionId: string,
  connection: CloudConnection,
  fileId: string
): Promise<string> {
  const accessToken = await refreshAccessToken(sessionId, connection);
  return `${GOOGLE_OAUTH.apiBase}/files/${fileId}?alt=media&access_token=${encodeURIComponent(accessToken)}`;
}

/**
 * Build the Google OAuth authorization URL.
 */
export function getGoogleOAuthUrl(redirectUri: string, state: string): string {
  const url = new URL(GOOGLE_OAUTH.authUrl);
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_OAUTH.scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Exchange an authorization code for tokens and fetch the user's email.
 */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  email: string;
}> {
  const tokenResponse = await fetch(GOOGLE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Failed to exchange Google auth code: ${errorText}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Fetch user email from userinfo endpoint
  const userResponse = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    }
  );

  if (!userResponse.ok) {
    throw new Error("Failed to fetch Google user info");
  }

  const userData = (await userResponse.json()) as { email: string };

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    email: userData.email,
  };
}

/**
 * List only folders in a Google Drive parent folder (for folder picker).
 */
export async function listGoogleDriveFolders(
  token: string,
  parentId: string
): Promise<Array<{ id: string; name: string }>> {
  const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const fields = "files(id,name)";

  const url = new URL(`${GOOGLE_OAUTH.apiBase}/files`);
  url.searchParams.set("q", query);
  url.searchParams.set("fields", fields);
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set("orderBy", "name");

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list Google Drive folders: ${errorText}`);
  }

  const data = (await response.json()) as {
    files: Array<{ id: string; name: string }>;
  };

  return data.files;
}
