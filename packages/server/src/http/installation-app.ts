import type { ClaimInstallationBody } from "@cloudframe/shared";
import type { InstallationService } from "../services/installation.ts";
import { InstallationServiceError } from "../services/installation.ts";
import type { RuntimeRateLimiter } from "../services/runtime-rate-limit.ts";
import { HttpError } from "./errors.ts";
import { errorResponse, ok } from "./response.ts";

const MAX_SETUP_BODY_BYTES = 4 * 1_024;
const CLAIM_POLICY = { limit: 5, windowSeconds: 15 * 60 } as const;

export interface InstallationApiDependencies {
  service: InstallationService;
  rateLimiter: RuntimeRateLimiter;
  allowedOrigin: string;
  now?: () => Date;
  requestSubject?: (request: Request) => string;
}

export function createInstallationApiApp(input: InstallationApiDependencies) {
  const now = input.now ?? (() => new Date());
  const requestSubject = input.requestSubject ?? (() => "unknown");

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/setup/status" && url.pathname !== "/api/setup/claim") {
      return null;
    }

    try {
      assertNoQuery(url);
      if (url.pathname === "/api/setup/status") {
        requireMethod(request, "GET");
        return ok(await input.service.status());
      }

      requireMethod(request, "POST");
      if (request.headers.get("origin") !== input.allowedOrigin) {
        throw new HttpError(403, "ORIGIN_INVALID", "This setup request was blocked.");
      }
      const limit = await input.rateLimiter.consume(
        "setup-claim",
        requestSubject(request),
        now(),
        CLAIM_POLICY,
      );
      if (!limit.allowed) {
        throw new HttpError(
          429,
          "RATE_LIMITED",
          "Too many setup attempts. Wait and try again.",
          limit.retryAfterSeconds,
          { "retry-after": String(limit.retryAfterSeconds) },
        );
      }
      const body = await readClaimBody(request);
      return ok(await input.service.claim(body));
    } catch (error) {
      const mapped = mapInstallationError(error);
      return errorResponse(mapped.toApiError(), mapped.status, mapped.responseHeaders);
    }
  };
}

function requireMethod(request: Request, expected: "GET" | "POST"): void {
  if (request.method !== expected) {
    throw new HttpError(
      405,
      "METHOD_NOT_ALLOWED",
      "The request method is not allowed.",
      undefined,
      { allow: expected },
    );
  }
}

function assertNoQuery(url: URL): void {
  if (url.search !== "") {
    throw new HttpError(400, "INVALID_QUERY", "The setup route does not accept query parameters.");
  }
}

async function readClaimBody(request: Request): Promise<ClaimInstallationBody> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected a JSON request body.");
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_SETUP_BODY_BYTES)
  ) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SETUP_BODY_BYTES) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
  if (!isExactClaimBody(value)) {
    throw new HttpError(400, "INVALID_REQUEST", "The setup request is invalid.");
  }
  return value;
}

function isExactClaimBody(value: unknown): value is ClaimInstallationBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 2 &&
    keys[0] === "passphrase" &&
    keys[1] === "setupCode" &&
    typeof record.setupCode === "string" &&
    typeof record.passphrase === "string";
}

function mapInstallationError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof InstallationServiceError) {
    switch (error.code) {
      case "INSTALLATION_ALREADY_CONFIGURED":
        return new HttpError(409, error.code, "This installation is already configured.");
      case "SETUP_CODE_INVALID":
        return new HttpError(401, error.code, "The setup code was not accepted.");
      case "INVALID_PASSPHRASE":
        return new HttpError(400, error.code, "The passphrase must be 16 to 1024 characters.");
      case "CONTROL_PLANE_UNAVAILABLE":
        return new HttpError(503, error.code, "Local control storage is unavailable.");
    }
  }
  return new HttpError(503, "CONTROL_PLANE_UNAVAILABLE", "Local control storage is unavailable.");
}
