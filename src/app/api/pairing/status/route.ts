import { NextRequest, NextResponse } from "next/server";
import { getPairingSession, getConnections } from "@/lib/kv";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const code = searchParams.get("code");

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

    const connections = await getConnections(session.sessionId);
    const paired = connections.length > 0;

    return NextResponse.json({
      paired,
      ...(paired ? { sessionId: session.sessionId } : {}),
    });
  } catch (error) {
    console.error("Pairing status error:", error);
    return NextResponse.json(
      { error: "Failed to check pairing status" },
      { status: 500 }
    );
  }
}
