import { NextRequest, NextResponse } from "next/server";
import { getConnections, getPairingSession, saveConnection } from "@/lib/kv";
import { isPairingMutable } from "@/lib/kv/pairing";
import type { CloudFolder } from "@/types";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      code?: string;
      connectionId?: string;
      folders?: Array<{ id: string; name: string }>;
    };

    const { code, connectionId, folders } = body;

    if (!code || !connectionId || !folders) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: code, connectionId, folders",
        },
        { status: 400 }
      );
    }

    const pairing = await getPairingSession(code);
    if (!pairing || !isPairingMutable(pairing)) {
      return NextResponse.json(
        { error: "Pairing session not found, expired, or complete" },
        { status: 404 }
      );
    }

    const connections = await getConnections(pairing.sessionId);
    const connection = connections.find((c) => c.id === connectionId);

    if (!connection) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }

    const cloudFolders: CloudFolder[] = folders.map((f) => ({
      id: f.id,
      name: f.name,
      provider: connection.provider,
      connectionId: connection.id,
    }));

    connection.folders = cloudFolders;
    await saveConnection(pairing.sessionId, connection);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Save folders error:", error);
    return NextResponse.json(
      { error: "Failed to save folders" },
      { status: 500 }
    );
  }
}
