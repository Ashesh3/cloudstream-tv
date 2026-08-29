const GOOGLE_MEDIA_ORIGIN = "https://www.googleapis.com";

export interface GoogleMediaGrant {
  sessionId: string;
  rawUrl: string;
  fingerprint: string;
  token: string;
  expiresAtEpoch: number;
  kind: "image" | "video";
  mimeType: string;
  size: number | null;
}

export type GoogleMediaPageMessage =
  | { type: "cloudframe-media-grant"; requestId: string; grant: GoogleMediaGrant }
  | { type: "cloudframe-media-revoke"; sessionId: string };

export type GoogleMediaWorkerMessage =
  | { type: "cloudframe-media-grant-ack"; requestId: string; sessionId: string }
  | {
      type: "cloudframe-media-grant-request";
      requestId: string;
      lookup: { kind: "fingerprint"; value: string };
    }
  | {
      type: "cloudframe-media-result";
      sessionId: string;
      attempt: "google-raw";
      outcome: "response" | "network-error" | "bridge-error";
      status?: number;
    };

export interface ParsedSingleRange {
  header: string;
  start: number | null;
  end: number | null;
  suffixLength: number | null;
}

export function isExactGoogleMediaUrl(value: string): boolean {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) return false;
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    return url.href === value && url.origin === GOOGLE_MEDIA_ORIGIN &&
      /^\/drive\/v3\/files\/[^/]{1,1024}$/u.test(url.pathname) &&
      keys.length === 2 && new Set(keys).size === 2 &&
      url.searchParams.getAll("alt").length === 1 &&
      url.searchParams.get("alt") === "media" &&
      url.searchParams.getAll("supportsAllDrives").length === 1 &&
      url.searchParams.get("supportsAllDrives") === "true" &&
      url.username === "" && url.password === "" && url.hash === "";
  } catch {
    return false;
  }
}

export function validSingleRange(value: string | null): ParsedSingleRange | null {
  if (value === null || value.length < 8 || value.length > 128 || value.indexOf(",") >= 0) return null;
  const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/u.exec(value);
  if (!match) return null;
  if (match[3] !== undefined) {
    const suffixLength = safeInteger(match[3]);
    return suffixLength !== null && suffixLength > 0
      ? { header: value, start: null, end: null, suffixLength }
      : null;
  }
  const start = safeInteger(match[1]);
  const end = match[2] === "" ? null : safeInteger(match[2]);
  if (start === null || (end !== null && (end === null || end < start))) return null;
  return { header: value, start, end, suffixLength: null };
}

export async function googleMediaFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function safeInteger(value: string | undefined): number | null {
  if (value === undefined || value.length < 1 || value.length > 16) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
