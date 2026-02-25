import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getPairingSession, saveConnection } from "@/lib/kv";
import { exchangeOneDriveCode } from "@/lib/cloud";
import type { CloudConnection } from "@/types";

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  // Azure may return an error instead of a code
  const azureError = searchParams.get("error");
  const azureErrorDesc = searchParams.get("error_description");

  if (!code || !state) {
    const errorMsg = azureError
      ? `${azureError}: ${azureErrorDesc || "Unknown error"}`
      : "missing_params";
    return NextResponse.redirect(
      `${appUrl}/setup?error=${encodeURIComponent(errorMsg)}`
    );
  }

  const pairingSession = await getPairingSession(state);

  if (!pairingSession) {
    return NextResponse.redirect(
      `${appUrl}/setup?error=session_expired`
    );
  }

  try {
    const redirectUri = `${appUrl}/setup/callback/onedrive`;
    const tokens = await exchangeOneDriveCode(code, redirectUri);

    const connectionId = uuidv4();
    const connection: CloudConnection = {
      id: connectionId,
      provider: "onedrive",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiry: Date.now() + tokens.expiresIn * 1000,
      email: tokens.email,
      folders: [],
    };

    await saveConnection(pairingSession.sessionId, connection);

    return NextResponse.redirect(
      `${appUrl}/setup?paired=${state}&connectionId=${connectionId}&provider=onedrive`
    );
  } catch (error) {
    console.error("OneDrive OAuth callback error:", error);
    return NextResponse.redirect(
      `${appUrl}/setup?error=oauth_failed`
    );
  }
}
