import { kv } from "@vercel/kv";
import { v4 as uuidv4 } from "uuid";
import { KV_KEYS, PAIRING_CODE_EXPIRY_MS } from "../constants";
import type { CloudConnection, WatchHistory, PairingSession } from "@/types";

/**
 * Get all cloud connections for a session.
 */
export async function getConnections(
  sessionId: string
): Promise<CloudConnection[]> {
  const key = KV_KEYS.connections(sessionId);
  const connections = await kv.get<CloudConnection[]>(key);
  return connections ?? [];
}

/**
 * Save (upsert) a cloud connection for a session.
 * If a connection with the same id exists, it is replaced; otherwise it is appended.
 */
export async function saveConnection(
  sessionId: string,
  connection: CloudConnection
): Promise<void> {
  const key = KV_KEYS.connections(sessionId);
  const existing = await getConnections(sessionId);
  const index = existing.findIndex((c) => c.id === connection.id);
  if (index >= 0) {
    existing[index] = connection;
  } else {
    existing.push(connection);
  }
  await kv.set(key, existing);
}

/**
 * Remove a cloud connection by id from a session.
 */
export async function removeConnection(
  sessionId: string,
  connectionId: string
): Promise<void> {
  const key = KV_KEYS.connections(sessionId);
  const existing = await getConnections(sessionId);
  const filtered = existing.filter((c) => c.id !== connectionId);
  await kv.set(key, filtered);
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
  const key = KV_KEYS.connections(sessionId);
  const existing = await getConnections(sessionId);
  const connection = existing.find((c) => c.id === connectionId);
  if (connection) {
    connection.accessToken = accessToken;
    connection.tokenExpiry = tokenExpiry;
    await kv.set(key, existing);
  }
}

/**
 * Get watch history for a specific file in a session.
 */
export async function getWatchHistory(
  sessionId: string,
  fileId: string
): Promise<WatchHistory | null> {
  const key = KV_KEYS.watchHistory(sessionId, fileId);
  return kv.get<WatchHistory>(key);
}

/**
 * Save watch history for a file.
 */
export async function saveWatchHistory(
  sessionId: string,
  history: WatchHistory
): Promise<void> {
  const key = KV_KEYS.watchHistory(sessionId, history.fileId);
  await kv.set(key, history);
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
 * Stored in KV with an expiry matching PAIRING_CODE_EXPIRY_MS.
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

  const key = KV_KEYS.pairing(code);
  const expirySeconds = Math.ceil(PAIRING_CODE_EXPIRY_MS / 1000);
  await kv.set(key, session, { ex: expirySeconds });

  return session;
}

/**
 * Get a pairing session by code. Returns null if not found or expired.
 */
export async function getPairingSession(
  code: string
): Promise<PairingSession | null> {
  const key = KV_KEYS.pairing(code);
  const session = await kv.get<PairingSession>(key);

  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    await kv.del(key);
    return null;
  }

  return session;
}

/**
 * Delete a pairing session by code.
 */
export async function deletePairingSession(code: string): Promise<void> {
  const key = KV_KEYS.pairing(code);
  await kv.del(key);
}
