import { NextRequest, NextResponse } from "next/server";
import { getPairingSession, getConnections } from "@/lib/kv";
import { setSessionCookie } from "@/lib/kv/session";
import {
  isPairingPollAuthorized,
  summarizePairingConnections,
} from "@/lib/kv/pairing";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const code = searchParams.get("code");
    const pollToken = request.headers.get("x-pairing-poll-token");

    if (!code) {
      return NextResponse.json(
        { error: "Missing required parameter: code" },
        { status: 400 }
      );
    }

    const session = await getPairingSession(code);

    if (!session) {
      return NextResponse.json(
        { error: "Pairing session not found or expired" },
        { status: 404 }
      );
    }

    if (!isPairingPollAuthorized(session, pollToken)) {
      return NextResponse.json({ error: "Unauthorized poll" }, { status: 403 });
    }

    const connections = await getConnections(session.sessionId);
    const configuration = summarizePairingConnections(
      connections.map((connection) => connection.folders.length)
    );
    // Pairing sessions created before explicit completion existed retain the
    // legacy behavior. New setup/manage sessions wait until the phone presses
    // Finish so multiple sources can be configured in one pass.
    const paired = session.mode
      ? Boolean(session.completedAt)
      : configuration.paired;

    const response = NextResponse.json({
      paired,
      complete: paired,
      hasConnections: configuration.hasConnections,
      ...(paired ? { sessionId: session.sessionId } : {}),
      mode: session.mode ?? "setup",
    });

    if (paired) {
      setSessionCookie(response, session.sessionId);
    }

    return response;
  } catch (error) {
    console.error("Pairing status error:", error);
    return NextResponse.json(
      { error: "Failed to check pairing status" },
      { status: 500 }
    );
  }
}
