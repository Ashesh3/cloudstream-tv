import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getPairingSession, saveConnection } from "@/lib/kv";
import { exchangeOneDriveCode } from "@/lib/cloud";
import { ONEDRIVE_OAUTH } from "@/lib/constants";
import type { CloudConnection } from "@/types";

async function resolveOneDriveFolderByPath(
  token: string,
  folderPath: string
): Promise<{ id: string; name: string } | null> {
  // folderPath like "/Documents/TV" → Graph API: /me/drive/root:/Documents/TV
  const cleanPath = folderPath.startsWith("/") ? folderPath : `/${folderPath}`;
  const res = await fetch(
    `${ONEDRIVE_OAUTH.apiBase}/me/drive/root:${encodeURI(cleanPath)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return { id: data.id, name: data.name || folderPath };
}

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const azureError = searchParams.get("error");
  const azureErrorDesc = searchParams.get("error_description");

  const debug: Record<string, unknown> = {
    step: "init",
    hasCode: !!code,
    hasState: !!state,
    state,
    azureError,
    azureErrorDesc,
    allParams: Object.fromEntries(searchParams.entries()),
    appUrl,
  };

  if (!code || !state) {
    debug.step = "missing_params";
    debug.error = azureError
      ? `${azureError}: ${azureErrorDesc || "Unknown"}`
      : "code or state missing";
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
    const redirectUri = `${appUrl}/setup/callback/onedrive`;
    tokens = await exchangeOneDriveCode(code, redirectUri);
    debug.step = "code_exchanged";
  } catch (err) {
    debug.step = "code_exchange_failed";
    debug.error = err instanceof Error ? err.message : String(err);
    return NextResponse.json(debug, { status: 500 });
  }

  try {
    const connectionId = uuidv4();

    // Auto-configure default folder if env var is set
    const defaultFolderPath = process.env.DEFAULT_ONEDRIVE_FOLDER_PATH;
    const folders = [];
    if (defaultFolderPath) {
      const folder = await resolveOneDriveFolderByPath(
        tokens.accessToken,
        defaultFolderPath
      );
      if (folder) {
        folders.push({
          id: folder.id,
          name: folder.name,
          provider: "onedrive" as const,
          connectionId,
        });
      }
    }

    const connection: CloudConnection = {
      id: connectionId,
      provider: "onedrive",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiry: Date.now() + tokens.expiresIn * 1000,
      email: tokens.email,
      folders,
    };

    await saveConnection(pairingSession.sessionId, connection);

    return NextResponse.redirect(
      `${appUrl}/setup?paired=${state}&connectionId=${connectionId}&provider=onedrive`
    );
  } catch (err) {
    debug.step = "save_failed";
    debug.error = err instanceof Error ? err.message : String(err);
    return NextResponse.json(debug, { status: 500 });
  }
}
