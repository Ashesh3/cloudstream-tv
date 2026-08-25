import { NextRequest, NextResponse } from "next/server";
import {
  completePairingSession,
  getConnections,
  getPairingSession,
} from "@/lib/kv";
import { isPairingMutable } from "@/lib/kv/pairing";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { code?: string };
  const code = body.code?.trim();

  if (!code) {
    return NextResponse.json({ error: "Missing pairing code" }, { status: 400 });
  }

  const session = await getPairingSession(code);
  if (!session) {
    return NextResponse.json(
      { error: "Pairing session not found or expired" },
      { status: 404 }
    );
  }

  if (!isPairingMutable(session)) {
    return NextResponse.json(
      { error: "Pairing session is already complete" },
      { status: 409 }
    );
  }

  const connections = await getConnections(session.sessionId);
  const hasConfiguredSource = connections.some(
    (connection) => connection.folders.length > 0
  );

  if (session.mode !== "manage" && !hasConfiguredSource) {
    return NextResponse.json(
      { error: "Configure at least one folder before finishing" },
      { status: 400 }
    );
  }

  await completePairingSession(code);
  return NextResponse.json({ complete: true });
}
