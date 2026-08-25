import type {
  ApproveDeviceRequestBody,
  Device,
  Household,
  UpdateDeviceBody
} from "@cloudframe/shared";
import {
  encodeBootstrapResponse,
  encodeDeviceDto,
  encodeDeviceRequestDto,
  encodeMediaNodeDto,
  encodeWatchHistoryDto
} from "@cloudframe/shared";
import { clearSessionCookie, createSessionCookie } from "../auth/cookies";
import { verifyPassphrase } from "../auth/passphrase";
import { issueOpaqueToken, type OpaqueToken } from "../auth/tokens";
import {
  RepositoryError,
  type AppRepository
} from "../firestore/repository";
import {
  authenticateAdmin,
  createAdminSession,
  verifyAdminMutation
} from "../services/admin-auth";
import { ensureHousehold } from "../services/bootstrap";
import { authenticateDevice } from "../services/device-auth";
import { BrowseServiceError } from "../services/browse";
import { IndexingServiceError } from "../services/indexing";
import { MediaUrlServiceError } from "../services/media-urls";
import {
  approveRequest,
  requestFromToken,
  requestHash,
  updateDevice,
  validateName
} from "../services/device-enrollment";
import { HttpError } from "./errors";
import {
  parseCookies,
  readJsonObject,
  requestSubject,
  type RequestSubjectResolver
} from "./request";
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
  requestSubject?: RequestSubjectResolver;
  browse?: {
    home(device: Device, household: Household): Promise<unknown>;
    folder(device: Device, household: Household, nodeId: string, page: { cursor: string | null; limit: number }): Promise<unknown>;
    history(device: Device, household: Household): Promise<unknown>;
    saveHistory(device: Device, household: Household, nodeId: string, value: { positionSeconds: number; durationSeconds: number; completed: boolean }): Promise<unknown>;
  };
  mediaUrls?: {
    media(device: Device, household: Household, nodeId: string): Promise<{ url: string; expiresAt: Date; revision: string | null; responseHeaders: HeadersInit }>;
    thumbnails(device: Device, household: Household, nodeIds: string[], maxDimension: number): Promise<{ items: unknown[]; responseHeaders: HeadersInit }>;
  };
  indexing?: {
    startDueSources(authorization: string | null, limit?: number): Promise<unknown>;
    startSource(sourceId: string, mode: "initial" | "delta" | "reconcile"): Promise<unknown>;
  };
}

const DEFAULT_RATE_LIMITS: Record<string, RateLimitPolicy> = {
  "admin-login": { limit: 10, windowSeconds: 15 * 60 },
  "device-request-create": { limit: 6, windowSeconds: 60 * 60 },
  "device-request-status": { limit: 120, windowSeconds: 10 * 60 },
  "admin-mutation": { limit: 120, windowSeconds: 60 },
  "tv-mutation": { limit: 120, windowSeconds: 60 },
  "url-vending": { limit: 120, windowSeconds: 60 },
  "manual-sync": { limit: 6, windowSeconds: 60 }
};

export function createApiApp(input: ApiAppDependencies) {
  const dependencies: ApiAppDependencies = {
    ...input,
    now: input.now ?? (() => new Date()),
    createId: input.createId ?? (prefix => `${prefix}-${crypto.randomUUID()}`),
    issueToken: input.issueToken ?? issueOpaqueToken,
    requestSubject: input.requestSubject ?? requestSubject
  };

  return async (request: Request): Promise<Response> => {
    try {
      return await routeRequest(request, dependencies);
    } catch (error) {
      const safe = normalizeHttpError(error);
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
  if (path === "/api/tv/home") {
    requireMethod(request, "GET");
    return tvHome(request, dependencies, now);
  }
  const folderMatch = /^\/api\/tv\/folders\/([^/]+)$/.exec(path);
  if (folderMatch) {
    requireMethod(request, "GET");
    return tvFolder(request, dependencies, now, decodeURIComponent(folderMatch[1]!));
  }
  if (path === "/api/tv/thumbnail-urls") {
    requireMethod(request, "POST");
    return thumbnailUrls(request, dependencies, now);
  }
  if (path === "/api/tv/media-url") {
    requireMethod(request, "POST");
    return mediaUrl(request, dependencies, now);
  }
  if (path === "/api/tv/watch-history") {
    requireMethod(request, "GET");
    return watchHistory(request, dependencies, now);
  }
  const historyMatch = /^\/api\/tv\/watch-history\/([^/]+)$/.exec(path);
  if (historyMatch) {
    requireMethod(request, "PUT");
    return saveWatchHistory(request, dependencies, now, decodeURIComponent(historyMatch[1]!));
  }
  if (path === "/api/internal/sync-due-sources") {
    requireMethod(request, "GET");
    if (!dependencies.indexing) throw unavailableService();
    return ok(await dependencies.indexing.startDueSources(request.headers.get("authorization")));
  }
  const sourceSyncMatch = /^\/api\/admin\/sources\/([^/]+)\/sync$/.exec(path);
  if (sourceSyncMatch) {
    requireMethod(request, "POST");
    return manualSourceSync(request, dependencies, now, decodeURIComponent(sourceSyncMatch[1]!));
  }
  throw new HttpError(404, "NOT_FOUND", "The requested endpoint does not exist.");
}

async function manualSourceSync(request: Request, dependencies: ApiAppDependencies, now: Date, sourceId: string) {
  if (!dependencies.indexing) throw unavailableService();
  const authenticated = await authenticateAdmin(request, dependencies, now);
  verifyAdminMutation(request, authenticated, dependencies.config.allowedOrigin);
  await enforceRateLimit(dependencies, "manual-sync", authenticated.session.id, now);
  return ok(await dependencies.indexing.startSource(sourceId, "delta"), {
    headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken)
  });
}

async function tvHome(request: Request, dependencies: ApiAppDependencies, now: Date) {
  if (!dependencies.browse) throw unavailableService();
  const authenticated = await authenticateDevice(request, dependencies, now);
  return ok(await dependencies.browse.home(authenticated.device, authenticated.household), { headers: authenticated.responseHeaders });
}

async function tvFolder(request: Request, dependencies: ApiAppDependencies, now: Date, nodeId: string) {
  if (!dependencies.browse) throw unavailableService();
  const authenticated = await authenticateDevice(request, dependencies, now);
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const result = await dependencies.browse.folder(authenticated.device, authenticated.household, nodeId, { cursor: url.searchParams.get("cursor"), limit });
  const domain = result as { parent: import("@cloudframe/shared").MediaNode; breadcrumbs: import("@cloudframe/shared").MediaNode[]; children: import("@cloudframe/shared").MediaNode[]; nextCursor: string | null };
  return ok({ parent: encodeMediaNodeDto(domain.parent), breadcrumbs: domain.breadcrumbs.map(encodeMediaNodeDto), children: domain.children.map(encodeMediaNodeDto), nextCursor: domain.nextCursor }, { headers: authenticated.responseHeaders });
}

async function thumbnailUrls(request: Request, dependencies: ApiAppDependencies, now: Date) {
  if (!dependencies.mediaUrls) throw unavailableService();
  const authenticated = await authenticateDevice(request, dependencies, now);
  await enforceRateLimit(dependencies, "url-vending", authenticated.session.id, now);
  const body = await readJsonObject(request);
  if (!Array.isArray(body.nodeIds) || !body.nodeIds.every(value => typeof value === "string")) {
    throw new HttpError(400, "INVALID_THUMBNAIL_REQUEST", "Thumbnail request is invalid.");
  }
  const maxDimension = body.maxDimension ?? 720;
  if (typeof maxDimension !== "number" || !Number.isInteger(maxDimension)) {
    throw new HttpError(400, "INVALID_THUMBNAIL_REQUEST", "Thumbnail request is invalid.");
  }
  const result = await dependencies.mediaUrls.thumbnails(authenticated.device, authenticated.household, body.nodeIds as string[], maxDimension);
  return ok({ items: serializeTemporaryItems(result.items) }, { headers: mergeHeaders(authenticated.responseHeaders, result.responseHeaders) });
}

async function mediaUrl(request: Request, dependencies: ApiAppDependencies, now: Date) {
  if (!dependencies.mediaUrls) throw unavailableService();
  const authenticated = await authenticateDevice(request, dependencies, now);
  await enforceRateLimit(dependencies, "url-vending", authenticated.session.id, now);
  const body = await readJsonObject(request);
  if (typeof body.nodeId !== "string") throw new HttpError(400, "INVALID_MEDIA_REQUEST", "Media request is invalid.");
  const result = await dependencies.mediaUrls.media(authenticated.device, authenticated.household, body.nodeId);
  return ok({ url: result.url, expiresAt: result.expiresAt.toISOString(), revision: result.revision }, { headers: mergeHeaders(authenticated.responseHeaders, result.responseHeaders) });
}

async function watchHistory(request: Request, dependencies: ApiAppDependencies, now: Date) {
  if (!dependencies.browse) throw unavailableService();
  const authenticated = await authenticateDevice(request, dependencies, now);
  const history = await dependencies.browse.history(authenticated.device, authenticated.household) as import("@cloudframe/shared").WatchHistory[];
  return ok({ history: history.map(encodeWatchHistoryDto) }, { headers: authenticated.responseHeaders });
}

async function saveWatchHistory(request: Request, dependencies: ApiAppDependencies, now: Date, nodeId: string) {
  if (!dependencies.browse) throw unavailableService();
  const authenticated = await authenticateDevice(request, dependencies, now);
  await enforceRateLimit(dependencies, "tv-mutation", authenticated.session.id, now);
  const body = await readJsonObject(request);
  if (
    typeof body.positionSeconds !== "number" ||
    !Number.isFinite(body.positionSeconds) ||
    typeof body.durationSeconds !== "number" ||
    !Number.isFinite(body.durationSeconds) ||
    typeof body.completed !== "boolean"
  ) {
    throw new HttpError(400, "INVALID_HISTORY", "Watch history is invalid.");
  }
  const history = await dependencies.browse.saveHistory(authenticated.device, authenticated.household, nodeId, {
    positionSeconds: body.positionSeconds,
    durationSeconds: body.durationSeconds,
    completed: body.completed
  }) as import("@cloudframe/shared").WatchHistory;
  return ok({ history: encodeWatchHistoryDto(history) }, { headers: authenticated.responseHeaders });
}

function unavailableService() { return new HttpError(503, "SERVICE_UNAVAILABLE", "The service is unavailable."); }

function mergeHeaders(first: HeadersInit, second: HeadersInit): Headers {
  const result = new Headers(first); new Headers(second).forEach((value, key) => result.set(key, value)); return result;
}

function serializeTemporaryItems(items: unknown[]): unknown[] {
  return items.map(item => {
    if (!item || typeof item !== "object" || !("expiresAt" in item) || !(item.expiresAt instanceof Date)) return item;
    return { ...item, expiresAt: item.expiresAt.toISOString() };
  });
}

async function bootstrap(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Response> {
  const household = await ensureHousehold(dependencies, now);
  const rawDevice = parseCookies(request).device_session;
  const fallbackHeaders = new Headers();
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
    } catch (error) {
      if (
        !(error instanceof HttpError) ||
        error.code !== "DEVICE_UNAUTHORIZED"
      ) {
        throw error;
      }
      appendHeaders(fallbackHeaders, error.responseHeaders);
    }
  }
  const rawRequest = parseCookies(request).device_request;
  if (rawRequest) {
    const response = await enrollmentStatus(rawRequest, dependencies, now);
    return mergeResponseHeaders(response, fallbackHeaders);
  }
  return ok(
    encodeBootstrapResponse({
      enrollment: {
        state: household.allowNewDeviceRequests
          ? "unenrolled"
          : "requests-disabled"
      }
    }),
    { headers: fallbackHeaders }
  );
}

async function adminLogin(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Response> {
  await enforceRateLimit(
    dependencies,
    "admin-login",
    dependencies.requestSubject!(request),
    now
  );
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
    dependencies,
    "device-request-create",
    dependencies.requestSubject!(request),
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
    dependencies,
    "device-request-status",
    raw ? requestHash(raw) : dependencies.requestSubject!(request),
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
  await enforceRateLimit(dependencies, "admin-mutation", authenticated.session.id, now);
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
  } catch (error) {
    if (error instanceof RepositoryError) {
      if (error.code === "DEVICE_REQUEST_NOT_FOUND") {
        throw new HttpError(
          404,
          "DEVICE_REQUEST_NOT_FOUND",
          "Device request not found."
        );
      }
      if (error.code === "DEVICE_REQUEST_NOT_PENDING") {
        throw new HttpError(
          409,
          "DEVICE_REQUEST_RESOLVED",
          "Device request is already resolved."
        );
      }
    }
    throw error;
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
  await enforceRateLimit(dependencies, "admin-mutation", authenticated.session.id, now);
  if (request.method === "DELETE") {
    try {
      await dependencies.repository.revokeDevice(deviceId, now);
    } catch (error) {
      if (
        error instanceof RepositoryError &&
        error.code === "DEVICE_NOT_FOUND"
      ) {
        throw new HttpError(404, "DEVICE_NOT_FOUND", "Device not found.");
      }
      throw error;
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
  await enforceRateLimit(dependencies, "tv-mutation", authenticated.session.id, now);
  if (request.headers.get("content-length") !== "0") await readJsonObject(request);
  return ok(
    { device: encodeDeviceDto(authenticated.device), seenAt: now.toISOString() },
    { headers: authenticated.responseHeaders }
  );
}

async function enforceRateLimit(
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
}

function appendHeaders(target: Headers, source?: HeadersInit): void {
  const headers = new Headers(source);
  headers.forEach((value, name) => {
    if (name !== "set-cookie") target.set(name, value);
  });
  for (const cookie of headers.getSetCookie()) {
    target.append("set-cookie", cookie);
  }
}

function mergeResponseHeaders(response: Response, extra: Headers): Response {
  const headers = new Headers(response.headers);
  appendHeaders(headers, extra);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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

function normalizeHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof BrowseServiceError) {
    const status = error.code === "DEVICE_UNAUTHORIZED"
      ? 401
      : error.code === "INVALID_CURSOR" ||
          error.code === "INVALID_PAGE_SIZE" ||
          error.code === "INVALID_HISTORY"
        ? 400
        : 404;
    return new HttpError(status, error.code, error.message);
  }
  if (error instanceof MediaUrlServiceError) {
    return new HttpError(
      error.code === "THUMBNAIL_BATCH_TOO_LARGE" ? 400 : 404,
      error.code,
      error.message
    );
  }
  if (error instanceof IndexingServiceError) {
    return new HttpError(
      error.code === "CRON_UNAUTHORIZED" ? 401 : error.code === "INDEXING_UNAVAILABLE" ? 503 : 404,
      error.code,
      error.message
    );
  }
  return new HttpError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
}
