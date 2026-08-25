import { NextRequest, NextResponse } from "next/server";
import { getConnections, getPairingSession } from "@/lib/kv";
import {
  getValidGoogleAccessToken,
  getValidOneDriveAccessToken,
  listGoogleDriveFolders,
  listOneDriveFolders,
} from "@/lib/cloud";
import { isPairingMutable } from "@/lib/kv/pairing";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const code = searchParams.get("code");
    const connectionId = searchParams.get("connectionId");
    const folderId = searchParams.get("folderId") ?? "root";

    if (!code || !connectionId) {
      return NextResponse.json(
        { error: "Missing required parameters: code, connectionId" },
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

    let folders: Array<{ id: string; name: string }>;

    if (connection.provider === "google") {
      const token = await getValidGoogleAccessToken(
        pairing.sessionId,
        connection
      );
      folders = await listGoogleDriveFolders(token, folderId);
    } else {
      const token = await getValidOneDriveAccessToken(
        pairing.sessionId,
        connection
      );
      folders = await listOneDriveFolders(token, folderId);
    }

    return NextResponse.json({ folders });
  } catch (error) {
    console.error("List folders error:", error);
    return NextResponse.json(
      { error: "Failed to list folders" },
      { status: 500 }
    );
  }
}
