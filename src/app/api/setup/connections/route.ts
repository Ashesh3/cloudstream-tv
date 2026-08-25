import { NextRequest, NextResponse } from "next/server";
import {
  getConnections,
  getPairingSession,
  removeConnection,
} from "@/lib/kv";
import { isPairingMutable } from "@/lib/kv/pairing";
import { toConnectionManagementState } from "@/lib/setup/connections";

async function resolvePairing(code: string | null) {
  if (!code) return null;
  const session = await getPairingSession(code);
  return session && isPairingMutable(session) ? session : null;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const session = await resolvePairing(code);

  if (!session) {
    return NextResponse.json(
      { error: "Pairing session not found or expired" },
      { status: 404 }
    );
  }

  const connections = await getConnections(session.sessionId);
  return NextResponse.json(
    toConnectionManagementState(session.mode ?? "setup", connections)
  );
}

export async function DELETE(request: NextRequest) {
  const body = (await request.json()) as {
    code?: string;
    connectionId?: string;
  };
  const session = await resolvePairing(body.code?.trim() ?? null);

  if (!session || !body.connectionId) {
    return NextResponse.json(
      { error: "Pairing session or connection not found" },
      { status: 404 }
    );
  }

  const connections = await getConnections(session.sessionId);
  if (!connections.some((connection) => connection.id === body.connectionId)) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  await removeConnection(session.sessionId, body.connectionId);
  return NextResponse.json({ removed: true });
}
