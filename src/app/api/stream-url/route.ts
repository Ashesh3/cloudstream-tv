import { NextRequest, NextResponse } from "next/server";
import { getConnections } from "@/lib/kv";
import {
  getGoogleDriveStreamUrl,
  getOneDriveStreamUrl,
} from "@/lib/cloud";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const fileId = searchParams.get("fileId");
    const provider = searchParams.get("provider");
    const connectionId = searchParams.get("connectionId");
    const sessionId = searchParams.get("sessionId");

    if (!fileId || !provider || !connectionId || !sessionId) {
      return NextResponse.json(
        { error: "Missing required parameters: fileId, provider, connectionId, sessionId" },
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

    let url: string;

    if (provider === "google") {
      url = await getGoogleDriveStreamUrl(sessionId, connection, fileId);
    } else if (provider === "onedrive") {
      url = await getOneDriveStreamUrl(sessionId, connection, fileId);
    } else {
      return NextResponse.json(
        { error: "Invalid provider" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      url,
      expiresAt: Date.now() + 3_600_000,
    });
  } catch (error) {
    console.error("Stream URL error:", error);
    return NextResponse.json(
      { error: "Failed to get stream URL" },
      { status: 500 }
    );
  }
}
