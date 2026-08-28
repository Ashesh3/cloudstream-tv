import type {
  ControlPlaneDocumentV2
} from "@cloudframe/shared";
import type {
  ProviderAdapter,
  ProviderNode,
  ProviderRegistry
} from "@cloudframe/providers";
import {
  createBrowseHandleCodec,
  createControlAdminService,
  createControlApiApp,
  createControlAuth,
  createControlEnrollmentService,
  createControlOAuthService,
  createControlPlaneStore,
  createControlRequestContextScope,
  createCredentialBroker,
  createDirectMediaService,
  createFirestoreRecoveryMirror,
  createLiveBrowseService,
  createLiveProviderFolderService,
  createSealedSessionCodec,
  encryptControlPlaneDocument,
  encryptProviderToken,
  hashOpaqueToken,
  hashPassphrase,
  type ControlApiLogger,
  type ControlApiLoggerEvent,
  type LegacySessionExchange,
  type ControlPlaneTelemetryObserver,
  type ControlMutationReducer,
  type ControlPlaneStore,
  MemoryControlDurableStore,
  MemoryControlHotCache,
  MemoryDeferredTasks,
} from "@cloudframe/server";

import {
  TEST_NOW,
  testAeadKeyring,
  testControlDocument
} from "./control-plane";

const DEFAULT_ORIGIN = "https://dev.cloudframe.example";

export interface ControlApiHarness {
  app: ReturnType<typeof createControlApiApp>;
  origin: string;
  now: Date;
  document: ControlPlaneDocumentV2;
  adminCookie: string;
  adminCsrf: string;
  deviceCookie: string;
  requestCookie: string;
  replaceDocument(document: ControlPlaneDocumentV2): void;
  issueDeviceCookie(input: { deviceId: string; householdId?: string; sessionVersion?: number; expiresAt?: number }): string;
  controlStore: { loadCount: number; mutateCount: number };
  durable: {
    readCount: number;
    conditionalReadCount: number;
    writeAttempts: number;
  };
  cache: { readCount: number };
  deferred: { flush(): Promise<void> };
  firestore: { readCount: number; writeCount: number };
  provider: {
    listFolderCalls: number;
    mediaUrlCalls: number;
    thumbnailUrlCalls: number;
  };
  rateLimiter: { consumeCount: number };
  events: ControlApiLoggerEvent[];
  adminHeaders(extra?: HeadersInit): HeadersInit;
  adminMutationHeaders(extra?: HeadersInit): HeadersInit;
  deviceHeaders(extra?: HeadersInit): HeadersInit;
  folderRequest(): Request;
  mediaRequest(): Request;
  oauthCallbackRequest(provider: "google" | "onedrive"): Promise<{
    path: string;
    oauthCookie: string;
  }>;
  failNextControlLoad(): void;
  failOAuthComplete(error: unknown): void;
}

export interface ControlApiHarnessOptions {
  legacySessionExchange?: LegacySessionExchange;
  telemetryObserver?: ControlPlaneTelemetryObserver;
}

export async function createControlApiHarness(
  options: ControlApiHarnessOptions = {}
): Promise<ControlApiHarness> {
  const origin = DEFAULT_ORIGIN;
  const now = new Date(TEST_NOW);
  const document = testControlDocument();
  document.household.adminPassphraseHash = await hashPassphrase(
    "correct horse battery staple",
    "test-passphrase-pepper"
  );
  document.pendingDeviceRequests["request-1"]!.requestSecretHash = hashOpaqueToken(
    "request-secret"
  );
  const providerTokenKeyring = {
    currentVersion: "provider-v1",
    keys: { "provider-v1": Buffer.alloc(32, 9) }
  };
  document.sources["source-1"]!.encryptedRefreshToken = encryptProviderToken(
    "refresh-token",
    providerTokenKeyring
  );
  document.sources["source-1"]!.encryptedBootstrapAccessToken =
    encryptProviderToken("access-token", providerTokenKeyring);
  document.sources["source-1"]!.bootstrapAccessTokenExpiresAt = new Date(
    now.getTime() + 60 * 60_000
  ).toISOString();
  const controlKeyring = testAeadKeyring();
  const initial = {
    envelope: encryptControlPlaneDocument(document, controlKeyring),
    etag: "etag-1"
  };
  const durable = new MemoryControlDurableStore(
    initial,
    0,
    controlKeyring.keys
  );
  const cache = new MemoryControlHotCache();
  cache.replaceOutOfBand(initial);
  const deferred = new MemoryDeferredTasks();
  const firestore = new FirestoreSentinel(document.householdId);
  const mirror = createFirestoreRecoveryMirror(
    firestore.client,
    document.householdId
  );
  const rawStore = createControlPlaneStore({
    durable,
    cache,
    mirror,
    deferred,
    keyring: controlKeyring,
    now: () => new Date(now),
    householdId: document.householdId
  });
  let loadCount = 0;
  let mutateCount = 0;
  let failNextLoad = false;
  const store: ControlPlaneStore = {
    async load() {
      loadCount += 1;
      if (failNextLoad) {
        failNextLoad = false;
        throw new Error("injected control load failure");
      }
      return rawStore.load();
    },
    async mutate<T>(name: string, reducer: ControlMutationReducer<T>) {
      mutateCount += 1;
      return rawStore.mutate(name, reducer);
    },
    async withTelemetry<T>(observer: ControlPlaneTelemetryObserver | undefined, requestId: string, operation: () => Promise<T>) {
      return rawStore.withTelemetry!(observer, requestId, operation);
    }
  };

  let cacheReadCount = 0;
  const originalCacheGet = cache.get.bind(cache);
  cache.get = async () => {
    cacheReadCount += 1;
    return originalCacheGet();
  };

  const provider = new ControlProviderHarness(now);
  const providers: ProviderRegistry = {
    get: (kind) => ({
      ...provider.adapter,
      beginAuthorization: async ({ state }) => ({
        authorizationUrl: `${kind === "onedrive" ? "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" : "https://accounts.google.com/o/oauth2/v2/auth"}?state=${encodeURIComponent(state)}`
      })
    })
  };
  const sessionCodec = createSealedSessionCodec(testAeadKeyring(), () => now);
  const browseCodec = createBrowseHandleCodec(
    testAeadKeyring(),
    "test-browse-id-secret",
    () => now
  );
  const activeContext = () => {
    const active = durable.currentDocument!;
    return { document: active, revision: active.revision };
  };
  const requestContext = createControlRequestContextScope();
  const credentialCache = new MemoryRuntimeCache();
  const broker = createCredentialBroker({
    controlStore: store,
    controlState: () => requestContext.current(),
    providers,
    providerTokenKeyring,
    cache: credentialCache,
    now: () => new Date(now)
  });
  const admin = createControlAdminService({
    store,
    cache,
    passphrasePepper: "test-passphrase-pepper",
    now: () => new Date(now),
    createId: () => "device-created"
  });
  const auth = createControlAuth({
    store,
    codec: sessionCodec,
    householdId: document.householdId,
    passphrasePepper: "test-passphrase-pepper",
    csrfSecret: "test-csrf-secret-that-is-long-enough",
    failedLoginDelayMs: 1,
    createId: () => "admin-session-1",
    monotonicNow: () => 0,
    wait: async () => undefined
  });
  const enrollment = createControlEnrollmentService({
    store,
    codec: sessionCodec,
    admin,
    householdId: document.householdId,
    createId: () => "device-request-created",
    issueRequestSecret: () => ({
      raw: "created-request-secret",
      hash: hashOpaqueToken("created-request-secret")
    })
  });
  const realOAuth = createControlOAuthService({
    store,
    codec: sessionCodec,
    providers,
    keyring: providerTokenKeyring,
    redirectUris: {
      google: `${origin}/api/admin/sources/google/callback`,
      onedrive: `${origin}/api/admin/sources/onedrive/callback`
    },
    runtimeCache: new MemoryRuntimeCache(),
    now: () => new Date(now),
    createId: () => "source-created",
    randomBytes: (size) => Buffer.alloc(size, 8)
  });
  let oauthCompleteFailure: unknown;
  const oauth = {
    beginAuthorization: realOAuth.beginAuthorization,
    async completeAuthorization(
      input: Parameters<typeof realOAuth.completeAuthorization>[0]
    ) {
      if (oauthCompleteFailure !== undefined) throw oauthCompleteFailure;
      return realOAuth.completeAuthorization(input);
    }
  };
  const providerFolders = createLiveProviderFolderService({
    controlStore: store,
    controlState: () => requestContext.current(),
    credentialBroker: broker,
    providers,
    rootIdSecret: "test-root-id-secret-that-is-long-enough",
    now: () => new Date(now)
  });
  const browse = createLiveBrowseService({
    handles: browseCodec,
    credentialBroker: broker,
    providers,
    now: () => new Date(now)
  });
  const directMedia = createDirectMediaService({
    browse,
    credentialBroker: broker,
    providers,
    now: () => new Date(now)
  });
  const events: ControlApiLoggerEvent[] = [];
  const logger: ControlApiLogger = {
    info: (event) => events.push(event),
    error: (event) => events.push(event)
  };
  let rateLimitConsumeCount = 0;
  const rateLimiter = {
    async consume() {
      rateLimitConsumeCount += 1;
      return { allowed: true, remaining: 1, retryAfterSeconds: 1 };
    }
  };
  const app = createControlApiApp({
    controlStore: store,
    requestContext,
    auth,
    admin,
    enrollment,
    oauth,
    providerFolders,
    browse,
    directMedia,
    rateLimiter,
    ...(options.legacySessionExchange
      ? { legacySessionExchange: options.legacySessionExchange }
      : {}),
    config: { householdId: document.householdId, allowedOrigin: origin },
    now: () => new Date(now),
    requestSubject: () => "203.0.113.7",
    logger,
    telemetryObserver: options.telemetryObserver
  });

  const adminCookie = sessionCodec.issueAdmin({
    version: 2,
    householdId: document.householdId,
    sessionId: "admin-session-1",
    adminPassphraseVersion: 1,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 60 * 60_000
  });
  const deviceCookie = sessionCodec.issueDevice({
    version: 2,
    householdId: document.householdId,
    deviceId: "device-1",
    sessionVersion: 1,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 60 * 60_000
  });
  const requestCookie = sessionCodec.issueRequest({
    version: 2,
    householdId: document.householdId,
    requestId: "request-1",
    requestSecret: "request-secret",
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 30 * 60_000
  });
  const rootHandle = browseCodec.sealItem({
    version: 2,
    householdId: document.householdId,
    deviceId: "device-1",
    sourceId: "source-1",
    rootId: "root-1",
    rootProviderNodeId: "provider-trips",
    providerNodeId: "provider-trips",
    parentProviderNodeId: null,
    kind: "folder",
    name: "Trips",
    mimeType: null,
    credentialVersion: 1,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 30 * 60_000
  });
  const mediaHandle = browseCodec.sealItem({
    version: 2,
    householdId: document.householdId,
    deviceId: "device-1",
    sourceId: "source-1",
    rootId: "root-1",
    rootProviderNodeId: "provider-trips",
    providerNodeId: "video-1",
    parentProviderNodeId: "provider-trips",
    kind: "video",
    name: "Video.mp4",
    mimeType: "video/mp4",
    credentialVersion: 1,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 30 * 60_000
  });
  const adminCsrf = (
    await auth.admin(
      jsonRequest("/", "GET", undefined, {
        cookie: cookieHeader(["admin_session", adminCookie])
      }),
      activeContext(),
      now
    )
  ).csrfToken;

  const mergeHeaders = (base: HeadersInit, extra: HeadersInit = {}) => {
    const headers = new Headers(base);
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return headers;
  };

  return {
    app,
    origin,
    now,
    document,
    adminCookie,
    adminCsrf,
    deviceCookie,
    requestCookie,
    replaceDocument(nextDocument) {
      durable.replaceOutOfBand(nextDocument, controlKeyring);
      cache.replaceOutOfBand({ envelope: encryptControlPlaneDocument(nextDocument, controlKeyring), etag: durable.currentEtag! });
    },
    issueDeviceCookie(input) {
      return sessionCodec.issueDevice({
        version: 2,
        householdId: input.householdId ?? document.householdId,
        deviceId: input.deviceId,
        sessionVersion: input.sessionVersion ?? 1,
        issuedAt: now.getTime(),
        expiresAt: input.expiresAt ?? now.getTime() + 60 * 60_000
      });
    },
    controlStore: {
      get loadCount() {
        return loadCount;
      },
      get mutateCount() {
        return mutateCount;
      }
    },
    durable: {
      get readCount() {
        return durable.readCount;
      },
      get conditionalReadCount() {
        return durable.ifNoneMatches.filter(
          (value: string | undefined) => value !== undefined
        ).length;
      },
      get writeAttempts() {
        return durable.writeAttempts;
      }
    },
    cache: {
      get readCount() {
        return cacheReadCount;
      }
    },
    deferred,
    firestore,
    provider,
    rateLimiter: {
      get consumeCount() {
        return rateLimitConsumeCount;
      }
    },
    events,
    adminHeaders(extra = {}) {
      return mergeHeaders(
        { cookie: cookieHeader(["admin_session", adminCookie]) },
        extra
      );
    },
    adminMutationHeaders(extra = {}) {
      return mergeHeaders(
        {
          cookie: cookieHeader(["admin_session", adminCookie]),
          origin,
          "x-csrf-token": adminCsrf
        },
        extra
      );
    },
    deviceHeaders(extra = {}) {
      return mergeHeaders(
        { cookie: cookieHeader(["device_session", deviceCookie]) },
        extra
      );
    },
    folderRequest() {
      return jsonRequest(
        `/api/tv/folders/${encodeURIComponent(rootHandle)}`,
        "GET",
        undefined,
        { cookie: cookieHeader(["device_session", deviceCookie]) }
      );
    },
    mediaRequest() {
      return jsonRequest(
        "/api/tv/media-url",
        "POST",
        { handle: mediaHandle },
        { cookie: cookieHeader(["device_session", deviceCookie]) }
      );
    },
    async oauthCallbackRequest(providerKind) {
      const response = await app(
        jsonRequest(
          `/api/admin/sources/${providerKind}/authorize`,
          "POST",
          {},
          {
            cookie: cookieHeader(["admin_session", adminCookie]),
            origin,
            "x-csrf-token": adminCsrf
          }
        )
      );
      const payload = (await response.json()) as {
        ok: true;
        data: { authorizationUrl: string };
      };
      if (!payload.data?.authorizationUrl) {
        throw new Error(`OAuth authorize failed: ${response.status} ${JSON.stringify(payload)}`);
      }
      const oauthCookie = cookieValue(response, "oauth_state")!;
      const state = new URL(payload.data.authorizationUrl).searchParams.get(
        "state"
      )!;
      events.length = 0;
      return {
        path: `/api/admin/sources/${providerKind}/callback?state=${encodeURIComponent(state)}&code=provider-code`,
        oauthCookie
      };
    },
    failNextControlLoad() {
      failNextLoad = true;
    },
    failOAuthComplete(error) {
      oauthCompleteFailure = error;
    }
  };
}

class MemoryRuntimeCache {
  private readonly values = new Map<string, unknown>();

  async get(key: string): Promise<unknown | null> {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class ControlProviderHarness {
  listFolderCalls = 0;
  mediaUrlCalls = 0;
  thumbnailUrlCalls = 0;
  readonly credentials: {
    accessToken: string;
    refreshToken: string | null;
    accessTokenExpiresAt: Date;
  };
  readonly adapter: ProviderAdapter;

  constructor(private readonly now: Date) {
    this.credentials = {
      accessToken: "access-token",
      refreshToken: null,
      accessTokenExpiresAt: new Date(now.getTime() + 60 * 60_000)
    };
    const root = providerNode("provider-root", "My Drive", null, "folder");
    const trips = providerNode("provider-trips", "Trips", "provider-root", "folder");
    const video = providerNode("video-1", "Video.mp4", "provider-trips", "video");
    this.adapter = {
      beginAuthorization: async ({ state }) => ({
        authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`
      }),
      completeAuthorization: async () => ({
        accountId: "account-created",
        accountLabel: "created@example.test",
        credentials: { ...this.credentials, refreshToken: "new-refresh-token" }
      }),
      refreshCredentials: async () => this.credentials,
      getRoot: async () => root,
      getNode: async ({ providerNodeId }) =>
        providerNodeId === trips.providerNodeId ? trips : root,
      listFolder: async () => {
        this.listFolderCalls += 1;
        return { items: [video], nextCursor: null };
      },
      getThumbnailUrl: async ({ providerNodeId }) => {
        this.thumbnailUrlCalls += 1;
        return {
          url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(providerNodeId)}?alt=media&access_token=access-token&supportsAllDrives=true`,
          expiresAt: new Date(this.now.getTime() + 5 * 60_000)
        };
      },
      getMediaUrl: async ({ providerNodeId }) => {
        this.mediaUrlCalls += 1;
        return {
          url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(providerNodeId)}?alt=media&access_token=access-token&supportsAllDrives=true`,
          expiresAt: new Date(this.now.getTime() + 5 * 60_000)
        };
      }
    };
  }
}

class FirestoreSentinel {
  readCount = 0;
  writeCount = 0;
  readonly client: Parameters<typeof createFirestoreRecoveryMirror>[0];

  constructor(private readonly householdId: string) {
    const read = async () => {
      this.readCount += 1;
      throw new Error("Firestore reads are forbidden");
    };
    const document = {
      set: async (value: ControlPlaneDocumentV2) => {
        if (value.householdId !== this.householdId) {
          throw new Error("Unexpected Firestore backup household");
        }
        this.writeCount += 1;
      },
      get: read,
      create: read,
      update: read,
      delete: read,
      listCollections: read
    };
    const collection = {
      doc: (id: string) => {
        if (id !== this.householdId) {
          throw new Error("Unexpected Firestore backup document");
        }
        return document;
      },
      get: read,
      where: read,
      orderBy: read,
      limit: read,
      listDocuments: read
    };
    this.client = {
      collection: (name: string) => {
        if (name !== "controlPlaneBackups") {
          throw new Error("Unexpected Firestore backup collection");
        }
        return collection;
      }
    } as unknown as Parameters<typeof createFirestoreRecoveryMirror>[0];
  }
}

function providerNode(
  providerNodeId: string,
  name: string,
  parentProviderId: string | null,
  kind: ProviderNode["kind"]
): ProviderNode {
  return {
    providerNodeId,
    parentProviderId,
    name,
    kind,
    mimeType: kind === "folder" ? null : `${kind}/mp4`,
    size: kind === "folder" ? null : 1_024,
    width: kind === "folder" ? null : 1_920,
    height: kind === "folder" ? null : 1_080,
    capturedAt: kind === "folder" ? null : new Date(TEST_NOW),
    createdAt: new Date(TEST_NOW),
    modifiedAt: new Date(TEST_NOW),
    thumbnailRevision: kind === "folder" ? null : "thumb-1",
    hasPreview: kind !== "folder"
  };
}

export function jsonRequest(
  path: string,
  method: string,
  body?: unknown,
  headers: HeadersInit = {}
): Request {
  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  return new Request(`https://dev.cloudframe.example${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

export function cookieValue(response: Response, name: string): string | null {
  const cookies = response.headers.getSetCookie();
  for (const cookie of cookies) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(cookie);
    if (match) return decodeURIComponent(match[1] ?? "");
  }
  return null;
}

export function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

export function cookieHeader(...cookies: Array<[string, string]>): string {
  return cookies.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}
