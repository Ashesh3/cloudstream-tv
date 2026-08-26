import type {
  AssignedRoot,
  ApproveDeviceRequestBody,
  Device,
  Household,
  MediaNode,
  ProviderKind,
  UpdateDeviceBody
} from "@cloudframe/shared";
import {
  encodeAdminOverviewResponse,
  encodeAssignedRootDto,
  encodeBootstrapResponse,
  encodeDeviceDto,
  encodeDeviceRequestDto,
  encodeMediaNodeDto,
  encodeSourceDto,
  encodeWatchHistoryDto
} from "@cloudframe/shared";
import { clearSessionCookie, createSessionCookie } from "../auth/cookies";
import { hashPassphrase, verifyPassphrase } from "../auth/passphrase";
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
import { OAuthServiceError } from "../services/oauth";
import { ProviderError } from "@cloudframe/providers";
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

export interface ApiLogEvent {
  level: "info" | "error";
  event: "api_request";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  sourceId?: string;
  deviceId?: string;
  runId?: string;
  errorName?: string;
  causeName?: string;
  causeCode?: string;
}

export interface ApiLogger {
  info(event: ApiLogEvent): void;
  error(event: ApiLogEvent): void;
}

export interface ApiAppDependencies {
  repository: AppRepository;
  config: ApiAppConfig;
  now?: () => Date;
  createId?: (prefix: string) => string;
  issueToken?: () => OpaqueToken;
  requestSubject?: RequestSubjectResolver;
  logger?: ApiLogger;
  browse?: {
    home(device: Device, household: Household): Promise<unknown>;
    folder(device: Device, household: Household, nodeId: string, page: { cursor: string | null; limit: number }): Promise<unknown>;
    history(device: Device, household: Household): Promise<unknown>;
    saveHistory(device: Device, household: Household, nodeId: string, value: { positionSeconds: number; durationSeconds: number; completed: boolean }): Promise<unknown>;
  };
  mediaUrls?: {
    media(device: Device, household: Household, nodeId: string): Promise<{ url: string; expiresAt: Date; revision: string | null; responseHeaders: HeadersInit }>;
    thumbnails(device: Device, household: Household, nodeIds: string[], maxDimension: number): Promise<{ items: unknown[]; responseHeaders: HeadersInit }>;
    adminThumbnails(householdId: string, nodeIds: string[], maxDimension: number): Promise<{ items: unknown[]; responseHeaders: HeadersInit }>;
  };
  oauth?: {
    beginAuthorization(input: { householdId: string; adminSessionId: string; provider: ProviderKind; redirectUri: string; reconnectSourceId?: string }): Promise<{ authorizationUrl: string }>;
    completeAuthorization(input: { householdId: string; adminSessionId: string; provider: ProviderKind; redirectUri: string; state: string; code?: string; providerError?: string }): Promise<{ sourceId: string; status: "connected" }>;
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
    requestSubject: input.requestSubject ?? requestSubject,
    logger: input.logger ?? consoleApiLogger
  };

  return async (request: Request): Promise<Response> => {
    const requestId = safeRequestId(request.headers.get("x-request-id")) ?? crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const response = await routeRequest(request, dependencies);
      response.headers.set("x-request-id", requestId);
      dependencies.logger!.info(requestEvent(request, requestId, response.status, Date.now() - startedAt));
      return response;
    } catch (error) {
      const safe = normalizeHttpError(error);
      const headers = new Headers(safe.responseHeaders);
      headers.set("x-request-id", requestId);
      if (safe.retryAfterSeconds !== undefined) {
        headers.set("retry-after", String(safe.retryAfterSeconds));
      }
      dependencies.logger!.error({
        ...requestEvent(request, requestId, safe.status, Date.now() - startedAt, safe.code),
        ...safeErrorIdentity(error),
        level: "error"
      });
      return errorResponse(safe.toApiError(), safe.status, headers);
    }
  };
}

const consoleApiLogger: ApiLogger = {
  info: event => console.info(JSON.stringify(event)),
  error: event => console.error(JSON.stringify(event))
};

function safeRequestId(value: string | null): string | null {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function requestEvent(request: Request, requestId: string, status: number, durationMs: number, errorCode?: string): ApiLogEvent {
  const path = new URL(request.url).pathname;
  const identifiers = safeRouteIdentifiers(path);
  return { level: status >= 500 ? "error" : "info", event: "api_request", requestId, method: request.method, path, status, durationMs, ...(errorCode ? { errorCode } : {}), ...identifiers };
}

function safeRouteIdentifiers(path: string): Pick<ApiLogEvent, "sourceId" | "deviceId" | "runId"> {
  const source = /^\/api\/admin\/sources\/([^/]+)/.exec(path)?.[1];
  const device = /^\/api\/admin\/devices\/([^/]+)/.exec(path)?.[1];
  const run = /^\/api\/internal\/runs\/([^/]+)/.exec(path)?.[1];
  return {
    ...(source ? { sourceId: safeRouteId(source) } : {}),
    ...(device ? { deviceId: safeRouteId(device) } : {}),
    ...(run ? { runId: safeRouteId(run) } : {})
  };
}

function safeRouteId(value: string): string {
  try { return decodeURIComponent(value).replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128); }
  catch { return "invalid"; }
}

function safeErrorIdentity(error: unknown): Pick<ApiLogEvent, "errorName" | "causeName" | "causeCode"> {
  if (!error || typeof error !== "object") return {};
  const value = error as { name?: unknown; code?: unknown; cause?: unknown };
  const cause = value.cause && typeof value.cause === "object"
    ? value.cause as { name?: unknown; code?: unknown }
    : null;
  return {
    ...(safeDiagnostic(value.name) ? { errorName: safeDiagnostic(value.name)! } : {}),
    ...(safeDiagnostic(cause?.name) ? { causeName: safeDiagnostic(cause?.name)! } : {}),
    ...(safeDiagnostic(cause?.code) ? { causeCode: safeDiagnostic(cause?.code)! } : {})
  };
}

function safeDiagnostic(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : null;
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
  if (path === "/api/admin/overview") {
    requireMethod(request, "GET");
    return adminOverview(request, dependencies, now);
  }
  if (path === "/api/admin/settings") {
    requireOneMethod(request, ["GET", "PATCH"]);
    return adminSettings(request, dependencies, now);
  }
  if (path === "/api/admin/settings/passphrase") {
    requireMethod(request, "POST");
    return rotatePassphrase(request, dependencies, now);
  }
  if (path === "/api/admin/sources") {
    requireMethod(request, "GET");
    return adminSources(request, dependencies, now);
  }
  const authorizeMatch = /^\/api\/admin\/sources\/(google|onedrive)\/authorize$/.exec(path);
  if (authorizeMatch) {
    requireMethod(request, "POST");
    return oauthAuthorize(request, dependencies, now, authorizeMatch[1] as ProviderKind);
  }
  const callbackMatch = /^\/api\/admin\/oauth\/(google|onedrive)\/callback$/.exec(path);
  if (callbackMatch) {
    requireMethod(request, "GET");
    return oauthCallback(request, dependencies, now, callbackMatch[1] as ProviderKind);
  }
  const sourceImpactMatch = /^\/api\/admin\/sources\/([^/]+)\/impact$/.exec(path);
  if (sourceImpactMatch) {
    requireMethod(request, "GET");
    return sourceImpact(request, dependencies, now, decodeURIComponent(sourceImpactMatch[1]!));
  }
  const sourceTreeMatch = /^\/api\/admin\/sources\/([^/]+)\/tree$/.exec(path);
  if (sourceTreeMatch) {
    requireMethod(request, "GET");
    return sourceTree(request, dependencies, now, decodeURIComponent(sourceTreeMatch[1]!));
  }
  const sourceRootsMatch = /^\/api\/admin\/sources\/([^/]+)\/roots$/.exec(path);
  if (sourceRootsMatch) {
    requireMethod(request, "POST");
    return createRoot(request, dependencies, now, decodeURIComponent(sourceRootsMatch[1]!));
  }
  const sourceMatch = /^\/api\/admin\/sources\/([^/]+)$/.exec(path);
  if (sourceMatch) {
    requireMethod(request, "DELETE");
    return removeSource(request, dependencies, now, decodeURIComponent(sourceMatch[1]!));
  }
  const rootImpactMatch = /^\/api\/admin\/roots\/([^/]+)\/impact$/.exec(path);
  if (rootImpactMatch) {
    requireMethod(request, "GET");
    return rootImpact(request, dependencies, now, decodeURIComponent(rootImpactMatch[1]!));
  }
  const rootMatch = /^\/api\/admin\/roots\/([^/]+)$/.exec(path);
  if (rootMatch) {
    requireMethod(request, "DELETE");
    return removeRoot(request, dependencies, now, decodeURIComponent(rootMatch[1]!));
  }
  if (path === "/api/admin/thumbnail-urls") {
    requireMethod(request, "POST");
    return adminThumbnailUrls(request, dependencies, now);
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
  const source = await dependencies.repository.getSource(sourceId);
  if (!source || source.householdId !== dependencies.config.householdId) {
    throw new HttpError(404, "SOURCE_NOT_FOUND", "Source not found.");
  }
  return ok(await dependencies.indexing.startSource(sourceId, "delta"), {
    headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken)
  });
}

async function adminOverview(request: Request, dependencies: ApiAppDependencies, now: Date) {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  const household = await ensureHousehold(dependencies, now);
  const [requests, devices, sources] = await Promise.all([
    dependencies.repository.listDeviceRequests(dependencies.config.householdId),
    dependencies.repository.listDevices(dependencies.config.householdId),
    dependencies.repository.listSources(dependencies.config.householdId)
  ]);
  const roots = (await Promise.all(sources.map(source => dependencies.repository.listRootsForSource(source.id)))).flat()
    .filter(root => root.householdId === dependencies.config.householdId);
  return ok(encodeAdminOverviewResponse({
    household,
    pendingRequests: requests.filter(value => value.status === "pending").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    devices,
    sources,
    roots
  }), { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) });
}

async function adminSettings(request: Request, dependencies: ApiAppDependencies, now: Date) {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  const household = await ensureHousehold(dependencies, now);
  if (request.method === "GET") {
    return ok(await settingsDto(household, dependencies.repository), { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) });
  }
  verifyAdminMutation(request, authenticated, dependencies.config.allowedOrigin);
  await enforceRateLimit(dependencies, "admin-mutation", authenticated.session.id, now);
  const body = await readJsonObject(request);
  const allowNewDeviceRequests = body.allowNewDeviceRequests ?? household.allowNewDeviceRequests;
  const defaultMediaOrder = body.defaultMediaOrder ?? household.defaultMediaOrder;
  const defaultSlideshowSeconds = body.defaultSlideshowSeconds ?? household.defaultSlideshowSeconds;
  if (
    typeof allowNewDeviceRequests !== "boolean" ||
    !["captured-desc", "captured-asc", "name-asc"].includes(String(defaultMediaOrder)) ||
    typeof defaultSlideshowSeconds !== "number" ||
    !Number.isInteger(defaultSlideshowSeconds) ||
    defaultSlideshowSeconds < 1 ||
    defaultSlideshowSeconds > 3600 ||
    Object.keys(body).some(key => !["allowNewDeviceRequests", "defaultMediaOrder", "defaultSlideshowSeconds"].includes(key))
  ) throw new HttpError(400, "INVALID_SETTINGS", "Settings are invalid.");
  const updated = await dependencies.repository.updateHouseholdSettings({
    householdId: dependencies.config.householdId,
    allowNewDeviceRequests,
    defaultMediaOrder: defaultMediaOrder as Household["defaultMediaOrder"],
    defaultSlideshowSeconds
  });
  return ok(await settingsDto(updated, dependencies.repository), { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) });
}

async function rotatePassphrase(request: Request, dependencies: ApiAppDependencies, now: Date) {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  const household = await ensureHousehold(dependencies, now);
  verifyAdminMutation(request, authenticated, dependencies.config.allowedOrigin);
  await enforceRateLimit(dependencies, "admin-mutation", authenticated.session.id, now);
  const body = await readJsonObject(request);
  if (typeof body.currentPassphrase !== "string" || typeof body.newPassphrase !== "string" || body.currentPassphrase.length < 16 || body.currentPassphrase.length > 1024 || body.newPassphrase.length < 16 || body.newPassphrase.length > 1024) {
    throw new HttpError(400, "INVALID_PASSPHRASE", "The passphrase is invalid.");
  }
  if (!(await verifyPassphrase(household.adminPassphraseHash, body.currentPassphrase, dependencies.config.passphrasePepper))) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "The current passphrase is incorrect.");
  }
  const adminPassphraseHash = await hashPassphrase(body.newPassphrase, dependencies.config.passphrasePepper);
  await dependencies.repository.rotateAdminPassphrase({ householdId: dependencies.config.householdId, adminPassphraseHash, revokedAt: now });
  const headers = withCsrf(authenticated.responseHeaders, authenticated.csrfToken);
  headers.append("set-cookie", clearSessionCookie("admin"));
  return ok({ authenticated: false }, { headers });
}

async function adminSources(request: Request, dependencies: ApiAppDependencies, now: Date) {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  const sources = await dependencies.repository.listSources(dependencies.config.householdId);
  const values = await Promise.all(sources.map(async source => ({
    ...encodeSourceDto(source),
    roots: (await dependencies.repository.listRootsForSource(source.id))
      .filter(root => root.householdId === dependencies.config.householdId)
      .map(encodeAssignedRootDto)
  })));
  return ok({ sources: values }, { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) });
}

async function oauthAuthorize(request: Request, dependencies: ApiAppDependencies, now: Date, provider: ProviderKind) {
  if (!dependencies.oauth) throw unavailableService();
  const authenticated = await authenticateAdmin(request, dependencies, now);
  verifyAdminMutation(request, authenticated, dependencies.config.allowedOrigin);
  await enforceRateLimit(dependencies, "admin-mutation", authenticated.session.id, now);
  const body = await readJsonObject(request);
  if (body.reconnectSourceId !== undefined && typeof body.reconnectSourceId !== "string") {
    throw new HttpError(400, "INVALID_SOURCE", "Source request is invalid.");
  }
  const result = await dependencies.oauth.beginAuthorization({
    householdId: dependencies.config.householdId,
    adminSessionId: authenticated.session.id,
    provider,
    redirectUri: `${dependencies.config.allowedOrigin}/api/admin/oauth/${provider}/callback`,
    ...(body.reconnectSourceId ? { reconnectSourceId: body.reconnectSourceId } : {})
  });
  return ok(result, { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) });
}

async function oauthCallback(request: Request, dependencies: ApiAppDependencies, now: Date, provider: ProviderKind) {
  if (!dependencies.oauth) throw unavailableService();
  const authenticated = await authenticateAdmin(request, dependencies, now);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state || state.length > 1024) return oauthRedirect("invalid", authenticated.responseHeaders);
  try {
    await dependencies.oauth.completeAuthorization({
      householdId: dependencies.config.householdId,
      adminSessionId: authenticated.session.id,
      provider,
      redirectUri: `${dependencies.config.allowedOrigin}/api/admin/oauth/${provider}/callback`,
      state,
      ...(url.searchParams.get("code") ? { code: url.searchParams.get("code")! } : {}),
      ...(url.searchParams.get("error") ? { providerError: url.searchParams.get("error")! } : {})
    });
    return oauthRedirect("connected", authenticated.responseHeaders);
  } catch (error) {
    if (error instanceof OAuthServiceError || error instanceof ProviderError) {
      return oauthRedirect(error instanceof OAuthServiceError && error.code === "OAUTH_CANCELLED" ? "cancelled" : "failed", authenticated.responseHeaders);
    }
    throw error;
  }
}

function oauthRedirect(status: "connected" | "failed" | "invalid" | "cancelled", authenticationHeaders?: HeadersInit) {
  const headers = new Headers(authenticationHeaders);
  headers.set("location", `/admin?section=sources&oauth=${status}`);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  return new Response(null, { status: 303, headers });
}

async function sourceImpact(request: Request, dependencies: ApiAppDependencies, now: Date, sourceId: string) {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  const impact = await dependencies.repository.getSourceImpact(dependencies.config.householdId, sourceId);
  return ok({ roots: impact.roots.map(encodeAssignedRootDto), devices: impact.devices.map(encodeDeviceDto) }, { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) });
}

async function removeSource(request: Request, dependencies: ApiAppDependencies, now: Date, sourceId: string) {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  verifyAdminMutation(request, authenticated, dependencies.config.allowedOrigin);
  await enforceRateLimit(dependencies, "admin-mutation", authenticated.session.id, now);
  const body = await readJsonObject(request);
  if (body.confirm !== true) throw new HttpError(400, "CONFIRMATION_REQUIRED", "Confirmation is required.");
  const impact = await dependencies.repository.removeSource({ householdId: dependencies.config.householdId, sourceId });
  return ok({ removed: true, roots: impact.roots.map(encodeAssignedRootDto), devices: impact.devices.map(encodeDeviceDto) }, { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) });
}

async function sourceTree(request: Request, dependencies: ApiAppDependencies, now: Date, sourceId: string) {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  const source = await dependencies.repository.getSource(sourceId);
  if (!source || source.householdId !== dependencies.config.householdId || source.status === "disabled") throw new HttpError(404, "SOURCE_NOT_FOUND", "Source not found.");
  const parentNodeId = new URL(request.url).searchParams.get("parentNodeId");
  let parent: MediaNode | null = null;
  let children: MediaNode[];
  if (parentNodeId) {
    parent = await dependencies.repository.getNode(parentNodeId);
    if (!parent || !parent.available || parent.householdId !== dependencies.config.householdId || parent.sourceId !== sourceId || parent.kind !== "folder") throw new HttpError(404, "FOLDER_NOT_FOUND", "Folder not found.");
    children = await dependencies.repository.listChildNodes(parent.id, [sourceId]);
  } else {
    children = (await dependencies.repository.listNodesForSource(sourceId)).filter(node => node.parentNodeId === null);
  }
  const roots = (await dependencies.repository.listRootsForSource(sourceId))
    .filter(root => root.householdId === dependencies.config.householdId && root.enabled);
  const rootByProviderNodeId = new Map(roots.map(root => [root.providerNodeId, root.id]));
  return ok({ source: encodeSourceDto(source), parent: parent ? encodeMediaNodeDto(parent) : null, folders: children.filter(node => node.available && node.kind === "folder" && node.householdId === dependencies.config.householdId).map(node => ({ ...encodeMediaNodeDto(node), assignedRootId: rootByProviderNodeId.get(node.providerNodeId) ?? null })) }, { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) });
}

async function createRoot(request: Request, dependencies: ApiAppDependencies, now: Date, sourceId: string) {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  verifyAdminMutation(request, authenticated, dependencies.config.allowedOrigin);
  await enforceRateLimit(dependencies, "admin-mutation", authenticated.session.id, now);
  const body = await readJsonObject(request);
  if (typeof body.nodeId !== "string" || (body.displayName !== undefined && typeof body.displayName !== "string")) throw new HttpError(400, "INVALID_ROOT", "Root request is invalid.");
  const [source, node] = await Promise.all([dependencies.repository.getSource(sourceId), dependencies.repository.getNode(body.nodeId)]);
  if (!source || source.householdId !== dependencies.config.householdId || !node || !node.available || node.kind !== "folder" || node.householdId !== dependencies.config.householdId || node.sourceId !== sourceId) throw new HttpError(404, "FOLDER_NOT_FOUND", "Folder not found.");
  const ancestryProviderIds = await providerAncestry(dependencies.repository, node);
  const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim().slice(0, 120) : node.name;
  const root: AssignedRoot = { id: dependencies.createId!("root"), householdId: dependencies.config.householdId, sourceId, providerNodeId: node.providerNodeId, displayName, ancestryProviderIds, enabled: true, createdAt: now };
  const saved = await dependencies.repository.createOrEnableRoot(root);
  return ok({ root: encodeAssignedRootDto(saved) }, { status: 201, headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) });
}

async function removeRoot(request: Request, dependencies: ApiAppDependencies, now: Date, rootId: string) {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  verifyAdminMutation(request, authenticated, dependencies.config.allowedOrigin);
  await enforceRateLimit(dependencies, "admin-mutation", authenticated.session.id, now);
  const body = await readJsonObject(request);
  if (body.confirm !== true) throw new HttpError(400, "CONFIRMATION_REQUIRED", "Confirmation is required.");
  const impact = await dependencies.repository.disableRoot({ householdId: dependencies.config.householdId, rootId });
  return ok({ removed: true, roots: impact.roots.map(encodeAssignedRootDto), devices: impact.devices.map(encodeDeviceDto) }, { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) });
}

async function rootImpact(request: Request, dependencies: ApiAppDependencies, now: Date, rootId: string) {
  const authenticated = await authenticateAdmin(request, dependencies, now);
  const root = await dependencies.repository.getRoot(rootId);
  if (!root || root.householdId !== dependencies.config.householdId) throw new HttpError(404, "ROOT_NOT_FOUND", "Root not found.");
  const devices = (await dependencies.repository.listDevices(dependencies.config.householdId)).filter(device => device.assignedRootIds.includes(root.id));
  return ok({ roots: [encodeAssignedRootDto(root)], devices: devices.map(encodeDeviceDto) }, { headers: withCsrf(authenticated.responseHeaders, authenticated.csrfToken) });
}

async function adminThumbnailUrls(request: Request, dependencies: ApiAppDependencies, now: Date) {
  if (!dependencies.mediaUrls) throw unavailableService();
  const authenticated = await authenticateAdmin(request, dependencies, now);
  verifyAdminMutation(request, authenticated, dependencies.config.allowedOrigin);
  await enforceRateLimit(dependencies, "url-vending", authenticated.session.id, now);
  const body = await readJsonObject(request);
  if (!Array.isArray(body.nodeIds) || !body.nodeIds.every(value => typeof value === "string") || typeof (body.maxDimension ?? 720) !== "number") throw new HttpError(400, "INVALID_THUMBNAIL_REQUEST", "Thumbnail request is invalid.");
  const maxDimension = typeof body.maxDimension === "number" ? body.maxDimension : 720;
  const result = await dependencies.mediaUrls.adminThumbnails(dependencies.config.householdId, body.nodeIds as string[], maxDimension);
  return ok({ items: serializeTemporaryItems(result.items) }, { headers: mergeHeaders(withCsrf(authenticated.responseHeaders, authenticated.csrfToken), result.responseHeaders) });
}

async function settingsDto(household: Household, repository: AppRepository) {
  const [sources, devices, requests, nodeCounts] = await Promise.all([repository.listSources(household.id), repository.listDevices(household.id), repository.listDeviceRequests(household.id), repository.countNodesForHousehold(household.id)]);
  const rootsBySource = await Promise.all(sources.map(source => repository.listRootsForSource(source.id)));
  const roots = rootsBySource.flat().filter(root => root.householdId === household.id);
  return {
    allowNewDeviceRequests: household.allowNewDeviceRequests,
    defaultMediaOrder: household.defaultMediaOrder,
    defaultSlideshowSeconds: household.defaultSlideshowSeconds,
    indexHealth: { totalNodeCount: nodeCounts.total, availableNodeCount: nodeCounts.available, indexingSourceCount: sources.filter(source => source.status === "syncing" || source.crawlCheckpoint !== null).length, estimatedFirestoreDocumentCount: 1 + sources.length + roots.length + devices.length + requests.length + nodeCounts.total }
  };
}

async function providerAncestry(repository: AppRepository, node: MediaNode): Promise<string[]> {
  const reversed: string[] = [];
  let parentId = node.parentNodeId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId) && seen.size < 256) {
    seen.add(parentId);
    const parent = await repository.getNode(parentId);
    if (!parent || !parent.available || parent.sourceId !== node.sourceId || parent.householdId !== node.householdId) throw new HttpError(409, "ROOT_ANCESTRY_INVALID", "Folder ancestry is invalid.");
    reversed.push(parent.providerNodeId);
    parentId = parent.parentNodeId;
  }
  return reversed.reverse();
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
  if (error instanceof OAuthServiceError) {
    const status = error.code === "SOURCE_NOT_FOUND"
      ? 404
      : error.code === "OAUTH_ACCOUNT_MISMATCH"
        ? 409
        : error.code === "OAUTH_STATE_INVALID"
          ? 400
          : 502;
    return new HttpError(status, error.code, error.message);
  }
  if (error instanceof ProviderError) {
    return new HttpError(
      error.code === "PROVIDER_REAUTH_REQUIRED" ? 409 : 502,
      error.code,
      "The cloud provider request failed.",
      error.retryAfterSeconds ?? undefined
    );
  }
  if (error instanceof RepositoryError) {
    if (error.code === "SOURCE_NOT_FOUND") return new HttpError(404, error.code, "Source not found.");
    if (error.code === "ROOT_NOT_FOUND") return new HttpError(404, error.code, "Root not found.");
    if (error.code === "ROOT_CONFLICT") return new HttpError(409, error.code, "Root already exists.");
  }
  return new HttpError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
}
