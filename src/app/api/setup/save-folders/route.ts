import { NextRequest, NextResponse } from "next/server";
import { getConnections, saveConnection, getSessionIdFromRequest } from "@/lib/kv";
import type { CloudFolder } from "@/types";

export async function POST(request: NextRequest) {
  try {
    const sessionIdFromReq = getSessionIdFromRequest(request);
    const body = (await request.json()) as {
      sessionId?: string;
      connectionId?: string;
      folders?: Array<{ id: string; name: string }>;
    };

    const { connectionId, folders } = body;
    // Allow body.sessionId as legacy fallback
    const sessionId = sessionIdFromReq ?? body.sessionId ?? null;

    if (!sessionId || !connectionId || !folders) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: sessionId, connectionId, folders",
        },
        { status: 400 }
      );
    }

    const connections = await getConnections(sessionId);
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
    await saveConnection(sessionId, connection);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Save folders error:", error);
    return NextResponse.json(
      { error: "Failed to save folders" },
      { status: 500 }
    );
  }
}
