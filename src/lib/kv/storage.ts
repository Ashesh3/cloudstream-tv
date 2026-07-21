import { put, get, del } from "@vercel/blob";
import { v4 as uuidv4 } from "uuid";
import { KV_KEYS, PAIRING_CODE_EXPIRY_MS } from "../constants";
import type { CloudConnection, WatchHistory, PairingSession } from "@/types";

/**
 * Storage layer backed by Vercel Blob.
 *
 * Auth resolves automatically:
 *   - On Vercel (prod/preview): secretless via VERCEL_OIDC_TOKEN + BLOB_STORE_ID.
 *   - Locally / migration: BLOB_READ_WRITE_TOKEN.
 *
 * All blobs are `private` (they hold OAuth tokens) and are read with
 * `useCache: false` so a read always reflects the most recent write
 * (read-after-write consistency, which token refresh relies on).
 *
 * There is no native TTL in Blob. The only TTL user (pairing sessions) is
 * handled at the application level via an `expiresAt` check in
 * getPairingSession(), so behaviour is unchanged.
 */

/**
 * Map a logical KV key (e.g. "watch-history:sid:fileId") to a Blob pathname.
 * Each colon-separated segment is encoded and joined with "/", producing a
 * stable, collision-free, human-readable path like
 * "kv/watch-history/<sid>/<fileId>.json".
 */
function keyToPath(key: string): string {
  return "kv/" + key.split(":").map(encodeURIComponent).join("/") + ".json";
}

async function kvGet<T>(key: string): Promise<T | null> {
  try {
    const res = await get(keyToPath(key), { access: "private", useCache: false });
    if (!res || res.statusCode !== 200) return null;
    const text = await new Response(res.stream).text();
    return JSON.parse(text) as T;
  } catch {
    // Not found (or unreadable) behaves like a missing key.
    return null;
  }
}

async function kvSet(key: string, value: unknown): Promise<void> {
  await put(keyToPath(key), JSON.stringify(value), {
    access: "private",
    allowOverwrite: true,
    contentType: "application/json",
    // Minimum allowed is 60s; irrelevant to correctness because every read
    // uses `useCache: false` and hits origin directly.
    cacheControlMaxAge: 60,
  });
}

async function kvDel(key: string): Promise<void> {
  // del() is idempotent — deleting a missing pathname is a no-op.
  await del(keyToPath(key));
}

/**
 * Get all cloud connections for a session.
 */
export async function getConnections(
  sessionId: string
): Promise<CloudConnection[]> {
  const connections = await kvGet<CloudConnection[]>(
    KV_KEYS.connections(sessionId)
  );
  return connections ?? [];
}

/**
 * Save (upsert) a cloud connection for a session.
 */
export async function saveConnection(
  sessionId: string,
  connection: CloudConnection
): Promise<void> {
  const existing = await getConnections(sessionId);
  const index = existing.findIndex((c) => c.id === connection.id);
  if (index >= 0) {
    existing[index] = connection;
  } else {
    existing.push(connection);
  }
  await kvSet(KV_KEYS.connections(sessionId), existing);
}

/**
 * Remove a cloud connection by id from a session.
 */
export async function removeConnection(
  sessionId: string,
  connectionId: string
): Promise<void> {
  const existing = await getConnections(sessionId);
  const filtered = existing.filter((c) => c.id !== connectionId);
  await kvSet(KV_KEYS.connections(sessionId), filtered);
}

/**
 * Update the access token and expiry for a specific connection.
 */
export async function updateTokens(
  sessionId: string,
  connectionId: string,
  accessToken: string,
  tokenExpiry: number
): Promise<void> {
  const existing = await getConnections(sessionId);
  const connection = existing.find((c) => c.id === connectionId);
  if (connection) {
    connection.accessToken = accessToken;
    connection.tokenExpiry = tokenExpiry;
    await kvSet(KV_KEYS.connections(sessionId), existing);
  }
}

/**
 * Get watch history for a specific file in a session.
 */
export async function getWatchHistory(
  sessionId: string,
  fileId: string
): Promise<WatchHistory | null> {
  return kvGet<WatchHistory>(KV_KEYS.watchHistory(sessionId, fileId));
}

/**
 * Save watch history for a file.
 */
export async function saveWatchHistory(
  sessionId: string,
  history: WatchHistory
): Promise<void> {
  await kvSet(KV_KEYS.watchHistory(sessionId, history.fileId), history);
}

/**
 * Generate a random pairing code in the format TV-XXXXXX (uppercase alphanumeric).
 */
function generatePairingCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "TV-";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Create a new pairing session with a generated code and session id.
 */
export async function createPairingSession(): Promise<PairingSession> {
  const code = generatePairingCode();
  const sessionId = uuidv4();
  const now = Date.now();
  const session: PairingSession = {
    code,
    sessionId,
    createdAt: now,
    expiresAt: now + PAIRING_CODE_EXPIRY_MS,
  };

  await kvSet(KV_KEYS.pairing(code), session);

  return session;
}

/**
 * Get a pairing session by code. Returns null if not found or expired.
 * Expiry is enforced here (Blob has no native TTL): an expired session is
 * deleted and treated as absent.
 */
export async function getPairingSession(
  code: string
): Promise<PairingSession | null> {
  const session = await kvGet<PairingSession>(KV_KEYS.pairing(code));

  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    await kvDel(KV_KEYS.pairing(code));
    return null;
  }

  return session;
}

/**
 * Delete a pairing session by code.
 */
export async function deletePairingSession(code: string): Promise<void> {
  await kvDel(KV_KEYS.pairing(code));
}
