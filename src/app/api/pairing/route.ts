import { NextResponse } from "next/server";
import { createPairingSession } from "@/lib/kv";

export async function POST() {
  try {
    const session = await createPairingSession();

    return NextResponse.json({
      code: session.code,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    console.error("Pairing creation error:", error);
    return NextResponse.json(
      { error: "Failed to create pairing session" },
      { status: 500 }
    );
  }
}
