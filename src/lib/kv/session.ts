import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import { getConnections } from "./storage";

export const SESSION_COOKIE = "tv-session-id";
export const SESSION_HEADER = "x-session-id";
const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * Persist the TV session from a server response. Some smart-TV browsers do
 * not reliably accept cookies written through document.cookie, but do accept
 * normal Set-Cookie response headers.
 */
export function setSessionCookie(response: NextResponse, sessionId: string) {
  response.cookies.set(SESSION_COOKIE, sessionId, {
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", {
    path: "/",
    maxAge: 0,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

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
