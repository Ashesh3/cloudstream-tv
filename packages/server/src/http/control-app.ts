import type {
  ApproveDeviceRequestBody,
  ControlDeviceDto,
  ControlPlaneDocumentV2,
  ControlRequestDto,
  ControlRootDto,
  ControlSourceDto,
  ProviderKind,
  UpdateAdminSettingsBody,
  UpdateDeviceBody
} from "@cloudframe/shared";
import { ProviderError } from "@cloudframe/providers";

import { clearSessionCookie } from "../auth/cookies";
import {
  ControlMutationError,
  type ControlMutationErrorCode
} from "../control-plane/mutations";
import {
  ControlPlaneStoreError,
  type ControlPlaneStore
} from "../control-plane/store";
import type { ControlPlaneTelemetryObserver } from "../control-plane/telemetry";
import {
  ControlAdminServiceError,
  type ControlAdminService
} from "../services/control-admin";
import {
  ControlAuthError,
  type AuthenticatedControlAdmin,
  type AuthenticatedControlDevice,
  type ControlAuth
} from "../services/control-auth";
import {
  ControlEnrollmentError,
  type ControlEnrollmentService,
  type ControlEnrollmentStatus
} from "../services/control-enrollment";
import {
  ControlOAuthServiceError,
  type ControlOAuthService
} from "../services/control-oauth";
import {
  DirectMediaError,
  type DirectMediaService
} from "../services/direct-media";
import { CredentialBrokerError } from "../services/credential-broker";
import {
  LiveBrowseError,
  type LiveBrowseService
} from "../services/live-browse";
import {
  LiveProviderFolderError,
  type LiveProviderFolderService
} from "../services/live-provider-folders";
import type {
  RuntimeRateLimiter,
  RuntimeRateLimitPolicy
} from "../services/runtime-rate-limit";
import { HttpError } from "./errors";
import { readUniqueCookie, requestSubject } from "./request";
import {
  loadControlRequestContext,
  type ControlRequestContext,
  type ControlRequestContextScope
} from "./request-context";
import { errorResponse, ok } from "./response";

const MAX_JSON_BODY_BYTES = 32 * 1_024;
const DEFAULT_PAGE_SIZE = 50;

export interface ControlApiRequestLoggerEvent {
  level: "info" | "error";
  event: "api_request";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  errorName?: string;
  causeName?: string;
  causeCode?: string;
}

export interface OAuthCallbackFailureLoggerEvent {
  level: "error";
  event: "oauth_callback_failed";
  requestId: string;
  provider: ProviderKind;
  stage: "state_cookie" | "query" | "admin_auth" | "completion";
  errorCode: string;
  errorName?: string;
  causeName?: string;
  causeCode?: string;
}

export type ControlApiLoggerEvent =
  | ControlApiRequestLoggerEvent
  | OAuthCallbackFailureLoggerEvent;

export interface ControlApiLogger {
  info(event: ControlApiLoggerEvent): void;
  error(event: ControlApiLoggerEvent): void;
}

export interface ControlApiConfig {
  householdId: string;
  allowedOrigin: string;
  rateLimits?: Partial<Record<string, RuntimeRateLimitPolicy>>;
}

export interface ControlApiDependencies {
  controlStore: ControlPlaneStore;
  requestContext: ControlRequestContextScope;
  auth: ControlAuth;
  admin: ControlAdminService;
  enrollment: ControlEnrollmentService;
  oauth: ControlOAuthService;
  providerFolders: LiveProviderFolderService;
  browse: LiveBrowseService;
  directMedia: DirectMediaService;
  rateLimiter: RuntimeRateLimiter;
  config: ControlApiConfig;
  now?: () => Date;
  requestSubject?: (request: Request) => string;
  logger?: ControlApiLogger;
  telemetryObserver?: ControlPlaneTelemetryObserver;
}

const DEFAULT_RATE_LIMITS: Record<string, RuntimeRateLimitPolicy> = {
  "admin-login": { limit: 10, windowSeconds: 15 * 60 },
  "admin-mutation": { limit: 120, windowSeconds: 60 },
  "device-request-create": { limit: 6, windowSeconds: 60 * 60 },
  "device-request-status": { limit: 120, windowSeconds: 10 * 60 },
  "url-vending": { limit: 120, windowSeconds: 60 },
  "media-stream": { limit: 3_600, windowSeconds: 60 }
};

const consoleControlApiLogger: ControlApiLogger = {
  info: (event) => console.info(JSON.stringify(event)),
  error: (event) => console.error(JSON.stringify(event))
};

interface ActiveDependencies extends ControlApiDependencies {
  now: () => Date;
  requestSubject: (request: Request) => string;
  logger: ControlApiLogger;
  telemetryObserver?: ControlPlaneTelemetryObserver;
}

interface ProtectedAdminResult {
  admin: AuthenticatedControlAdmin;
  context: ControlRequestContext;
}

interface ProtectedDeviceResult {
  device: AuthenticatedControlDevice;
  context: ControlRequestContext;
}

export function createControlApiApp(input: ControlApiDependencies) {
  const dependencies: ActiveDependencies = {
    ...input,
    now: input.now ?? (() => new Date()),
    requestSubject: input.requestSubject ?? requestSubject,
    logger: input.logger ?? consoleControlApiLogger
  };

  return async (request: Request): Promise<Response> => {
    const requestId =
      safeRequestId(request.headers.get("x-request-id")) ?? crypto.randomUUID();
    const startedAt = Date.now();
    const routeTemplate = classifyRoute(request);
    const requestTelemetry: ControlPlaneTelemetryObserver | undefined =
      dependencies.telemetryObserver === undefined
        ? undefined
        : {
            emit(event) {
              dependencies.telemetryObserver?.emit({ ...event, requestId });
            }
          };
    let response: Response;
    try {
      const runRequest = () => dependencies.requestContext.runRequest(
        () => routeRequest(request, dependencies, requestId)
      );
      response = dependencies.controlStore.withTelemetry
        ? await dependencies.controlStore.withTelemetry(requestTelemetry, requestId, runRequest)
        : await runRequest();
      safeLog(dependencies.logger, "info", requestEvent(
        request,
        routeTemplate,
        requestId,
        response.status,
        Date.now() - startedAt
      ));
    } catch (error) {
      const safe = normalizeHttpError(error);
      const headers = new Headers(safe.responseHeaders);
      if (safe.retryAfterSeconds !== undefined) {
        headers.set("retry-after", String(safe.retryAfterSeconds));
      }
      response = errorResponse(safe.toApiError(), safe.status, headers);
      safeLog(dependencies.logger, "error", {
        ...requestEvent(
          request,
          routeTemplate,
          requestId,
          safe.status,
          Date.now() - startedAt,
          safe.code
        ),
        ...safeErrorIdentity(error),
        level: "error"
      });
    }
    secureResponse(response, requestId);
    return response;
  };
}

async function routeRequest(
  request: Request,
  dependencies: ActiveDependencies,
  requestId: string
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const now = dependencies.now();

  if (path === "/api/bootstrap") {
    requireMethod(request, "GET");
    assertQueryKeys(url, []);
    return bootstrap(request, dependencies, now);
  }
  if (path === "/api/admin/login") {
    requireMethod(request, "POST");
    assertQueryKeys(url, []);
    return adminLogin(request, dependencies, now);
  }
  if (path === "/api/admin/logout") {
    requireMethod(request, "POST");
    assertQueryKeys(url, []);
    return adminLogout(request, dependencies, now);
  }
  if (path === "/api/admin/snapshot") {
    requireMethod(request, "GET");
    assertQueryKeys(url, []);
    return adminSnapshot(request, dependencies, now);
  }
  if (path === "/api/admin/settings") {
    requireMethod(request, "PATCH");
    assertQueryKeys(url, []);
    return adminSettings(request, dependencies, now);
  }
  if (path === "/api/admin/passphrase") {
    requireMethod(request, "POST");
    assertQueryKeys(url, []);
    return adminPassphrase(request, dependencies, now);
  }
  if (path === "/api/admin/requests") {
    requireMethod(request, "GET");
    assertQueryKeys(url, []);
    return adminRequests(request, dependencies, now);
  }
  const requestAction = /^\/api\/admin\/requests\/([^/]+)\/(approve|deny)$/.exec(
    path
  );
  if (requestAction) {
    requireMethod(request, "POST");
    assertQueryKeys(url, []);
    const requestId = decodePathId(requestAction[1]!);
    return resolveDeviceRequest(
      request,
      dependencies,
      now,
      requestId,
      requestAction[2] as "approve" | "deny"
    );
  }
  if (path === "/api/admin/devices") {
    requireMethod(request, "GET");
    assertQueryKeys(url, []);
    return adminDevices(request, dependencies, now);
  }
  const deviceMatch = /^\/api\/admin\/devices\/([^/]+)$/.exec(path);
  if (deviceMatch) {
    requireOneMethod(request, ["GET", "PATCH", "DELETE"]);
    assertQueryKeys(url, []);
    const deviceId = decodePathId(deviceMatch[1]!);
    return adminDevice(
      request,
      dependencies,
      now,
      deviceId
    );
  }
  if (path === "/api/admin/sources") {
    requireMethod(request, "GET");
    assertQueryKeys(url, []);
    return adminSources(request, dependencies, now);
  }
  const authorizeMatch =
    /^\/api\/admin\/sources\/(google|onedrive)\/authorize$/.exec(path);
  if (authorizeMatch) {
    requireMethod(request, "POST");
    assertQueryKeys(url, []);
    return oauthAuthorize(
      request,
      dependencies,
      now,
      authorizeMatch[1] as ProviderKind
    );
  }
  const callbackMatch =
    /^\/api\/admin\/sources\/(google|onedrive)\/callback$/.exec(path);
  if (callbackMatch) {
    requireMethod(request, "GET");
    return oauthCallback(
      request,
      dependencies,
      now,
      callbackMatch[1] as ProviderKind,
      requestId
    );
  }
  const sourceImpactMatch =
    /^\/api\/admin\/sources\/([^/]+)\/impact$/.exec(path);
  if (sourceImpactMatch) {
    requireMethod(request, "GET");
    assertQueryKeys(url, []);
    const sourceId = decodePathId(sourceImpactMatch[1]!);
    return sourceImpact(
      request,
      dependencies,
      now,
      sourceId
    );
  }
  const providerFoldersMatch =
    /^\/api\/admin\/sources\/([^/]+)\/provider-folders$/.exec(path);
  if (providerFoldersMatch) {
    requireMethod(request, "GET");
    const sourceId = decodePathId(providerFoldersMatch[1]!);
    return providerFolders(
      request,
      dependencies,
      now,
      sourceId
    );
  }
  const sourceRootsMatch = /^\/api\/admin\/sources\/([^/]+)\/roots$/.exec(
    path
  );
  if (sourceRootsMatch) {
    requireMethod(request, "POST");
    assertQueryKeys(url, []);
    const sourceId = decodePathId(sourceRootsMatch[1]!);
    return createRoot(
      request,
      dependencies,
      now,
      sourceId
    );
  }
  const sourceMatch = /^\/api\/admin\/sources\/([^/]+)$/.exec(path);
  if (sourceMatch) {
    requireMethod(request, "DELETE");
    assertQueryKeys(url, []);
    const sourceId = decodePathId(sourceMatch[1]!);
    return removeSource(
      request,
      dependencies,
      now,
      sourceId
    );
  }
  const rootImpactMatch = /^\/api\/admin\/roots\/([^/]+)\/impact$/.exec(path);
  if (rootImpactMatch) {
    requireMethod(request, "GET");
    assertQueryKeys(url, []);
    const rootId = decodePathId(rootImpactMatch[1]!);
    return rootImpact(
      request,
      dependencies,
      now,
      rootId
    );
  }
  const rootMatch = /^\/api\/admin\/roots\/([^/]+)$/.exec(path);
  if (rootMatch) {
    requireMethod(request, "DELETE");
    assertQueryKeys(url, []);
    const rootId = decodePathId(rootMatch[1]!);
    return removeRoot(
      request,
      dependencies,
      now,
      rootId
    );
  }
  if (path === "/api/device-requests") {
    requireMethod(request, "POST");
    assertQueryKeys(url, []);
    return createDeviceRequest(request, dependencies, now);
  }
  if (path === "/api/device-requests/status") {
    requireMethod(request, "GET");
    assertQueryKeys(url, []);
    return deviceRequestStatus(request, dependencies, now);
  }
  if (path === "/api/tv/home") {
    requireMethod(request, "GET");
    assertQueryKeys(url, []);
    return tvHome(request, dependencies, now);
  }
  const folderMatch = /^\/api\/tv\/folders\/([^/]+)$/.exec(path);
  if (folderMatch) {
    requireMethod(request, "GET");
    const handle = decodeHandle(folderMatch[1]!);
    return tvFolder(
      request,
      dependencies,
      now,
      handle
    );
  }
  if (path === "/api/tv/thumbnail-urls") {
    requireMethod(request, "POST");
    assertQueryKeys(url, []);
    return thumbnailUrls(request, dependencies, now);
  }
  if (path === "/api/tv/media-url") {
    requireMethod(request, "POST");
    assertQueryKeys(url, []);
    return mediaUrl(request, dependencies, now);
  }
  const googleMediaMatch = /^\/api\/tv\/google-media\/([^/]+)$/.exec(path);
  if (googleMediaMatch) {
    requireOneMethod(request, ["GET", "HEAD"]);
    assertQueryKeys(url, []);
    return googleMedia(
      request,
      dependencies,
      now,
      decodeHandle(googleMediaMatch[1]!),
    );
  }

  throw new HttpError(
    404,
    "NOT_FOUND",
    "The requested endpoint does not exist."
  );
}

async function bootstrap(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  let deviceCookie: string | null;
  let requestCookie: string | null;
  try {
    deviceCookie = readUniqueCookie(request, "device_session");
  } catch {
    throw unauthorizedDevice();
  }
  try {
    requestCookie = readUniqueCookie(request, "device_request");
  } catch {
    throw invalidDeviceRequest();
  }
  const context = await currentOrLoadControlRequestContext(dependencies);
  const headers = new Headers();

  if (deviceCookie) {
    try {
      const authenticated = await dependencies.auth.device(request, context, now);
      return ok(
        {
          enrollment: {
            state: "ready",
            device: controlDeviceDto(authenticated),
            household: householdDto(context.document)
          }
        },
        { headers }
      );
    } catch (error) {
      if (
        !(error instanceof ControlAuthError) ||
        error.code !== "DEVICE_UNAUTHORIZED"
      ) {
        throw error;
      }
      if (error.clearCookie) headers.append("set-cookie", error.clearCookie);
      if (error.reason === "revoked") {
        return ok({ enrollment: { state: "revoked" } }, { headers });
      }
    }
  }
  if (requestCookie) {
    return enrollmentResponse(
      await dependencies.enrollment.status(requestCookie, now, context),
      headers
    );
  }
  return ok(
    {
      enrollment: {
        state: context.document.household.allowNewDeviceRequests
          ? "unenrolled"
          : "requests-disabled"
      }
    },
    { headers }
  );
}

async function adminLogin(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  await enforceRateLimit(
    dependencies,
    "admin-login",
    dependencies.requestSubject(request),
    now
  );
  const body = await readBoundedJsonObject(request);
  assertOnlyKeys(body, ["passphrase"], "INVALID_PASSPHRASE");
  if (typeof body.passphrase !== "string" || body.passphrase.length > 1024) {
    throw new HttpError(
      400,
      "INVALID_PASSPHRASE",
      "A valid passphrase is required."
    );
  }
  const authenticated = await dependencies.auth.login(body.passphrase, now);
  const headers = new Headers({ "x-csrf-token": authenticated.csrfToken });
  headers.append("set-cookie", authenticated.setCookie);
  return ok({ authenticated: true }, { headers });
}

async function adminLogout(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  const body = await readBoundedJsonObject(request);
  assertOnlyKeys(body, [], "INVALID_REQUEST");
  const protectedResult = await protectedAdmin(request, dependencies, now);
  const { admin } = protectedResult;
  verifyAdminMutation(request, admin, dependencies.config.allowedOrigin);
  await enforceRateLimit(
    dependencies,
    "admin-mutation",
    admin.sessionId,
    now
  );
  const headers = new Headers({ "x-csrf-token": admin.csrfToken });
  headers.append("set-cookie", dependencies.auth.logout().clearCookie);
  return ok({ authenticated: false }, { headers });
}

async function adminSnapshot(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  const protectedResult = await protectedAdmin(request, dependencies, now);
  const { admin, context } = protectedResult;
  const snapshot = await snapshotFromContext(context, dependencies.admin, now);
  return ok(snapshot, { headers: csrfHeaders(admin) });
}

async function adminSettings(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  const input = settingsBody(await readBoundedJsonObject(request));
  const { admin } = await protectedAdmin(request, dependencies, now);
  await authorizeAdminMutation(request, dependencies, admin, now);
  return ok(
    await dependencies.admin.updateSettings(
      dependencies.config.householdId,
      input
    ),
    { headers: csrfHeaders(admin) }
  );
}

async function adminPassphrase(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  const body = await readBoundedJsonObject(request);
  assertOnlyKeys(
    body,
    ["currentPassphrase", "newPassphrase"],
    "INVALID_PASSPHRASE"
  );
  if (
    typeof body.currentPassphrase !== "string" ||
    typeof body.newPassphrase !== "string" ||
    body.currentPassphrase.length < 16 ||
    body.currentPassphrase.length > 1024 ||
    body.newPassphrase.length < 16 ||
    body.newPassphrase.length > 1024
  ) {
    throw new HttpError(
      400,
      "INVALID_PASSPHRASE",
      "The passphrase is invalid."
    );
  }
  const { admin } = await protectedAdmin(request, dependencies, now);
  await authorizeAdminMutation(request, dependencies, admin, now);
  const result = await dependencies.admin.rotatePassphrase(
    dependencies.config.householdId,
    body.currentPassphrase,
    body.newPassphrase
  );
  const headers = new Headers();
  headers.append("set-cookie", clearSessionCookie("admin"));
  return ok({ ...result, authenticated: false }, { headers });
}

async function adminRequests(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  const { admin, context } = await protectedAdmin(request, dependencies, now);
  const requests = Object.values(context.document.pendingDeviceRequests)
    .filter(
      (value) =>
        value.status === "pending" && Date.parse(value.expiresAt) > now.getTime()
    )
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        left.id.localeCompare(right.id)
    )
    .map(controlRequestDto);
  return ok({ requests }, { headers: csrfHeaders(admin) });
}

async function resolveDeviceRequest(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  requestId: string,
  action: "approve" | "deny"
): Promise<Response> {
  const body = await readBoundedJsonObject(request);
  const input = action === "approve" ? approvalBody(body) : null;
  if (action === "deny") assertOnlyKeys(body, [], "INVALID_REQUEST");
  const { admin } = await protectedAdmin(request, dependencies, now);
  await authorizeAdminMutation(request, dependencies, admin, now);
  const result =
    action === "approve"
      ? await dependencies.enrollment.approve(requestId, input!, now)
      : await dependencies.enrollment.deny(requestId, now);
  return ok(result, { headers: csrfHeaders(admin) });
}

async function adminDevices(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  const { admin, context } = await protectedAdmin(request, dependencies, now);
  const devices = Object.values(context.document.devices)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(controlDeviceDtoFromDocument);
  return ok({ devices }, { headers: csrfHeaders(admin) });
}

async function adminDevice(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  deviceId: string
): Promise<Response> {
  const body =
    request.method === "GET" ? null : await readBoundedJsonObject(request);
  const patch =
    request.method === "PATCH" ? updateDeviceBody(body!) : undefined;
  if (request.method === "DELETE") {
    assertOnlyKeys(body!, [], "INVALID_REQUEST");
  }
  const { admin, context } = await protectedAdmin(request, dependencies, now);
  if (request.method === "GET") {
    const device = context.document.devices[deviceId];
    if (!device) throw notFound("DEVICE_NOT_FOUND", "Device not found.");
    return ok(
      { device: controlDeviceDtoFromDocument(device) },
      { headers: csrfHeaders(admin) }
    );
  }
  await authorizeAdminMutation(request, dependencies, admin, now);
  const result =
    request.method === "PATCH"
      ? await dependencies.admin.updateDevice(
          dependencies.config.householdId,
          deviceId,
          patch!
        )
      : await dependencies.admin.revokeDevice(
          dependencies.config.householdId,
          deviceId
        );
  return ok(
    "device" in result
      ? { device: legacyDeviceToControl(result.device) }
      : result,
    { headers: csrfHeaders(admin) }
  );
}

async function adminSources(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  const { admin, context } = await protectedAdmin(request, dependencies, now);
  const sources = Object.values(context.document.sources)
    .sort((left, right) => left.accountLabel.localeCompare(right.accountLabel))
    .map(controlSourceDto);
  return ok({ sources }, { headers: csrfHeaders(admin) });
}

async function oauthAuthorize(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  provider: ProviderKind
): Promise<Response> {
  const body = await readBoundedJsonObject(request);
  assertOnlyKeys(body, ["reconnectSourceId"], "INVALID_SOURCE");
  if (
    body.reconnectSourceId !== undefined &&
    (typeof body.reconnectSourceId !== "string" ||
      body.reconnectSourceId.length < 1 ||
      body.reconnectSourceId.length > 256)
  ) {
    throw new HttpError(400, "INVALID_SOURCE", "Source request is invalid.");
  }
  const { admin, context } = await protectedAdmin(request, dependencies, now);
  await authorizeAdminMutation(request, dependencies, admin, now);
  const result = await dependencies.oauth.beginAuthorization({
    admin,
    context,
    provider,
    ...(body.reconnectSourceId === undefined
      ? {}
      : { reconnectSourceId: body.reconnectSourceId })
  });
  const headers = csrfHeaders(admin);
  headers.append("set-cookie", result.stateCookie);
  return ok({ authorizationUrl: result.authorizationUrl }, { headers });
}

async function oauthCallback(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  provider: ProviderKind,
  requestId: string
): Promise<Response> {
  const clearOAuthCookie = clearOAuthStateCookie();
  let stage: OAuthCallbackFailureLoggerEvent["stage"] = "state_cookie";
  try {
    let stateCookie: string | null;
    try {
      stateCookie = readUniqueCookie(request, "oauth_state");
    } catch (error) {
      logOAuthCallbackFailure(dependencies.logger, requestId, provider, stage, error);
      return oauthRedirect("invalid", clearOAuthCookie);
    }
    if (!stateCookie) {
      logOAuthCallbackFailure(dependencies.logger, requestId, provider, stage, null);
      return oauthRedirect("invalid", clearOAuthCookie);
    }

    stage = "query";
    const callback = parseOAuthCallbackQuery(new URL(request.url), provider);
    stage = "admin_auth";
    const protectedResult = await protectedAdmin(request, dependencies, now);
    stage = "completion";
    await dependencies.oauth.completeAuthorization({
      admin: protectedResult.admin,
      context: protectedResult.context,
      provider,
      state: callback.state,
      stateCookie,
      ...(callback.code === null ? {} : { code: callback.code }),
      ...(callback.providerError === null
        ? {}
        : { providerError: callback.providerError })
    });
    return oauthRedirect("connected", clearOAuthCookie);
  } catch (error) {
    logOAuthCallbackFailure(dependencies.logger, requestId, provider, stage, error);
    const headers = new Headers();
    headers.append("set-cookie", clearOAuthCookie);
    const normalized = normalizeHttpError(error);
    for (const cookie of new Headers(normalized.responseHeaders).getSetCookie()) {
      headers.append("set-cookie", cookie);
    }
    return oauthRedirect(oauthFailureStatus(error), headers);
  }
}

function parseOAuthCallbackQuery(
  url: URL,
  provider: ProviderKind
): { state: string; code: string | null; providerError: string | null } {
  const limits: Record<string, number> =
    provider === "google"
      ? {
          state: 1024,
          code: 4096,
          error: 128,
          scope: 4096,
          authuser: 128,
          prompt: 128,
          iss: 128,
          error_description: 2048,
          error_uri: 2048
        }
      : {
          state: 1024,
          code: 4096,
          error: 128,
          session_state: 1024,
          error_description: 2048,
          error_codes: 1024,
          error_uri: 2048,
          trace_id: 256,
          correlation_id: 256,
          timestamp: 128
        };
  const allowed = new Set(Object.keys(limits));
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
    throw new ControlOAuthServiceError("OAUTH_STATE_INVALID");
  }
  for (const [key, maxLength] of Object.entries(limits)) {
    const values = url.searchParams.getAll(key);
    if (
      values.length > 1 ||
      (values.length === 1 &&
        (values[0]!.length < 1 || values[0]!.length > maxLength))
    ) {
      throw new ControlOAuthServiceError("OAUTH_STATE_INVALID");
    }
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const providerError = url.searchParams.get("error");
  const issuer = url.searchParams.get("iss");
  if (
    !state ||
    (code === null) === (providerError === null) ||
    (provider === "google" &&
      issuer !== null &&
      issuer !== "https://accounts.google.com" &&
      issuer !== "accounts.google.com")
  ) {
    throw new ControlOAuthServiceError("OAUTH_STATE_INVALID");
  }
  return { state, code, providerError };
}

function oauthFailureStatus(
  error: unknown
): "failed" | "invalid" | "cancelled" {
  if (error instanceof ControlOAuthServiceError) {
    if (error.code === "OAUTH_CANCELLED") return "cancelled";
    if (error.code === "OAUTH_STATE_INVALID") return "invalid";
  }
  if (
    error instanceof ControlAuthError ||
    (error instanceof HttpError &&
      (error.code === "ADMIN_UNAUTHORIZED" || error.code === "INVALID_QUERY"))
  ) {
    return "invalid";
  }
  return "failed";
}

async function sourceImpact(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  sourceId: string
): Promise<Response> {
  const { admin, context } = await protectedAdmin(request, dependencies, now);
  return ok(impactForSource(context.document, sourceId), {
    headers: csrfHeaders(admin)
  });
}

async function removeSource(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  sourceId: string
): Promise<Response> {
  const body = await readBoundedJsonObject(request);
  assertConfirmation(body);
  const { admin } = await protectedAdmin(request, dependencies, now);
  await authorizeAdminMutation(request, dependencies, admin, now);
  const removed = await dependencies.admin.removeSource(
      dependencies.config.householdId,
      sourceId
    );
  return ok(
    safeImpactMutation(removed),
    { headers: csrfHeaders(admin) }
  );
}

async function providerFolders(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  sourceId: string
): Promise<Response> {
  const url = new URL(request.url);
  assertQueryKeys(url, ["providerFolderId", "cursor", "limit"]);
  const providerFolderId = optionalUniqueQuery(url, "providerFolderId", 1024);
  const cursor = optionalUniqueQuery(url, "cursor", 4096);
  const pageSize = pageSizeQuery(url, 200);
  const { admin } = await protectedAdmin(request, dependencies, now);
  return ok(
    await dependencies.providerFolders.browse({
      householdId: dependencies.config.householdId,
      sourceId,
      ...(providerFolderId === null ? {} : { providerFolderId }),
      cursor,
      pageSize
    }),
    { headers: csrfHeaders(admin) }
  );
}

async function createRoot(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  sourceId: string
): Promise<Response> {
  const body = await readBoundedJsonObject(request);
  assertOnlyKeys(body, ["providerNodeId", "displayName"], "INVALID_ROOT");
  if (
    typeof body.providerNodeId !== "string" ||
    body.providerNodeId.length < 1 ||
    body.providerNodeId.length > 1024 ||
    (body.displayName !== undefined &&
      (typeof body.displayName !== "string" || body.displayName.length > 120))
  ) {
    throw new HttpError(400, "INVALID_ROOT", "Root request is invalid.");
  }
  const { admin } = await protectedAdmin(request, dependencies, now);
  await authorizeAdminMutation(request, dependencies, admin, now);
  return ok(
    await dependencies.providerFolders.createRoot({
      householdId: dependencies.config.householdId,
      sourceId,
      providerNodeId: body.providerNodeId,
      ...(body.displayName === undefined
        ? {}
        : { displayName: body.displayName })
    }),
    { headers: csrfHeaders(admin) }
  );
}

async function rootImpact(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  rootId: string
): Promise<Response> {
  const { admin, context } = await protectedAdmin(request, dependencies, now);
  return ok(impactForRoot(context.document, rootId), {
    headers: csrfHeaders(admin)
  });
}

async function removeRoot(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  rootId: string
): Promise<Response> {
  const body = await readBoundedJsonObject(request);
  assertConfirmation(body);
  const { admin } = await protectedAdmin(request, dependencies, now);
  await authorizeAdminMutation(request, dependencies, admin, now);
  const removed = await dependencies.admin.removeRoot(
    dependencies.config.householdId,
    rootId
  );
  return ok(
    safeImpactMutation(removed),
    { headers: csrfHeaders(admin) }
  );
}

async function createDeviceRequest(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  await enforceRateLimit(
    dependencies,
    "device-request-create",
    dependencies.requestSubject(request),
    now
  );
  const body = await readBoundedJsonObject(request);
  assertOnlyKeys(body, ["name", "requestedName"], "INVALID_DEVICE_NAME");
  if (body.name !== undefined && body.requestedName !== undefined) {
    throw new HttpError(
      400,
      "INVALID_DEVICE_NAME",
      "The device name is invalid."
    );
  }
  const name = body.name ?? body.requestedName;
  if (typeof name !== "string") {
    throw new HttpError(
      400,
      "INVALID_DEVICE_NAME",
      "The device name is invalid."
    );
  }
  const result = await dependencies.enrollment.createRequest(
    name,
    dependencies.requestSubject(request),
    now
  );
  const headers = new Headers();
  headers.append("set-cookie", result.setRequestCookie);
  return ok({ request: result.request }, { status: 201, headers });
}

async function deviceRequestStatus(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  let raw: string | null;
  try {
    raw = readUniqueCookie(request, "device_request");
  } catch {
    throw invalidDeviceRequest();
  }
  await enforceRateLimit(
    dependencies,
    "device-request-status",
    raw ?? dependencies.requestSubject(request),
    now
  );
  if (!raw) throw invalidDeviceRequest();
  const context = await currentOrLoadControlRequestContext(dependencies);
  return enrollmentResponse(
    await dependencies.enrollment.status(raw, now, context)
  );
}

async function tvHome(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  const protectedResult = await protectedDevice(request, dependencies, now);
  return ok(await dependencies.browse.home(protectedResult.device));
}

async function tvFolder(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  handle: string
): Promise<Response> {
  const url = new URL(request.url);
  assertQueryKeys(url, ["cursor", "limit"]);
  const cursor = optionalUniqueQuery(url, "cursor", 4096);
  const pageSize = pageSizeQuery(url, 100);
  const { device } = await protectedDevice(request, dependencies, now);
  return ok(await dependencies.browse.folder(device, handle, cursor, pageSize));
}

async function thumbnailUrls(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  const body = await readBoundedJsonObject(request);
  assertOnlyKeys(body, ["handles", "maxDimension", "refresh"], "INVALID_THUMBNAIL_REQUEST");
  if (
    !Array.isArray(body.handles) ||
    !Number.isInteger(body.maxDimension) ||
    (body.maxDimension as number) < 64 ||
    (body.maxDimension as number) > 4096 ||
    (body.refresh !== undefined && typeof body.refresh !== "boolean")
  ) {
    throw new HttpError(
      400,
      "INVALID_THUMBNAIL_REQUEST",
      "Thumbnail request is invalid."
    );
  }
  const handles = boundedStringArray(
    body.handles,
    1,
    100,
    8192,
    "INVALID_THUMBNAIL_REQUEST"
  );
  const { device } = await protectedDevice(request, dependencies, now);
  await enforceRateLimit(
    dependencies,
    "url-vending",
    device.deviceId,
    now
  );
  const result = await dependencies.directMedia.thumbnails(
    device,
    handles,
    body.maxDimension as number,
    body.refresh === true
  );
  return ok({ items: result.items }, { headers: result.responseHeaders });
}

async function mediaUrl(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<Response> {
  const body = await readBoundedJsonObject(request);
  assertOnlyKeys(body, ["handle"], "INVALID_MEDIA_REQUEST");
  if (
    typeof body.handle !== "string" ||
    body.handle.length < 1 ||
    body.handle.length > 8192
  ) {
    throw new HttpError(
      400,
      "INVALID_MEDIA_REQUEST",
      "Media request is invalid."
    );
  }
  const { device } = await protectedDevice(request, dependencies, now);
  await enforceRateLimit(
    dependencies,
    "url-vending",
    device.deviceId,
    now
  );
  const result = await dependencies.directMedia.media(device, body.handle);
  const { responseHeaders, ...data } = result;
  return ok(data, { headers: responseHeaders });
}

async function protectedAdmin(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<ProtectedAdminResult> {
  let token: string | null;
  try {
    token = readUniqueCookie(request, "admin_session");
    if (!token) throw new Error("MISSING");
  } catch {
    throw unauthorizedAdmin();
  }
  const context = await currentOrLoadControlRequestContext(dependencies);
  return {
    admin: await dependencies.auth.admin(request, context, now),
    context
  };
}

async function googleMedia(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date,
  handle: string,
): Promise<Response> {
  const { device } = await protectedDevice(request, dependencies, now);
  await enforceRateLimit(
    dependencies,
    "media-stream",
    device.deviceId,
    now,
  );
  return dependencies.directMedia.googleMedia(device, handle, {
    method: request.method as "GET" | "HEAD",
    range: request.headers.get("range"),
    ifRange: request.headers.get("if-range"),
    signal: request.signal,
  });
}

async function protectedDevice(
  request: Request,
  dependencies: ActiveDependencies,
  now: Date
): Promise<ProtectedDeviceResult> {
  let token: string | null;
  try {
    token = readUniqueCookie(request, "device_session");
    if (!token) throw new Error("MISSING");
  } catch {
    throw unauthorizedDevice();
  }
  const context = await currentOrLoadControlRequestContext(dependencies);
  return {
    device: await dependencies.auth.device(request, context, now),
    context
  };
}

async function currentOrLoadControlRequestContext(
  dependencies: ActiveDependencies
): Promise<ControlRequestContext> {
  try {
    return dependencies.requestContext.current();
  } catch {
    return loadControlRequestContext(
      dependencies.controlStore,
      dependencies.requestContext
    );
  }
}

function logOAuthCallbackFailure(
  logger: ControlApiLogger,
  requestId: string,
  provider: ProviderKind,
  stage: OAuthCallbackFailureLoggerEvent["stage"],
  error: unknown
): void {
  const normalized = error === null ? null : normalizeHttpError(error);
  safeLog(logger, "error", {
    level: "error",
    event: "oauth_callback_failed",
    requestId,
    provider,
    stage,
    errorCode: normalized?.code ?? "OAUTH_STATE_COOKIE_MISSING",
    ...(error === null ? {} : safeErrorIdentity(error))
  });
}

function safeLog(
  logger: ControlApiLogger,
  method: "info" | "error",
  event: ControlApiLoggerEvent
): void {
  try {
    logger[method](event);
  } catch {
    // Observability cannot alter request behavior.
  }
}

async function authorizeAdminMutation(
  request: Request,
  dependencies: ActiveDependencies,
  admin: AuthenticatedControlAdmin,
  now: Date
): Promise<void> {
  verifyAdminMutation(request, admin, dependencies.config.allowedOrigin);
  await enforceRateLimit(
    dependencies,
    "admin-mutation",
    admin.sessionId,
    now
  );
}

function verifyAdminMutation(
  request: Request,
  admin: AuthenticatedControlAdmin,
  allowedOrigin: string
): void {
  if (request.headers.get("origin") !== allowedOrigin) {
    throw new HttpError(403, "ORIGIN_INVALID", "Request origin is invalid.");
  }
  if (request.headers.get("x-csrf-token") !== admin.csrfToken) {
    throw new HttpError(
      403,
      "CSRF_INVALID",
      "CSRF validation failed.",
      undefined,
      { "x-csrf-token": admin.csrfToken }
    );
  }
}

async function enforceRateLimit(
  dependencies: ActiveDependencies,
  bucket: string,
  subject: string,
  now: Date
): Promise<void> {
  const policy = dependencies.config.rateLimits?.[bucket] ?? DEFAULT_RATE_LIMITS[bucket];
  if (!policy) return;
  const result = await dependencies.rateLimiter.consume(
    bucket,
    subject,
    now,
    policy
  );
  if (!result.allowed) {
    throw new HttpError(
      429,
      "RATE_LIMITED",
      "Too many requests.",
      result.retryAfterSeconds
    );
  }
}

async function snapshotFromContext(
  context: ControlRequestContext,
  admin: ControlAdminService,
  now: Date
) {
  const recoveryCopy = await admin.recoveryStatus();
  const currentTime = now.getTime();
  return {
    revision: context.revision,
    household: householdDto(context.document),
    pendingRequests: Object.values(context.document.pendingDeviceRequests)
      .filter(
        (request) =>
          request.status === "pending" &&
          Date.parse(request.expiresAt) > currentTime
      )
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          left.id.localeCompare(right.id)
      )
      .map(controlRequestDto),
    devices: Object.values(context.document.devices)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(controlDeviceDtoFromDocument),
    sources: Object.values(context.document.sources)
      .sort((left, right) => left.accountLabel.localeCompare(right.accountLabel))
      .map(controlSourceDto),
    roots: Object.values(context.document.roots)
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map(controlRootSummary),
    recoveryCopy
  };
}

function householdDto(document: ControlPlaneDocumentV2) {
  return {
    allowNewDeviceRequests: document.household.allowNewDeviceRequests,
    defaultMediaOrder: document.household.defaultMediaOrder,
    defaultSlideshowSeconds: document.household.defaultSlideshowSeconds
  };
}

function controlDeviceDto(
  authenticated: AuthenticatedControlDevice
): ControlDeviceDto {
  return controlDeviceDtoFromDocument(authenticated.device);
}

function controlDeviceDtoFromDocument(
  device: ControlPlaneDocumentV2["devices"][string]
): ControlDeviceDto {
  return {
    id: device.id,
    name: device.name,
    enabled: device.enabled,
    assignedRootIds: [...device.assignedRootIds],
    mediaOrder: device.mediaOrder,
    slideshowSeconds: device.slideshowSeconds,
    createdAt: device.createdAt,
    approvedAt: device.approvedAt,
    revokedAt: device.revokedAt
  };
}

function legacyDeviceToControl(
  device: ControlDeviceDto & { lastSeenAt?: string }
): ControlDeviceDto {
  return {
    id: device.id,
    name: device.name,
    enabled: device.enabled,
    assignedRootIds: [...device.assignedRootIds],
    mediaOrder: device.mediaOrder,
    slideshowSeconds: device.slideshowSeconds,
    createdAt: device.createdAt,
    approvedAt: device.approvedAt,
    revokedAt: device.revokedAt
  };
}

function safeImpactMutation(value: {
  removed: true;
  roots: Array<ControlRootDto & {
    providerNodeId?: string;
    ancestryProviderIds?: string[];
  }>;
  devices: Array<ControlDeviceDto & { lastSeenAt?: string }>;
}) {
  return {
    removed: true as const,
    roots: value.roots.map((root) => ({
      id: root.id,
      sourceId: root.sourceId,
      displayName: root.displayName,
      enabled: root.enabled,
      createdAt: root.createdAt
    })),
    devices: value.devices.map(legacyDeviceToControl)
  };
}

function controlRequestDto(
  request: ControlPlaneDocumentV2["pendingDeviceRequests"][string]
): ControlRequestDto {
  return {
    id: request.id,
    requestedName: request.requestedName,
    status: request.status,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    resolvedAt: request.resolvedAt,
    approvedDeviceId: request.approvedDeviceId
  };
}

function controlSourceDto(
  source: ControlPlaneDocumentV2["sources"][string]
): ControlSourceDto {
  return {
    id: source.id,
    provider: source.provider,
    accountLabel: source.accountLabel,
    status: source.status,
    createdAt: source.createdAt
  };
}

function controlRootSummary(
  root: ControlPlaneDocumentV2["roots"][string]
): ControlRootDto {
  return {
    id: root.id,
    sourceId: root.sourceId,
    displayName: root.displayName,
    enabled: root.enabled,
    createdAt: root.createdAt
  };
}

function impactForSource(document: ControlPlaneDocumentV2, sourceId: string) {
  if (!document.sources[sourceId]) {
    throw notFound("SOURCE_NOT_FOUND", "Source not found.");
  }
  const roots = Object.values(document.roots).filter(
    (root) => root.sourceId === sourceId
  );
  const rootIds = new Set(roots.map((root) => root.id));
  return {
    roots: roots.map(controlRootSummary),
    devices: Object.values(document.devices)
      .filter((device) =>
        device.assignedRootIds.some((rootId) => rootIds.has(rootId))
      )
      .map(controlDeviceDtoFromDocument)
  };
}

function impactForRoot(document: ControlPlaneDocumentV2, rootId: string) {
  const root = document.roots[rootId];
  if (!root) throw notFound("ROOT_NOT_FOUND", "Root not found.");
  return {
    roots: [controlRootSummary(root)],
    devices: Object.values(document.devices)
      .filter((device) => device.assignedRootIds.includes(rootId))
      .map(controlDeviceDtoFromDocument)
  };
}

function settingsBody(body: Record<string, unknown>): UpdateAdminSettingsBody {
  assertOnlyKeys(
    body,
    [
      "allowNewDeviceRequests",
      "defaultMediaOrder",
      "defaultSlideshowSeconds"
    ],
    "INVALID_SETTINGS"
  );
  if (
    (body.allowNewDeviceRequests !== undefined &&
      typeof body.allowNewDeviceRequests !== "boolean") ||
    (body.defaultMediaOrder !== undefined &&
      !["captured-desc", "captured-asc", "name-asc"].includes(
        String(body.defaultMediaOrder)
      )) ||
    (body.defaultSlideshowSeconds !== undefined &&
      (!Number.isInteger(body.defaultSlideshowSeconds) ||
        (body.defaultSlideshowSeconds as number) < 1 ||
        (body.defaultSlideshowSeconds as number) > 3600))
  ) {
    throw new HttpError(400, "INVALID_SETTINGS", "Settings are invalid.");
  }
  return body as UpdateAdminSettingsBody;
}

function approvalBody(body: Record<string, unknown>): ApproveDeviceRequestBody {
  assertOnlyKeys(body, ["name", "rootIds"], "INVALID_DEVICE");
  if (
    typeof body.name !== "string" ||
    body.name.trim().length < 1 ||
    body.name.trim().length > 120 ||
    !Array.isArray(body.rootIds)
  ) {
    throw new HttpError(400, "INVALID_DEVICE", "Device request is invalid.");
  }
  return {
    name: body.name.trim(),
    rootIds: boundedStringArray(
      body.rootIds,
      1,
      32,
      256,
      "INVALID_ROOT_ASSIGNMENT"
    )
  };
}

function updateDeviceBody(body: Record<string, unknown>): UpdateDeviceBody {
  assertOnlyKeys(
    body,
    ["name", "enabled", "assignedRootIds", "mediaOrder", "slideshowSeconds"],
    "INVALID_DEVICE"
  );
  if (
    (body.name !== undefined &&
      (typeof body.name !== "string" ||
        body.name.trim().length < 1 ||
        body.name.trim().length > 120)) ||
    (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
    (body.mediaOrder !== undefined &&
      !["captured-desc", "captured-asc", "name-asc"].includes(
        String(body.mediaOrder)
      )) ||
    (body.slideshowSeconds !== undefined &&
      body.slideshowSeconds !== null &&
      (!Number.isInteger(body.slideshowSeconds) ||
        (body.slideshowSeconds as number) < 1 ||
        (body.slideshowSeconds as number) > 3600))
  ) {
    throw new HttpError(400, "INVALID_DEVICE", "Device request is invalid.");
  }
  const assignedRootIds =
    body.assignedRootIds === undefined
      ? undefined
      : Array.isArray(body.assignedRootIds)
        ? boundedStringArray(
            body.assignedRootIds,
            0,
            32,
            256,
            "INVALID_ROOT_ASSIGNMENT"
          )
        : null;
  if (assignedRootIds === null) {
    throw new HttpError(400, "INVALID_DEVICE", "Device request is invalid.");
  }
  return {
    ...(body.name === undefined ? {} : { name: body.name.trim() }),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(assignedRootIds === undefined ? {} : { assignedRootIds }),
    ...(body.mediaOrder === undefined
      ? {}
      : { mediaOrder: body.mediaOrder as UpdateDeviceBody["mediaOrder"] }),
    ...(body.slideshowSeconds === undefined
      ? {}
      : { slideshowSeconds: body.slideshowSeconds })
  } as UpdateDeviceBody;
}

function assertConfirmation(body: Record<string, unknown>): void {
  assertOnlyKeys(body, ["confirm"], "CONFIRMATION_REQUIRED");
  if (body.confirm !== true) {
    throw new HttpError(
      400,
      "CONFIRMATION_REQUIRED",
      "Confirmation is required."
    );
  }
}

async function readBoundedJsonObject(
  request: Request
): Promise<Record<string, unknown>> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Expected a JSON request body."
    );
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_JSON_BODY_BYTES)
  ) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null;
  try {
    reader = request.body?.getReader() ?? null;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
  if (!reader) {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
  try {
    while (true) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch {
        cancelReaderBestEffort(reader);
        throw new HttpError(
          400,
          "INVALID_JSON",
          "The request body is not valid JSON."
        );
      }
      const { done, value } = read;
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        cancelReaderBestEffort(reader);
        throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Lock release is cleanup only and never changes the response.
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("INVALID_JSON_OBJECT");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

function cancelReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array>
): void {
  try {
    const cancellation = reader.cancel();
    if (
      cancellation &&
      typeof (cancellation as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(cancellation).catch(() => undefined);
    }
  } catch {
    // Cancellation is advisory cleanup and never changes the response.
  }
}

function assertOnlyKeys(
  body: Record<string, unknown>,
  expected: readonly string[],
  code: string
): void {
  const allowed = new Set(expected);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new HttpError(400, code, "Request body is invalid.");
  }
}

function boundedStringArray(
  value: unknown[],
  minimum: number,
  maximum: number,
  maxLength: number,
  code = "INVALID_REQUEST"
): string[] {
  if (
    value.length < minimum ||
    value.length > maximum ||
    value.some(
      (item) =>
        typeof item !== "string" || item.length < 1 || item.length > maxLength
    ) ||
    new Set(value).size !== value.length
) {
    throw new HttpError(400, code, "Request body is invalid.");
  }
  return value as string[];
}

function pageSizeQuery(url: URL, maximum: number): number {
  const values = url.searchParams.getAll("limit");
  if (values.length === 0) return DEFAULT_PAGE_SIZE;
  if (values.length !== 1 || !/^\d+$/.test(values[0]!)) {
    throw new HttpError(400, "INVALID_PAGE_SIZE", "Page size is invalid.");
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new HttpError(400, "INVALID_PAGE_SIZE", "Page size is invalid.");
  }
  return value;
}

function optionalUniqueQuery(
  url: URL,
  name: string,
  maxLength: number
): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return null;
  if (values.length !== 1 || values[0]!.length < 1 || values[0]!.length > maxLength) {
    throw new HttpError(400, "INVALID_QUERY", "Request query is invalid.");
  }
  return values[0]!;
}

function assertQueryKeys(url: URL, expected: readonly string[]): void {
  const allowed = new Set(expected);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
    throw new HttpError(400, "INVALID_QUERY", "Request query is invalid.");
  }
}

function enrollmentResponse(
  status: ControlEnrollmentStatus,
  initialHeaders = new Headers()
): Response {
  const headers = new Headers(initialHeaders);
  if (status.setDeviceCookie) {
    headers.append("set-cookie", status.setDeviceCookie);
  }
  if (status.clearRequestCookie) {
    headers.append("set-cookie", status.clearRequestCookie);
  }
  return ok({ enrollment: status.enrollment }, { headers });
}

function oauthRedirect(
  status: "connected" | "failed" | "invalid" | "cancelled",
  responseHeaders?: HeadersInit | string
): Response {
  const headers = new Headers(
    typeof responseHeaders === "string" ? undefined : responseHeaders
  );
  if (typeof responseHeaders === "string") {
    headers.append("set-cookie", responseHeaders);
  }
  headers.set("location", `/admin?section=sources&oauth=${status}`);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  return new Response(null, { status: 303, headers });
}

function clearOAuthStateCookie(): string {
  return [
    "oauth_state=",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

function csrfHeaders(admin: AuthenticatedControlAdmin): Headers {
  return new Headers({ "x-csrf-token": admin.csrfToken });
}

function requireMethod(request: Request, method: string): void {
  if (request.method !== method) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", undefined, {
      allow: method
    });
  }
}

function requireOneMethod(request: Request, methods: readonly string[]): void {
  if (!methods.includes(request.method)) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", undefined, {
      allow: methods.join(", ")
    });
  }
}

function decodePathId(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(decoded) ||
      decoded.includes("/")
    ) {
      throw new Error("INVALID_PATH");
    }
    return decoded;
  } catch {
    throw new HttpError(400, "INVALID_PATH", "Request path is invalid.");
  }
}

function decodeHandle(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.length < 1 ||
      decoded.length > 8192 ||
      decoded.includes("/") ||
      !/^[A-Za-z0-9._~-]+$/.test(decoded)
    ) {
      throw new Error("INVALID_HANDLE");
    }
    return decoded;
  } catch {
    throw new HttpError(400, "INVALID_PATH", "Request path is invalid.");
  }
}

function safeRequestId(value: string | null): string | null {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function requestEvent(
  request: Request,
  path: string,
  requestId: string,
  status: number,
  durationMs: number,
  errorCode?: string
): ControlApiLoggerEvent {
  return {
    level: status >= 500 ? "error" : "info",
    event: "api_request",
    requestId,
    method: request.method,
    path,
    status,
    durationMs,
    ...(errorCode ? { errorCode } : {})
  };
}

function classifyRoute(request: Request): string {
  const path = new URL(request.url).pathname;
  if (
    path === "/api/bootstrap" ||
    path === "/api/admin/login" ||
    path === "/api/admin/logout" ||
    path === "/api/admin/snapshot" ||
    path === "/api/admin/settings" ||
    path === "/api/admin/passphrase" ||
    path === "/api/admin/requests" ||
    path === "/api/admin/devices" ||
    path === "/api/admin/sources" ||
    path === "/api/device-requests" ||
    path === "/api/device-requests/status" ||
    path === "/api/tv/home" ||
    path === "/api/tv/thumbnail-urls" ||
    path === "/api/tv/media-url"
  ) {
    return path;
  }
  if (/^\/api\/admin\/requests\/[^/]+\/(approve|deny)$/.test(path)) {
    return "/api/admin/requests/:id/:action";
  }
  if (/^\/api\/admin\/devices\/[^/]+$/.test(path)) {
    return "/api/admin/devices/:id";
  }
  if (/^\/api\/admin\/sources\/(google|onedrive)\/authorize$/.test(path)) {
    return "/api/admin/sources/:provider/authorize";
  }
  if (/^\/api\/admin\/sources\/(google|onedrive)\/callback$/.test(path)) {
    return "/api/admin/sources/:provider/callback";
  }
  if (/^\/api\/admin\/sources\/[^/]+\/impact$/.test(path)) {
    return "/api/admin/sources/:id/impact";
  }
  if (/^\/api\/admin\/sources\/[^/]+\/provider-folders$/.test(path)) {
    return "/api/admin/sources/:id/provider-folders";
  }
  if (/^\/api\/admin\/sources\/[^/]+\/roots$/.test(path)) {
    return "/api/admin/sources/:id/roots";
  }
  if (/^\/api\/admin\/sources\/[^/]+$/.test(path)) {
    return "/api/admin/sources/:id";
  }
  if (/^\/api\/admin\/roots\/[^/]+\/impact$/.test(path)) {
    return "/api/admin/roots/:id/impact";
  }
  if (/^\/api\/admin\/roots\/[^/]+$/.test(path)) {
    return "/api/admin/roots/:id";
  }
  if (/^\/api\/tv\/folders\/[^/]+$/.test(path)) {
    return "/api/tv/folders/:handle";
  }
  if (/^\/api\/tv\/google-media\/[^/]+$/.test(path)) {
    return "/api/tv/google-media/:handle";
  }
  return "/api/:unmatched";
}

function safeErrorIdentity(
  error: unknown
): Pick<ControlApiLoggerEvent, "errorName" | "causeName" | "causeCode"> {
  if (!error || typeof error !== "object") return {};
  const value = error as { name?: unknown; cause?: unknown };
  const cause =
    value.cause && typeof value.cause === "object"
      ? (value.cause as { name?: unknown; code?: unknown })
      : null;
  return {
    ...(safeDiagnostic(value.name)
      ? { errorName: safeDiagnostic(value.name)! }
      : {}),
    ...(safeDiagnostic(cause?.name)
      ? { causeName: safeDiagnostic(cause?.name)! }
      : {}),
    ...(safeDiagnostic(cause?.code)
      ? { causeCode: safeDiagnostic(cause?.code)! }
      : {})
  };
}

function safeDiagnostic(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
    ? value
    : null;
}

function secureResponse(response: Response, requestId: string): void {
  response.headers.set("x-request-id", requestId);
  secureHeaders(response.headers);
}

function secureHeaders(headers: Headers): void {
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("cross-origin-resource-policy", "same-origin");
  if (!headers.has("referrer-policy")) {
    headers.set("referrer-policy", "no-referrer");
  }
}

function normalizeHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ControlAuthError) {
    return new HttpError(
      error.code === "INVALID_CREDENTIALS" ? 401 : 401,
      error.code,
      error.code === "INVALID_CREDENTIALS"
        ? "The passphrase is incorrect."
        : "Authentication is required.",
      undefined,
      error.clearCookie ? { "set-cookie": error.clearCookie } : undefined
    );
  }
  if (error instanceof ControlEnrollmentError) {
    return new HttpError(
      enrollmentStatusCode(error.code),
      error.code,
      enrollmentMessage(error.code),
      undefined,
      error.clearCookie ? { "set-cookie": error.clearCookie } : undefined
    );
  }
  if (error instanceof ControlAdminServiceError) {
    const status =
      error.code.endsWith("_NOT_FOUND") || error.code === "HOUSEHOLD_NOT_FOUND"
        ? 404
        : error.code === "INVALID_CREDENTIALS"
          ? 401
          : 400;
    return new HttpError(status, error.code, adminMessage(error.code));
  }
  if (error instanceof ControlMutationError) {
    return mutationHttpError(error.code);
  }
  if (error instanceof ControlPlaneStoreError) {
    return new HttpError(
      error.code === "CONTROL_PLANE_CONFLICT" ? 409 : 503,
      error.code,
      error.code === "CONTROL_PLANE_CONFLICT"
        ? "The control state changed. Retry the request."
        : "The service is temporarily unavailable."
    );
  }
  if (error instanceof ControlOAuthServiceError) {
    return new HttpError(
      error.code === "SOURCE_NOT_FOUND" ? 404 : 400,
      error.code,
      error.code === "SOURCE_NOT_FOUND"
        ? "Source not found."
        : "OAuth request could not be completed."
    );
  }
  if (error instanceof LiveProviderFolderError) {
    const status = error.code.endsWith("NOT_FOUND") ? 404 : 400;
    return new HttpError(status, error.code, "Provider folder request failed.");
  }
  if (error instanceof LiveBrowseError) {
    const status =
      error.code === "DEVICE_UNAUTHORIZED"
        ? 401
        : error.code === "INVALID_PAGE_SIZE"
          ? 400
          : 404;
    return new HttpError(status, error.code, browseMessage(error.code));
  }
  if (error instanceof DirectMediaError) {
    return new HttpError(
      error.code === "INVALID_THUMBNAIL_REQUEST" ? 400 : 404,
      error.code,
      "Media request could not be completed."
    );
  }
  if (error instanceof CredentialBrokerError) {
    return new HttpError(404, error.code, "Source not found.");
  }
  if (error instanceof ProviderError) {
    const providerStatus =
      error.code === "PROVIDER_REAUTH_REQUIRED"
        ? 409
        : error.code === "PROVIDER_NOT_FOUND"
          ? 404
          : error.code === "PROVIDER_THROTTLED"
            ? 429
            : error.code === "PROVIDER_TIMEOUT" ||
                error.code === "PROVIDER_UNAVAILABLE"
              ? 503
              : 502;
    return new HttpError(
      providerStatus,
      error.code,
      "Provider request failed.",
      boundedRetryAfterSeconds(error.retryAfterSeconds)
    );
  }
  return new HttpError(
    500,
    "INTERNAL_ERROR",
    "An unexpected error occurred."
  );
}

function mutationHttpError(code: ControlMutationErrorCode): HttpError {
  const notFoundCodes = new Set<ControlMutationErrorCode>([
    "DEVICE_NOT_FOUND",
    "DEVICE_REQUEST_NOT_FOUND",
    "SOURCE_NOT_FOUND"
  ]);
  const conflictCodes = new Set<ControlMutationErrorCode>([
    "DEVICE_ALREADY_EXISTS",
    "DEVICE_REVOKED",
    "DEVICE_REQUEST_EXPIRED",
    "DEVICE_REQUEST_RESOLVED",
    "ROOT_IDENTITY_MISMATCH",
    "SOURCE_IDENTITY_MISMATCH"
  ]);
  return new HttpError(
    notFoundCodes.has(code) ? 404 : conflictCodes.has(code) ? 409 : 400,
    code,
    notFoundCodes.has(code)
      ? "Requested control record was not found."
      : conflictCodes.has(code)
        ? "The control state changed. Retry the request."
        : "The request is invalid."
  );
}

function enrollmentStatusCode(code: ControlEnrollmentError["code"]): number {
  if (code === "DEVICE_REQUEST_REQUIRED") return 401;
  if (code === "DEVICE_REQUESTS_DISABLED") return 403;
  if (code === "HOUSEHOLD_NOT_FOUND") return 404;
  return 400;
}

function enrollmentMessage(code: ControlEnrollmentError["code"]): string {
  if (code === "DEVICE_REQUEST_REQUIRED") return "A device request is required.";
  if (code === "DEVICE_REQUESTS_DISABLED") {
    return "New device requests are disabled.";
  }
  if (code === "HOUSEHOLD_NOT_FOUND") return "Household not found.";
  return "The device name is invalid.";
}

function adminMessage(code: ControlAdminServiceError["code"]): string {
  if (code.endsWith("_NOT_FOUND")) return "Requested record was not found.";
  if (code === "INVALID_CREDENTIALS") {
    return "The current passphrase is incorrect.";
  }
  return "The passphrase is invalid.";
}

function browseMessage(code: LiveBrowseError["code"]): string {
  if (code === "DEVICE_UNAUTHORIZED") return "Authentication is required.";
  if (code === "INVALID_PAGE_SIZE") return "Page size is invalid.";
  if (code === "NAVIGATION_EXPIRED") return "Navigation has expired.";
  return "Item not found.";
}

function boundedRetryAfterSeconds(value: number | null): number | undefined {
  return Number.isSafeInteger(value) && value! >= 1 && value! <= 86_400
    ? value!
    : undefined;
}

function unauthorizedDevice(): HttpError {
  return new HttpError(
    401,
    "DEVICE_UNAUTHORIZED",
    "Authentication is required.",
    undefined,
    { "set-cookie": clearSessionCookie("device") }
  );
}

function unauthorizedAdmin(): HttpError {
  return new HttpError(
    401,
    "ADMIN_UNAUTHORIZED",
    "Authentication is required.",
    undefined,
    { "set-cookie": clearSessionCookie("admin") }
  );
}

function invalidDeviceRequest(): HttpError {
  return new HttpError(
    401,
    "DEVICE_REQUEST_REQUIRED",
    "A device request is required.",
    undefined,
    { "set-cookie": clearSessionCookie("request") }
  );
}

function notFound(code: string, message: string): HttpError {
  return new HttpError(404, code, message);
}
