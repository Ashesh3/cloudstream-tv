import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getPairingSession, saveConnection } from "@/lib/kv";
import { exchangeGoogleCode } from "@/lib/cloud";
import { GOOGLE_OAUTH } from "@/lib/constants";
import type { CloudConnection } from "@/types";

async function getGoogleFolderName(token: string, folderId: string): Promise<string> {
  const res = await fetch(
    `${GOOGLE_OAUTH.apiBase}/files/${folderId}?fields=name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return folderId;
  const data = await res.json();
  return data.name || folderId;
}

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");

  const debug: Record<string, unknown> = {
    step: "init",
    hasCode: !!code,
    hasState: !!state,
    state,
    oauthError,
    allParams: Object.fromEntries(searchParams.entries()),
    appUrl,
  };

  if (!code || !state) {
    debug.step = "missing_params";
    debug.error = oauthError || "code or state missing";
    return NextResponse.json(debug, { status: 400 });
  }

  let pairingSession;
  try {
    pairingSession = await getPairingSession(state);
    debug.step = "pairing_lookup";
    debug.pairingFound = !!pairingSession;
  } catch (err) {
    debug.step = "pairing_lookup_failed";
    debug.error = err instanceof Error ? err.message : String(err);
    return NextResponse.json(debug, { status: 500 });
  }

  if (!pairingSession) {
    debug.step = "pairing_not_found";
    return NextResponse.json(debug, { status: 404 });
  }

  let tokens;
  try {
    const redirectUri = `${appUrl}/setup/callback/google`;
    tokens = await exchangeGoogleCode(code, redirectUri);
    debug.step = "code_exchanged";
  } catch (err) {
    debug.step = "code_exchange_failed";
    debug.error = err instanceof Error ? err.message : String(err);
    return NextResponse.json(debug, { status: 500 });
  }

  try {
    const connectionId = uuidv4();

    // Auto-configure default folder if env var is set
    const defaultFolderId = process.env.DEFAULT_GOOGLE_FOLDER_ID;
    const folders = [];
    if (defaultFolderId) {
      const folderName = await getGoogleFolderName(tokens.accessToken, defaultFolderId);
      folders.push({
        id: defaultFolderId,
        name: folderName,
        provider: "google" as const,
        connectionId,
      });
    }

    const connection: CloudConnection = {
      id: connectionId,
      provider: "google",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiry: Date.now() + tokens.expiresIn * 1000,
      email: tokens.email,
      folders,
    };

    await saveConnection(pairingSession.sessionId, connection);

    return NextResponse.redirect(
      `${appUrl}/setup?paired=${state}&connectionId=${connectionId}&provider=google`
    );
  } catch (err) {
    debug.step = "save_failed";
    debug.error = err instanceof Error ? err.message : String(err);
    return NextResponse.json(debug, { status: 500 });
  }
}
