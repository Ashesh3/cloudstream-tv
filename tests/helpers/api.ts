import type {
  ControlPlaneDocumentV2,
  Household
} from "@cloudframe/shared";
import type {
  ProviderAdapter,
  ProviderNode,
  ProviderRegistry
} from "@cloudframe/providers";
import {
  MemoryRepository,
  createApiApp,
  createBrowseHandleCodec,
  createControlAdminService,
  createControlApiApp,
  createControlAuth,
  createControlEnrollmentService,
  createControlOAuthService,
  createControlRequestContextScope,
  createDirectMediaService,
  createLiveBrowseService,
  createLiveProviderFolderService,
  createSealedSessionCodec,
  hashOpaqueToken,
  hashPassphrase,
  type BrokeredProviderCredentials,
  type ControlApiLogger,
  type ControlMutationReducer,
  type ControlPlaneStore,
  type ApiAppDependencies,
  type RateLimitRuntimeCache,
  type RateLimitPolicy
} from "@cloudframe/server";

import { controlStoreHarness } from "../../packages/server/src/control-plane/memory";
import {
  TEST_NOW,
  testAeadKeyring,
  testControlDocument
} from "./control-plane";

const DEFAULT_NOW = new Date("2026-08-26T12:00:00.000Z");
const DEFAULT_ORIGIN = "https://dev.cloudframe.example";

export interface TestApi {
  app: ReturnType<typeof createApiApp>;
  repository: MemoryRepository;
  now: Date;
  origin: string;
  householdId: string;
  pepper: string;
  csrfSecret: string;
}

export interface TestApiOptions {
  allowNewDeviceRequests?: boolean;
  bootstrapHousehold?: boolean;
  now?: Date;
  initialPassphrase?: string;
  storedPassphrase?: string;
  rateLimits?: Partial<Record<string, RateLimitPolicy>>;
  requestSubject?: (request: Request) => string;
}

export interface ControlApiHarness {
  app: ReturnType<typeof createControlApiApp>;
  origin: string;
  now: Date;
  document: ControlPlaneDocumentV2;
  adminCookie: string;
  adminCsrf: string;
  deviceCookie: string;
  requestCookie: string;
  controlStore: { loadCount: number; mutateCount: number };
  durable: {
    readCount: number;
    conditionalReadCount: number;
    writeAttempts: number;
  };
  cache: { readCount: number };
  mirror: { writeCount: number };
  firestore: { readCount: number; writeCount: number };
  provider: {
    listFolderCalls: number;
    mediaUrlCalls: number;
    thumbnailUrlCalls: number;
  };
  adminHeaders(extra?: HeadersInit): HeadersInit;
  adminMutationHeaders(extra?: HeadersInit): HeadersInit;
  deviceHeaders(extra?: HeadersInit): HeadersInit;
  folderRequest(): Request;
  mediaRequest(): Request;
}

export async function createTestApi(
  options: TestApiOptions = {}
): Promise<TestApi> {
  const repository = new MemoryRepository();
  const now = options.now ?? DEFAULT_NOW;
  const origin = DEFAULT_ORIGIN;
  const householdId = "household-test";
  const pepper = "test-passphrase-pepper";
  const csrfSecret = "test-csrf-secret-that-is-long-enough";

  if (options.bootstrapHousehold !== false) {
    const household: Household = {
      id: householdId,
      createdAt: now,
      allowNewDeviceRequests: options.allowNewDeviceRequests ?? true,
      defaultMediaOrder: "captured-desc",
      defaultSlideshowSeconds: 8,
      adminPassphraseHash: await hashPassphrase(
        options.storedPassphrase ??
          options.initialPassphrase ??
          "correct horse battery staple",
        pepper
      ),
      adminPassphraseVersion: 1
    };
    await repository.putHousehold(household);
  }

  let id = 0;
  let token = 0;
  const dependencies: ApiAppDependencies = {
    repository,
    config: {
      householdId,
      adminInitialPassphrase: Object.prototype.hasOwnProperty.call(
        options,
        "initialPassphrase"
      )
        ? options.initialPassphrase
        : "correct horse battery staple",
      passphrasePepper: pepper,
      csrfSecret,
      allowedOrigin: origin,
      rateLimits: options.rateLimits
    },
    now: () => new Date(now),
    createId: prefix => `${prefix}-${++id}`,
    issueToken: () => {
      const raw = Buffer.alloc(32, ++token).toString("base64url");
      return {
        raw,
        hash: hashOpaqueToken(raw)
      };
    },
    requestSubject: options.requestSubject
  };

  return {
    app: createApiApp(dependencies),
    repository,
    now,
    origin,
    householdId,
    pepper,
    csrfSecret
  };
}

export async function createControlApiHarness(): Promise<ControlApiHarness> {
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
  const memory = controlStoreHarness(document);
  let loadCount = 0;
  let mutateCount = 0;
  const store: ControlPlaneStore = {
    async load() {
      loadCount += 1;
      return memory.store.load();
    },
    async mutate<T>(name: string, reducer: ControlMutationReducer<T>) {
      mutateCount += 1;
      return memory.store.mutate(name, reducer);
    }
  };

  let cacheReadCount = 0;
  const originalCacheGet = memory.cache.get.bind(memory.cache);
  memory.cache.get = async () => {
    cacheReadCount += 1;
    return originalCacheGet();
  };

  const provider = new ControlProviderHarness(now);
  const providers: ProviderRegistry = { get: () => provider.adapter };
  const sessionCodec = createSealedSessionCodec(testAeadKeyring(), () => now);
  const browseCodec = createBrowseHandleCodec(
    testAeadKeyring(),
    "test-browse-id-secret",
    () => now
  );
  const activeContext = () => {
    const active = memory.durable.currentDocument!;
    return { document: active, revision: active.revision };
  };
  const requestContext = createControlRequestContextScope();
  const broker = {
    async get(): Promise<BrokeredProviderCredentials> {
      return provider.credentials;
    },
    async refresh(): Promise<BrokeredProviderCredentials> {
      return provider.credentials;
    }
  };
  const admin = createControlAdminService({
    store,
    cache: memory.cache,
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
  const oauth = createControlOAuthService({
    store,
    codec: sessionCodec,
    providers,
    keyring: {
      currentVersion: "provider-v1",
      keys: { "provider-v1": Buffer.alloc(32, 9) }
    },
    redirectUris: {
      google: `${origin}/api/admin/sources/google/callback`,
      onedrive: `${origin}/api/admin/sources/onedrive/callback`
    },
    runtimeCache: new MemoryRuntimeCache(),
    now: () => new Date(now),
    createId: () => "source-created",
    randomBytes: (size) => Buffer.alloc(size, 8)
  });
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
  const logger: ControlApiLogger = { info: () => undefined, error: () => undefined };
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
    rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, retryAfterSeconds: 1 }) },
    config: { householdId: document.householdId, allowedOrigin: origin },
    now: () => new Date(now),
    requestSubject: () => "203.0.113.7",
    logger
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
        return memory.durable.readCount;
      },
      get conditionalReadCount() {
        return memory.durable.ifNoneMatches.filter(value => value !== undefined).length;
      },
      get writeAttempts() {
        return memory.durable.writeAttempts;
      }
    },
    cache: {
      get readCount() {
        return cacheReadCount;
      }
    },
    mirror: memory.mirror,
    firestore: { readCount: 0, writeCount: 0 },
    provider,
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
    }
  };
}

class MemoryRuntimeCache implements RateLimitRuntimeCache {
  private readonly values = new Map<string, unknown>();

  async get(key: string): Promise<unknown | null> {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

class ControlProviderHarness {
  listFolderCalls = 0;
  mediaUrlCalls = 0;
  thumbnailUrlCalls = 0;
  readonly credentials: BrokeredProviderCredentials;
  readonly adapter: ProviderAdapter;

  constructor(private readonly now: Date) {
    this.credentials = {
      accessToken: "access-token",
      refreshToken: null,
      accessTokenExpiresAt: new Date(now.getTime() + 60 * 60_000),
      credentialVersion: 1
    };
    const root = providerNode("provider-root", "My Drive", null, "folder");
    const trips = providerNode("provider-trips", "Trips", "provider-root", "folder");
    const video = providerNode("video-1", "Video.mp4", "provider-trips", "video");
    this.adapter = {
      beginAuthorization: async ({ state }) => ({
        authorizationUrl: `https://accounts.example.test/oauth?state=${encodeURIComponent(state)}`
      }),
      completeAuthorization: async () => ({
        accountId: "account-created",
        accountLabel: "created@example.test",
        credentials: this.credentials
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
