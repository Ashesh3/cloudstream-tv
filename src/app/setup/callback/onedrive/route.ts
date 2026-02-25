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
  const azureError = searchParams.get("error");
  const azureErrorDesc = searchParams.get("error_description");

  // Debug: log everything
  const debug: Record<string, unknown> = {
    step: "init",
    hasCode: !!code,
    hasState: !!state,
    state,
    azureError,
    azureErrorDesc,
    allParams: Object.fromEntries(searchParams.entries()),
    appUrl,
    hasOneDriveClientId: !!process.env.ONEDRIVE_CLIENT_ID,
    hasOneDriveClientSecret: !!process.env.ONEDRIVE_CLIENT_SECRET,
    hasKvUrl: !!process.env.KV_REST_API_URL,
    hasKvToken: !!process.env.KV_REST_API_TOKEN,
  };

  if (!code || !state) {
    debug.step = "missing_params";
    debug.error = azureError
      ? `${azureError}: ${azureErrorDesc || "Unknown"}`
      : "code or state missing";
    return NextResponse.json(debug, { status: 400 });
  }

  // Step 2: Look up pairing session
  let pairingSession;
  try {
    pairingSession = await getPairingSession(state);
    debug.step = "pairing_lookup";
    debug.pairingFound = !!pairingSession;
    debug.pairingSessionId = pairingSession?.sessionId;
  } catch (err) {
    debug.step = "pairing_lookup_failed";
    debug.error = err instanceof Error ? err.message : String(err);
    debug.stack = err instanceof Error ? err.stack : undefined;
    return NextResponse.json(debug, { status: 500 });
  }

  if (!pairingSession) {
    debug.step = "pairing_not_found";
    return NextResponse.json(debug, { status: 404 });
  }

  // Step 3: Exchange code for tokens
  let tokens;
  try {
    const redirectUri = `${appUrl}/setup/callback/onedrive`;
    debug.redirectUri = redirectUri;
    debug.step = "exchanging_code";
    tokens = await exchangeOneDriveCode(code, redirectUri);
    debug.step = "code_exchanged";
    debug.email = tokens.email;
    debug.hasAccessToken = !!tokens.accessToken;
    debug.hasRefreshToken = !!tokens.refreshToken;
  } catch (err) {
    debug.step = "code_exchange_failed";
    debug.error = err instanceof Error ? err.message : String(err);
    debug.stack = err instanceof Error ? err.stack : undefined;
    return NextResponse.json(debug, { status: 500 });
  }

  // Step 4: Save connection
  try {
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

    debug.step = "saving_connection";
    await saveConnection(pairingSession.sessionId, connection);
    debug.step = "connection_saved";

    return NextResponse.redirect(
      `${appUrl}/setup?paired=${state}&connectionId=${connectionId}&provider=onedrive`
    );
  } catch (err) {
    debug.step = "save_failed";
    debug.error = err instanceof Error ? err.message : String(err);
    debug.stack = err instanceof Error ? err.stack : undefined;
    return NextResponse.json(debug, { status: 500 });
  }
}
