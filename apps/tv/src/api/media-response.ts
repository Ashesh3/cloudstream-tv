import type { DirectMediaUrlResponse } from "@cloudframe/shared";

const GOOGLE_ORIGIN = "https://www.googleapis.com";

export function decodeDirectMediaUrlResponse(
  value: unknown,
  expected?: { itemId: string; kind: "image" | "video" },
): DirectMediaUrlResponse | null {
  try {
    if (!plainDataRecord(value)) return null;
    const itemId = validItemId(value.itemId);
    const kind = value.kind === "image" || value.kind === "video" ? value.kind : null;
    const expiresAt = futureTimestamp(value.expiresAt);
    const revision = nullableRevision(value.revision);
    if (
      !itemId ||
      !kind ||
      !expiresAt ||
      !revision.valid ||
      (expected && (expected.itemId !== itemId || expected.kind !== kind))
    ) return null;

    if (value.transport === "direct") {
      if (!exactRecord(value, ["itemId", "kind", "transport", "url", "expiresAt", "revision"])) return null;
      const url = validHttpsUrl(value.url);
      return url
        ? { itemId, kind, transport: "direct", url, expiresAt, revision: revision.value }
        : null;
    }

    if (value.transport === "google-bearer") {
      if (!exactRecord(value, ["itemId", "kind", "transport", "url", "authorization", "expiresAt", "revision"])) return null;
      const url = validGoogleMediaUrl(value.url);
      const authorization = value.authorization;
      if (
        !url ||
        !exactRecord(authorization, ["scheme", "token"]) ||
        authorization.scheme !== "Bearer" ||
        !validBearerToken(authorization.token)
      ) return null;
      return {
        itemId,
        kind,
        transport: "google-bearer",
        url,
        authorization: { scheme: "Bearer", token: authorization.token },
        expiresAt,
        revision: revision.value,
      };
    }

    if (value.transport === "hls") {
      if (
        kind !== "video" ||
        !exactRecord(value, ["itemId", "kind", "transport", "playlistUrl", "playbackSessionId", "durationSeconds", "profile", "expiresAt", "revision"])
      ) return null;
      const playlistUrl = typeof value.playlistUrl === "string" && /^\/api\/tv\/transcodes\/[A-Za-z0-9_-]{16,128}\/master\.m3u8$/.test(value.playlistUrl)
        ? value.playlistUrl
        : null;
      const playbackSessionId = typeof value.playbackSessionId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.playbackSessionId)
        ? value.playbackSessionId
        : null;
      const durationSeconds = typeof value.durationSeconds === "number" && Number.isFinite(value.durationSeconds) && value.durationSeconds > 0
        ? value.durationSeconds
        : null;
      if (!playlistUrl || !playbackSessionId || durationSeconds === null || value.profile !== "h264-aac-1080p-v1") return null;
      return {
        itemId,
        kind: "video",
        transport: "hls",
        playlistUrl,
        playbackSessionId,
        durationSeconds,
        profile: value.profile,
        expiresAt,
        revision: revision.value,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function validGoogleMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) return null;
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    return url.origin === GOOGLE_ORIGIN &&
      /^\/drive\/v3\/files\/[^/]{1,1024}$/u.test(url.pathname) &&
      keys.length === 2 && new Set(keys).size === 2 &&
      url.searchParams.getAll("alt").length === 1 &&
      url.searchParams.get("alt") === "media" &&
      url.searchParams.getAll("supportsAllDrives").length === 1 &&
      url.searchParams.get("supportsAllDrives") === "true" &&
      url.username === "" && url.password === "" && url.hash === ""
      ? value
      : null;
  } catch {
    return null;
  }
}

function validHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" && url.password === "" && url.hash === "" &&
      !url.searchParams.has("access_token") &&
      !(url.origin === GOOGLE_ORIGIN && /^\/drive\/v3\/files\/[^/]{1,1024}$/u.test(url.pathname))
      ? value
      : null;
  } catch {
    return null;
  }
}

function validBearerToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,8192}$/u.test(value);
}

function futureTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && epoch > Date.now() && new Date(epoch).toISOString() === value
    ? value
    : null;
}

function nullableRevision(value: unknown): { valid: boolean; value: string | null } {
  if (value === null) return { valid: true, value: null };
  return {
    valid: typeof value === "string" && value.length >= 1 && value.length <= 256,
    value: typeof value === "string" ? value : null,
  };
}

function validItemId(value: unknown): string | null {
  return typeof value === "string" && /^item_[A-Za-z0-9_-]{1,256}$/u.test(value) ? value : null;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plainDataRecord(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.indexOf(key) >= 0);
}

function plainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return false;
  }
  return true;
}
