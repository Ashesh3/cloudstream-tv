import { NextRequest, NextResponse } from "next/server";
import { getConnections, getSessionIdFromRequest } from "@/lib/kv";
import { listGoogleDriveFiles, listOneDriveFiles } from "@/lib/cloud";
import type { BrowseItem } from "@/types";

export async function GET(request: NextRequest) {
  try {
    const sessionId = getSessionIdFromRequest(request);
    const { searchParams } = request.nextUrl;
    const connectionId = searchParams.get("connectionId");
    const folderId = searchParams.get("folderId");

    if (!sessionId) {
      return NextResponse.json(
        { error: "Missing required parameter: sessionId" },
        { status: 400 }
      );
    }

    // Browse a specific folder within a specific connection
    if (connectionId && folderId) {
      const connections = await getConnections(sessionId);
      const connection = connections.find((c) => c.id === connectionId);

      if (!connection) {
        return NextResponse.json(
          { error: "Connection not found" },
          { status: 404 }
        );
      }

      let items: BrowseItem[];

      if (connection.provider === "google") {
        items = await listGoogleDriveFiles(sessionId, connection, folderId);
      } else {
        items = await listOneDriveFiles(sessionId, connection, folderId);
      }

      return NextResponse.json({ items });
    }

    // Browse all configured folders across all connections
    const connections = await getConnections(sessionId);
    const folders: Array<{
      connectionId: string;
      provider: string;
      email: string;
      folderName: string;
      items: BrowseItem[];
    }> = [];

    for (const connection of connections) {
      for (const folder of connection.folders) {
        let items: BrowseItem[];

        if (connection.provider === "google") {
          items = await listGoogleDriveFiles(
            sessionId,
            connection,
            folder.id
          );
        } else {
          items = await listOneDriveFiles(
            sessionId,
            connection,
            folder.id
          );
        }

        folders.push({
          connectionId: connection.id,
          provider: connection.provider,
          email: connection.email,
          folderName: folder.name,
          items,
        });
      }
    }

    return NextResponse.json({ folders });
  } catch (error) {
    console.error("Browse error:", error);
    return NextResponse.json(
      { error: "Failed to browse files" },
      { status: 500 }
    );
  }
}
