import { cookies } from "next/headers";
import { getConnections } from "./storage";

const SESSION_COOKIE = "tv-session-id";

/**
 * Get the session ID from the request cookies.
 */
export async function getSessionId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Validate that a session has at least one cloud connection.
 */
export async function validateSession(sessionId: string): Promise<boolean> {
  const connections = await getConnections(sessionId);
  return connections.length > 0;
}
