import { NextRequest, NextResponse } from "next/server";
import {
  clearSessionCookie,
  getSessionIdFromRequest,
  setSessionCookie,
  validateSession,
} from "@/lib/kv/session";

/** Restore a server-issued session cookie from the TV's retained session. */
export async function POST(request: NextRequest) {
  const sessionId = getSessionIdFromRequest(request);

  if (!sessionId) {
    return NextResponse.json({ error: "Missing session ID" }, { status: 400 });
  }

  if (!(await validateSession(sessionId))) {
    const response = NextResponse.json(
      { error: "Session not found" },
      { status: 404 }
    );
    clearSessionCookie(response);
    return response;
  }

  const response = NextResponse.json({ restored: true });
  setSessionCookie(response, sessionId);
  return response;
}

/** Clear the HTTP-only session cookie before starting a fresh pairing. */
export async function DELETE() {
  const response = NextResponse.json({ cleared: true });
  clearSessionCookie(response);
  return response;
}
