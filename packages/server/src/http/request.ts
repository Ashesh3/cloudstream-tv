import { HttpError } from "./errors";
import { isIP } from "node:net";

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected a JSON request body.");
  }
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("body is not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

export function parseCookies(request: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    try {
      result[name] = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      result[name] = "";
    }
  }
  return result;
}

export function readUniqueCookie(
  request: Request,
  requestedName: string
): string | null {
  let value: string | null = null;
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== requestedName) {
      continue;
    }
    if (value !== null) {
      throw new Error("DUPLICATE_COOKIE");
    }
    try {
      value = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      value = "";
    }
  }
  return value;
}

export type RequestSubjectResolver = (request: Request) => string;

export const requestSubject: RequestSubjectResolver = request => {
  const peer = request.headers.get("x-cloudframe-peer-address");
  return peer !== null && peer.length <= 64 && isIP(peer) !== 0
    ? peer
    : "unknown";
};
