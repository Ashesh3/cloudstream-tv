import { NextRequest, NextResponse } from "next/server";
import { getConnections, getSessionIdFromRequest } from "@/lib/kv";
import { listGoogleDriveFolders, listOneDriveFolders } from "@/lib/cloud";

export async function GET(request: NextRequest) {
  try {
    const sessionId = getSessionIdFromRequest(request);
    const { searchParams } = request.nextUrl;
    const connectionId = searchParams.get("connectionId");
    const folderId = searchParams.get("folderId") ?? "root";

    if (!sessionId || !connectionId) {
      return NextResponse.json(
        { error: "Missing required parameters: sessionId, connectionId" },
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

    let folders: Array<{ id: string; name: string }>;

    if (connection.provider === "google") {
      folders = await listGoogleDriveFolders(connection.accessToken, folderId);
    } else {
      folders = await listOneDriveFolders(connection.accessToken, folderId);
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
