import { readFile, stat } from "node:fs/promises";
import { ProviderError, type ProviderAdapter, type ProviderCredentials, type ProviderNode } from "@cloudframe/providers";
import type { ControlPlaneDocumentV2 } from "@cloudframe/shared";
import { createSessionCookie } from "../auth/cookies.ts";
import type { BrowseHandleCodec } from "../auth/browse-handles.ts";
import { encryptProviderToken, type ProviderTokenKeyring } from "../crypto/provider-tokens.ts";
import { HttpError } from "../http/errors.ts";
import { loadControlRequestContext, type ControlRequestContextScope } from "../http/request-context.ts";
import { errorResponse, ok } from "../http/response.ts";
import type { ControlPlaneStore } from "../control-plane/store.ts";
import type { ControlAuth } from "../services/control-auth.ts";
import type { SealedSessionCodec } from "../auth/sealed-sessions.ts";

const SOURCE_ID = "source-container-smoke";
const ROOT_ID = "root-container-smoke";
const DEVICE_ID = "device-smoke";
const ROOT_PROVIDER_ID = "fixture-root";
const ITEM_PROVIDER_ID = "fixture-legacy-mpeg";
const ITEM_NAME = "legacy-mpeg.mpg";
const REVISION = "fixture-revision-1";
const ACCESS_TOKEN = "cloudframe-container-fixture-token";
const MEDIA_URL = `https://www.googleapis.com/drive/v3/files/${ITEM_PROVIDER_ID}?alt=media&supportsAllDrives=true`;

export async function createContainerTestFixture(options: {
  fixturePath: string;
  providerTokenKeyring: ProviderTokenKeyring;
  fallbackFetch: typeof globalThis.fetch;
  now: () => Date;
}) {
  const metadata = await stat(options.fixturePath);
  if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size <= 0) throw new Error("CONTAINER_TEST_FIXTURE_INVALID");
  const size = metadata.size;
  const node = fixtureNode(size);
  const adapter: ProviderAdapter = {
    beginAuthorization: async () => { throw new Error("CONTAINER_TEST_ONLY"); },
    completeAuthorization: async () => { throw new Error("CONTAINER_TEST_ONLY"); },
    refreshCredentials: async () => credentials(options.now()),
    getRoot: async () => ({ ...node, providerNodeId: ROOT_PROVIDER_ID, parentProviderId: null, name: "Smoke fixtures", kind: "folder", mimeType: null, size: null, contentRevision: null }),
    getNode: async input => input.providerNodeId === ITEM_PROVIDER_ID ? node : (() => { throw new Error("FIXTURE_NOT_FOUND"); })(),
    listFolder: async input => ({ items: input.folderId === ROOT_PROVIDER_ID ? [node] : [], nextCursor: null }),
    getThumbnailUrl: async () => null,
    getMediaUrl: async input => {
      if (input.providerNodeId !== ITEM_PROVIDER_ID) throw new ProviderError("PROVIDER_NOT_FOUND", "Fixture node was not found.", { retryable: false });
      if (input.credentials.accessToken !== ACCESS_TOKEN) throw new ProviderError("PROVIDER_REAUTH_REQUIRED", "Fixture credentials were not accepted.", { retryable: false });
      return { url: MEDIA_URL, headers: { authorization: `Bearer ${ACCESS_TOKEN}` }, expiresAt: new Date(options.now().getTime() + 60 * 60_000) };
    },
  };
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== MEDIA_URL) return options.fallbackFetch(input, init);
    if (request.headers.get("authorization") !== `Bearer ${ACCESS_TOKEN}`) return withUrl(new Response(null, { status: 401 }), MEDIA_URL);
    if (request.method !== "GET" && request.method !== "HEAD") return withUrl(new Response(null, { status: 405, headers: { allow: "GET, HEAD" } }), MEDIA_URL);
    const bytes = await readFile(options.fixturePath);
    const range = request.headers.get("range");
    const interval = range === null ? { start: 0, end: bytes.length - 1 } : parseRange(range, bytes.length);
    if (!interval) return withUrl(new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } }), MEDIA_URL);
    const body = request.method === "HEAD" ? null : bytes.subarray(interval.start, interval.end + 1);
    const partial = range !== null;
    return withUrl(new Response(body, { status: partial ? 206 : 200, headers: {
      "accept-ranges": "bytes", "content-length": String(interval.end - interval.start + 1), "content-type": "video/mpeg", etag: '"fixture-revision-1"',
      ...(partial ? { "content-range": `bytes ${interval.start}-${interval.end}/${bytes.length}` } : {}),
    } }), MEDIA_URL);
  };

  return { adapter, fetcher, size };
}

export function createContainerTestFixtureHandler(options: {
  controlStore: ControlPlaneStore;
  requestContext: ControlRequestContextScope;
  auth: ControlAuth;
  sessionCodec: SealedSessionCodec;
  handles: BrowseHandleCodec;
  providerTokenKeyring: ProviderTokenKeyring;
  allowedOrigin: string;
  size: number;
  now: () => Date;
}) {
  return async (request: Request): Promise<Response | null> => {
    if (new URL(request.url).pathname !== "/api/admin/test-fixture") return null;
    try {
      if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "The request method is not allowed.", undefined, { allow: "POST" });
      if (request.headers.get("origin") !== options.allowedOrigin) throw new HttpError(403, "ORIGIN_INVALID", "This request was blocked.");
      const context = await options.requestContext.runRequest(() => loadControlRequestContext(options.controlStore, options.requestContext));
      const admin = await options.auth.admin(request, context, options.now());
      if (request.headers.get("x-csrf-token") !== admin.csrfToken) throw new HttpError(403, "CSRF_INVALID", "The request token was not accepted.", undefined, { "x-csrf-token": admin.csrfToken });
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body) || Reflect.ownKeys(body).length !== 1 || (body as { fixture?: unknown }).fixture !== "legacy-mpeg") throw new HttpError(400, "INVALID_REQUEST", "The fixture request is invalid.");
      const installed = await options.controlStore.mutate("install-container-test-fixture", current => installFixture(current, options));
      const issuedAt = options.now().getTime();
      const expiresAt = issuedAt + 30 * 60_000;
      const deviceToken = options.sessionCodec.issueDevice({ version: 2, householdId: currentHousehold(installed), deviceId: DEVICE_ID, sessionVersion: 1, issuedAt, expiresAt });
      const handle = options.handles.sealItem({ version: 2, householdId: currentHousehold(installed), deviceId: DEVICE_ID, sourceId: SOURCE_ID, rootId: ROOT_ID, rootProviderNodeId: ROOT_PROVIDER_ID, providerNodeId: ITEM_PROVIDER_ID, parentProviderNodeId: ROOT_PROVIDER_ID, kind: "video", name: ITEM_NAME, mimeType: "video/mpeg", size: options.size, contentRevision: REVISION, preview: null, credentialVersion: 1, issuedAt, expiresAt });
      const headers = new Headers({ "x-csrf-token": admin.csrfToken });
      headers.append("set-cookie", createSessionCookie("device", deviceToken, new Date(expiresAt)));
      return ok({ deviceCookie: deviceToken, handle }, { headers });
    } catch (error) {
      const mapped = error instanceof HttpError ? error : new HttpError(error instanceof Error && "code" in error ? 401 : 500, error instanceof Error && "code" in error ? "ADMIN_UNAUTHORIZED" : "INTERNAL_ERROR", error instanceof Error && "code" in error ? "Administrator authentication is required." : "The fixture could not be installed.");
      return errorResponse(mapped.toApiError(), mapped.status, mapped.responseHeaders);
    }
  };
}

function installFixture(current: ControlPlaneDocumentV2, options: { providerTokenKeyring: ProviderTokenKeyring; size: number; now: () => Date }) {
  const at = options.now().toISOString();
  const next: ControlPlaneDocumentV2 = structuredClone(current);
  next.revision = current.revision + 1;
  next.sources[SOURCE_ID] = { id: SOURCE_ID, provider: "google", providerAccountId: "container-smoke", providerRootId: ROOT_PROVIDER_ID, accountLabel: "Container smoke fixture", encryptedRefreshToken: encryptProviderToken("fixture-refresh-token", options.providerTokenKeyring), encryptedBootstrapAccessToken: encryptProviderToken(ACCESS_TOKEN, options.providerTokenKeyring), bootstrapAccessTokenExpiresAt: new Date(options.now().getTime() + 24 * 60 * 60_000).toISOString(), credentialVersion: 1, status: "healthy", createdAt: at };
  next.roots[ROOT_ID] = { id: ROOT_ID, sourceId: SOURCE_ID, providerNodeId: ROOT_PROVIDER_ID, displayName: "Container smoke fixtures", ancestryProviderIds: [], enabled: true, createdAt: at };
  next.devices[DEVICE_ID] = { id: DEVICE_ID, name: "Smoke TV", enabled: true, assignedRootIds: [ROOT_ID], mediaOrder: null, slideshowSeconds: null, sessionVersion: 1, createdAt: at, approvedAt: at, revokedAt: null };
  return { changed: true, next, result: { householdId: current.householdId } };
}

function currentHousehold(value: { householdId: string }) { return value.householdId; }
function credentials(now: Date): ProviderCredentials { return { accessToken: ACCESS_TOKEN, refreshToken: "fixture-refresh-token", accessTokenExpiresAt: new Date(now.getTime() + 60 * 60_000) }; }
function fixtureNode(size: number): ProviderNode { return { providerNodeId: ITEM_PROVIDER_ID, parentProviderId: ROOT_PROVIDER_ID, name: ITEM_NAME, kind: "video", mimeType: "video/mpeg", size, width: 640, height: 360, capturedAt: null, createdAt: new Date("2026-01-01T00:00:00.000Z"), modifiedAt: new Date("2026-01-01T00:00:00.000Z"), thumbnailRevision: null, contentRevision: REVISION, hasPreview: false }; }
function parseRange(value: string, size: number) { const match = /^bytes=(\d+)-(\d*)$/u.exec(value); if (!match) return null; const start = Number(match[1]); const requestedEnd = match[2] ? Number(match[2]) : size - 1; if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return null; return { start, end: Math.min(requestedEnd, size - 1) }; }
function withUrl(response: Response, url: string) { Object.defineProperty(response, "url", { configurable: true, value: url }); return response; }
