import { NextRequest, NextResponse } from "next/server";
import { getWatchHistory, saveWatchHistory, getSessionIdFromRequest } from "@/lib/kv";
import type { WatchHistory } from "@/types";

export async function GET(request: NextRequest) {
  try {
    const sessionId = getSessionIdFromRequest(request);
    const { searchParams } = request.nextUrl;
    const fileId = searchParams.get("fileId");

    if (!sessionId || !fileId) {
      return NextResponse.json(
        { error: "Missing required parameters: sessionId, fileId" },
        { status: 400 }
      );
    }

    const history = await getWatchHistory(sessionId, fileId);

    return NextResponse.json({ history });
  } catch (error) {
    console.error("Watch history GET error:", error);
    return NextResponse.json(
      { error: "Failed to get watch history" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessionId = getSessionIdFromRequest(request);
    const body = (await request.json()) as {
      sessionId?: string;
      fileId?: string;
      provider?: string;
      position?: number;
      duration?: number;
    };

    const { fileId, provider, position, duration } = body;
    // Allow body.sessionId as legacy fallback
    const resolvedSessionId = sessionId ?? body.sessionId ?? null;

    if (
      !resolvedSessionId ||
      !fileId ||
      !provider ||
      position === undefined ||
      duration === undefined
    ) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: sessionId, fileId, provider, position, duration",
        },
        { status: 400 }
      );
    }

    if (provider !== "google" && provider !== "onedrive") {
      return NextResponse.json(
        { error: "Invalid provider" },
        { status: 400 }
      );
    }

    const history: WatchHistory = {
      fileId,
      provider,
      position,
      duration,
      lastWatched: new Date().toISOString(),
    };

    await saveWatchHistory(resolvedSessionId, history);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Watch history POST error:", error);
    return NextResponse.json(
      { error: "Failed to save watch history" },
      { status: 500 }
    );
  }
}
