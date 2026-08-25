import { HttpError } from "./errors";

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

export function requestSubject(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}
