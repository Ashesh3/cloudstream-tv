import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getConnections } from "./storage";

const SESSION_COOKIE = "tv-session-id";
const SESSION_HEADER = "x-session-id";

/**
 * Get the session ID from the request cookies.
 */
export async function getSessionId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Extract the session ID from a NextRequest.
 * Checks (in order): cookie, X-Session-Id header, query parameter.
 */
export function getSessionIdFromRequest(request: NextRequest): string | null {
  // 1. Cookie
  const fromCookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (fromCookie) return fromCookie;

  // 2. X-Session-Id header
  const fromHeader = request.headers.get(SESSION_HEADER);
  if (fromHeader) return fromHeader;

  // 3. Query parameter (legacy fallback)
  const fromQuery = request.nextUrl.searchParams.get("sessionId");
  return fromQuery ?? null;
}

/**
 * Validate that a session has at least one cloud connection.
 */
export async function validateSession(sessionId: string): Promise<boolean> {
  const connections = await getConnections(sessionId);
  return connections.length > 0;
}
