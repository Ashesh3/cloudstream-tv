import { NextRequest, NextResponse } from "next/server";
import { createPairingSession } from "@/lib/kv";
import { getSessionIdFromRequest, validateSession } from "@/lib/kv/session";

export async function POST(request: NextRequest) {
  try {
    const requestedSessionId = getSessionIdFromRequest(request);
    const existingSessionId =
      requestedSessionId && (await validateSession(requestedSessionId))
        ? requestedSessionId
        : null;
    const session = await createPairingSession(existingSessionId);

    return NextResponse.json({
      code: session.code,
      expiresAt: session.expiresAt,
      mode: session.mode,
      pollToken: session.pollToken,
    });
  } catch (error) {
    console.error("Pairing creation error:", error);
    return NextResponse.json(
      { error: "Failed to create pairing session" },
      { status: 500 }
    );
  }
}
