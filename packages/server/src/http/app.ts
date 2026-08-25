import type {
  ApproveDeviceRequestBody,
  UpdateDeviceBody
} from "@cloudframe/shared";
import {
  encodeBootstrapResponse,
  encodeDeviceDto,
  encodeDeviceRequestDto
} from "@cloudframe/shared";
import { clearSessionCookie, createSessionCookie } from "../auth/cookies";
import { verifyPassphrase } from "../auth/passphrase";
import { issueOpaqueToken, type OpaqueToken } from "../auth/tokens";
import type { AppRepository } from "../firestore/repository";
import {
  authenticateAdmin,
  createAdminSession,
  verifyAdminMutation
} from "../services/admin-auth";
import { ensureHousehold } from "../services/bootstrap";
import { authenticateDevice } from "../services/device-auth";
import {
  approveRequest,
  requestFromToken,
  requestHash,
  updateDevice,
  validateName
} from "../services/device-enrollment";
import { HttpError } from "./errors";
import { parseCookies, readJsonObject, requestSubject } from "./request";
import { errorResponse, ok } from "./response";

export interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
}

export interface ApiAppConfig {
  householdId: string;
  adminInitialPassphrase?: string;
  passphrasePepper: string;
  csrfSecret: string;
  allowedOrigin: string;
  rateLimits?: Partial<Record<string, RateLimitPolicy>>;
}

export interface ApiAppDependencies {
  repository: AppRepository;
  config: ApiAppConfig;
  now?: () => Date;
  createId?: (prefix: string) => string;
  issueToken?: () => OpaqueToken;
}

const DEFAULT_RATE_LIMITS: Record<string, RateLimitPolicy> = {
  "admin-login": { limit: 10, windowSeconds: 15 * 60 },
  "device-request-create": { limit: 6, windowSeconds: 60 * 60 },
  "device-request-status": { limit: 120, windowSeconds: 10 * 60 },
  "admin-mutation": { limit: 120, windowSeconds: 60 },
  "tv-mutation": { limit: 120, windowSeconds: 60 }
};

export function createApiApp(input: ApiAppDependencies) {
  const dependencies: ApiAppDependencies = {
    ...input,
    now: input.now ?? (() => new Date()),
    createId: input.createId ?? (prefix => `${prefix}-${crypto.randomUUID()}`),
    issueToken: input.issueToken ?? issueOpaqueToken
  };

  return async (request: Request): Promise<Response> => {
    try {
      return await routeRequest(request, dependencies);
    } catch (error) {
      const safe = error instanceof HttpError
        ? error
        : new HttpError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
      const headers = new Headers(safe.responseHeaders);
      if (safe.retryAfterSeconds !== undefined) {
        headers.set("retry-after", String(safe.retryAfterSeconds));
      }
      return errorResponse(safe.toApiError(), safe.status, headers);
    }
  };
}

async function routeRequest(
  request: Request,
  dependencies: ApiAppDependencies
): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  const now = dependencies.now!();

  if (path === "/api/bootstrap") {
    requireMethod(request, "GET");
    return bootstrap(request, dependencies, now);
  }
  if (path === "/api/admin/login") {
    requireMethod(request, "POST");
    return adminLogin(request, dependencies, now);
  }
  if (path === "/api/admin/logout") {
    requireMethod(request, "POST");
    return adminLogout(request, dependencies, now);
  }
  if (path === "/api/device-requests") {
    requireMethod(request, "POST");
    return createDeviceRequest(request, dependencies, now);
  }
  if (path === "/api/device-requests/status") {
    requireMethod(request, "GET");
    return deviceRequestStatus(request, dependencies, now);
  }
  if (path === "/api/admin/requests") {
    requireMethod(request, "GET");
    return adminRequests(request, dependencies, now);
  }
  const requestAction = /^\/api\/admin\/requests\/([^/]+)\/(approve|deny)$/.exec(path);
  if (requestAction) {
    requireMethod(request, "POST");
    return resolveDeviceRequest(
      request,
      dependencies,
      now,
      decodeURIComponent(requestAction[1]!),
      requestAction[2] as "approve" | "deny"
    );
  }
  if (path === "/api/admin/devices") {
    requireMethod(request, "GET");
    return adminDevices(request, dependencies, now);
  }
  const deviceMatch = /^\/api\/admin\/devices\/([^/]+)$/.exec(path);
  if (deviceMatch) {
    requireOneMethod(request, ["GET", "PATCH", "DELETE"]);
    return adminDevice(
      request,
      dependencies,
      now,
      decodeURIComponent(deviceMatch[1]!)
    );
  }
  if (path === "/api/tv/heartbeat") {
    requireMethod(request, "POST");
    return heartbeat(request, dependencies, now);
  }
  throw new HttpError(404, "NOT_FOUND", "The requested endpoint does not exist.");
}

async function bootstrap(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Response> {
  const household = await ensureHousehold(dependencies, now);
  const rawDevice = parseCookies(request).device_session;
  if (rawDevice) {
    try {
      const authenticated = await authenticateDevice(request, dependencies, now);
      return ok(
        encodeBootstrapResponse({
          enrollment: {
            state: "ready",
            device: authenticated.device,
            household
          }
        }),
        { headers: authenticated.responseHeaders }
      );
    } catch {
      // Continue to request-cookie and unenrolled states. Bootstrap is public.
    }
  }
  const rawRequest = parseCookies(request).device_request;
  if (rawRequest) {
    return enrollmentStatus(rawRequest, dependencies, now);
  }
  return ok(
    encodeBootstrapResponse({
      enrollment: {
        state: household.allowNewDeviceRequests
          ? "unenrolled"
          : "requests-disabled"
      }
    })
  );
}

async function adminLogin(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Response> {
  await enforceRateLimit(request, dependencies, "admin-login", requestSubject(request), now);
  const body = await readJsonObject(request);
  const passphrase = body.passphrase;
  if (typeof passphrase !== "string") {
    throw new HttpError(400, "INVALID_PASSPHRASE", "A passphrase is required.");
  }
  const household = await ensureHousehold(dependencies, now);
  const valid = await verifyPassphrase(
    household.adminPassphraseHash,
    passphrase,
    dependencies.config.passphrasePepper
  );
  if (!valid) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "The passphrase is incorrect.");
  }
  const created = await createAdminSession(dependencies, now);
  const headers = new Headers({ "x-csrf-token": created.csrfToken });
  headers.append(
    "set-cookie",
    createSessionCookie("admin", created.raw, created.session.expiresAt)
  );
  return ok({ authenticated: true }, { headers });
}

async function adminLogout(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Response> {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  verifyAdminMutation(request, authenticated, dependencies.config.allowedOrigin);
  await enforceRateLimit(
    request,
    dependencies,
    "admin-mutation",
    authenticated.session.id,
    now
  );
  await dependencies.repository.revokeAdminSession(
    authenticated.session.id,
    authenticated.session.tokenHash,
    now
  );
  const headers = new Headers();
  headers.append("set-cookie", clearSessionCookie("admin"));
  return ok({ authenticated: false }, { headers });
}

async function createDeviceRequest(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Response> {
  await enforceRateLimit(
    request,
    dependencies,
    "device-request-create",
    requestSubject(request),
    now
  );
  const body = await readJsonObject(request);
  const name = validateName(body.name ?? body.requestedName);
  const household = await ensureHousehold(dependencies, now);
  if (!household.allowNewDeviceRequests) {
    throw new HttpError(
      403,
      "DEVICE_REQUESTS_DISABLED",
      "New device requests are disabled."
    );
  }
  const token = dependencies.issueToken!();
  const deviceRequest = requestFromToken(
    token.hash,
    dependencies.createId!("device-request"),
    household.id,
    name,
    now
  );
  await dependencies.repository.createDeviceRequest(deviceRequest);
  const headers = new Headers();
  headers.append(
    "set-cookie",
    createSessionCookie("request", token.raw, deviceRequest.expiresAt)
  );
  return ok({ request: encodeDeviceRequestDto(deviceRequest) }, { status: 201, headers });
}

async function deviceRequestStatus(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Response> {
  const raw = parseCookies(request).device_request;
  await enforceRateLimit(
    request,
    dependencies,
    "device-request-status",
    raw ? requestHash(raw) : requestSubject(request),
    now
  );
  if (!raw) {
    throw new HttpError(401, "DEVICE_REQUEST_REQUIRED", "A device request is required.");
  }
  return enrollmentStatus(raw, dependencies, now);
}

async function enrollmentStatus(
  raw: string,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Response> {
  let deviceRequest = await dependencies.repository.getDeviceRequestBySecretHash(
    requestHash(raw)
  );
  if (!deviceRequest || deviceRequest.householdId !== dependencies.config.householdId) {
    throw new HttpError(
      401,
      "DEVICE_REQUEST_REQUIRED",
      "A valid device request is required.",
      undefined,
      { "set-cookie": clearSessionCookie("request") }
    );
  }
  if (deviceRequest.status === "pending" && deviceRequest.expiresAt <= now) {
    deviceRequest = await dependencies.repository.expireDeviceRequest({
      requestId: deviceRequest.id,
      householdId: dependencies.config.householdId,
      now
    });
  }
  if (deviceRequest.status === "approved" && deviceRequest.approvedDeviceId) {
    const device = await dependencies.repository.getDevice(deviceRequest.approvedDeviceId);
    const household = await ensureHousehold(dependencies, now);
    if (!device || !device.enabled || device.revokedAt) {
      return terminalEnrollment("revoked");
    }
    const session = await dependencies.repository.getDeviceSessionByHash(requestHash(raw));
    if (!session || session.deviceId !== device.id || session.revokedAt || session.expiresAt <= now) {
      return terminalEnrollment("revoked");
    }
    const headers = new Headers();
    headers.append("set-cookie", createSessionCookie("device", raw, session.expiresAt));
    headers.append("set-cookie", clearSessionCookie("request"));
    return ok(
      encodeBootstrapResponse({
        enrollment: { state: "ready", device, household }
      }),
      { headers }
    );
  }
  if (deviceRequest.status === "denied" || deviceRequest.status === "expired") {
    return terminalEnrollment(deviceRequest.status);
  }
  return ok(
    encodeBootstrapResponse({
      enrollment: { state: "pending", request: deviceRequest }
    })
  );
}

function terminalEnrollment(state: "denied" | "expired" | "revoked") {
  const headers = new Headers();
  headers.append("set-cookie", clearSessionCookie("request"));
  return ok({ enrollment: { state } }, { headers });
}

async function adminRequests(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Response> {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  const requests = await dependencies.repository.listDeviceRequests(
    dependencies.config.householdId
  );
  const headers = withCsrf(authenticated.responseHeaders, authenticated.csrfToken);
  return ok(
    {
      requests: requests
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(encodeDeviceRequestDto)
    },
    { headers }
  );
}

async function resolveDeviceRequest(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date,
  requestId: string,
  action: "approve" | "deny"
): Promise<Response> {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  verifyAdminMutation(request, authenticated, dependencies.config.allowedOrigin);
  await enforceRateLimit(request, dependencies, "admin-mutation", authenticated.session.id, now);
  const body = await readJsonObject(request);
  if (action === "approve") {
    const device = await approveRequest(
      dependencies,
      requestId,
      body as unknown as ApproveDeviceRequestBody,
      now
    );
    return ok(
      { device: encodeDeviceDto(device) },
      { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) }
    );
  }
  try {
    const denied = await dependencies.repository.denyDeviceRequest({
      requestId,
      householdId: dependencies.config.householdId,
      now
    });
    return ok(
      { request: encodeDeviceRequestDto(denied) },
      { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) }
    );
  } catch {
    throw new HttpError(409, "DEVICE_REQUEST_RESOLVED", "Device request is already resolved.");
  }
}

async function adminDevices(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Response> {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  const devices = await dependencies.repository.listDevices(dependencies.config.householdId);
  return ok(
    { devices: devices.map(encodeDeviceDto) },
    { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) }
  );
}

async function adminDevice(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date,
  deviceId: string
): Promise<Response> {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  if (request.method === "GET") {
    const device = await dependencies.repository.getDevice(deviceId);
    if (!device || device.householdId !== dependencies.config.householdId) {
      throw new HttpError(404, "DEVICE_NOT_FOUND", "Device not found.");
    }
    return ok(
      { device: encodeDeviceDto(device) },
      { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) }
    );
  }
  verifyAdminMutation(request, authenticated, dependencies.config.allowedOrigin);
  await enforceRateLimit(request, dependencies, "admin-mutation", authenticated.session.id, now);
  if (request.method === "DELETE") {
    try {
      await dependencies.repository.revokeDevice(deviceId, now);
    } catch {
      throw new HttpError(404, "DEVICE_NOT_FOUND", "Device not found.");
    }
    return ok(
      { revoked: true },
      { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) }
    );
  }
  const body = await readJsonObject(request);
  const device = await updateDevice(
    dependencies,
    deviceId,
    body as unknown as UpdateDeviceBody
  );
  return ok(
    { device: encodeDeviceDto(device) },
    { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) }
  );
}

async function heartbeat(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Response> {
  const authenticated = await authenticateDevice(request, dependencies, now);
  await enforceRateLimit(request, dependencies, "tv-mutation", authenticated.session.id, now);
  if (request.headers.get("content-length") !== "0") await readJsonObject(request);
  return ok(
    { device: encodeDeviceDto(authenticated.device), seenAt: now.toISOString() },
    { headers: authenticated.responseHeaders }
  );
}

async function enforceRateLimit(
  request: Request,
  dependencies: ApiAppDependencies,
  bucket: string,
  subject: string,
  now: Date
): Promise<void> {
  const policy = dependencies.config.rateLimits?.[bucket] ?? DEFAULT_RATE_LIMITS[bucket];
  if (!policy) return;
  const result = await dependencies.repository.consumeRateLimit({
    bucket,
    subject: `${dependencies.config.householdId}:${subject}`,
    now,
    ...policy
  });
  if (!result.allowed) {
    throw new HttpError(
      429,
      "RATE_LIMITED",
      "Too many requests. Try again later.",
      result.retryAfterSeconds
    );
  }
  void request;
}

function withCsrf(headers: Headers, token: string): Headers {
  const combined = new Headers(headers);
  combined.set("x-csrf-token", token);
  return combined;
}

function requireMethod(request: Request, method: string): void {
  requireOneMethod(request, [method]);
}

function requireOneMethod(request: Request, methods: string[]): void {
  if (!methods.includes(request.method)) {
    throw new HttpError(
      405,
      "METHOD_NOT_ALLOWED",
      "The request method is not allowed.",
      undefined,
      { allow: methods.join(", ") }
    );
  }
}
