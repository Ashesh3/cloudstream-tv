import { describe, expect, it, vi } from "vitest";
import {
  googleMediaAlias,
  googleMediaFingerprint,
  isExactGoogleMediaUrl,
  type GoogleMediaPageMessage,
  type GoogleMediaWorkerMessage,
} from "./google-media-protocol";
import {
  installGoogleMediaWorker,
  type GoogleMediaWorkerScope,
} from "./google-media-worker-runtime";

const RAW_URL =
  "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true";
const TEST_FINGERPRINT = "3AB37G86_cgrjatvKRIjGFG9CjOZwAtQnDzLhQTUlHs";
const TEST_NOW = 1_800_000_000_000;
type GoogleMediaGrantMessage = Extract<GoogleMediaPageMessage, { type: "cloudframe-media-grant" }>;

function grantMessage(requestId = "request_test"): GoogleMediaGrantMessage {
  return {
    type: "cloudframe-media-grant",
    requestId,
    grant: {
      sessionId: "session_test",
      rawUrl: RAW_URL,
      fingerprint: TEST_FINGERPRINT,
      token: "ya29.test-token",
      expiresAtEpoch: TEST_NOW + 60_000,
      kind: "video",
      mimeType: "video/mpeg",
      filename: "MOV00516.MPG",
      size: 100,
    },
  };
}

function rawRequest(headers: Record<string, string> = {}): Request {
  return new Request(RAW_URL, { method: "GET", headers });
}

interface WorkerHarness {
  providerFetch: ReturnType<typeof vi.fn>;
  clientMessages: GoogleMediaWorkerMessage[];
  skipWaiting: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  dispatchInstall(): Promise<void>;
  dispatchActivate(): Promise<void>;
  dispatchMessage(message: GoogleMediaPageMessage, source: { id: string }): Promise<void>;
  dispatchFetch(request: Request, clientId: string): Promise<Response>;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function workerHarness(options?: {
  upstream?: Response;
  fetchError?: Error;
  fingerprint?: (url: string) => Promise<string>;
}): WorkerHarness {
  const listeners = new Map<string, (event: unknown) => void>();
  const clientMessages: GoogleMediaWorkerMessage[] = [];
  const clients = new Map<string, { id: string; postMessage(message: GoogleMediaWorkerMessage): void }>();
  const skipWaiting = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const providerFetch = vi.fn(async (request: Request) => {
    void request;
    if (options?.fetchError) throw options.fetchError;
    if (options?.upstream) return options.upstream;
    return new Response(new Uint8Array(100), {
      status: 206,
      headers: {
        "accept-ranges": "bytes",
        "content-length": "100",
        "content-range": "bytes 0-99/100",
        "content-type": "video/mpeg",
      },
    });
  });
  const client = (id: string) => {
    const existing = clients.get(id);
    if (existing) return existing;
    const created = {
      id,
      postMessage(message: GoogleMediaWorkerMessage) {
        clientMessages.push(message);
      },
    };
    clients.set(id, created);
    return created;
  };
  const scope = {
    location: { origin: "https://tv.test" },
    clients: {
      claim,
      get: vi.fn(async (id: string) => clients.get(id)),
    },
    skipWaiting,
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, listener);
    },
  } as GoogleMediaWorkerScope;

  installGoogleMediaWorker(scope, {
    fetch: providerFetch as unknown as typeof globalThis.fetch,
    now: () => TEST_NOW,
    fingerprint: options?.fingerprint ?? (async () => TEST_FINGERPRINT),
    isAllowedMediaUrl: isExactGoogleMediaUrl,
    setTimeout: ((callback: TimerHandler) => globalThis.setTimeout(callback, 25)) as typeof globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });

  async function dispatchLifecycle(type: "install" | "activate"): Promise<void> {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({
      waitUntil(value: Promise<unknown>) {
        waits.push(Promise.resolve(value));
      },
    });
    await Promise.all(waits);
  }

  return {
    providerFetch,
    clientMessages,
    skipWaiting,
    claim,
    dispatchInstall: () => dispatchLifecycle("install"),
    dispatchActivate: () => dispatchLifecycle("activate"),
    async dispatchMessage(message, source) {
      const waits: Promise<unknown>[] = [];
      const messageSource = client(source.id);
      listeners.get("message")?.({
        data: message,
        source: messageSource,
        waitUntil(value: Promise<unknown>) {
          waits.push(Promise.resolve(value));
        },
      });
      await Promise.all(waits);
    },
    async dispatchFetch(request, clientId) {
      client(clientId);
      let response: Promise<Response> | null = null;
      const waits: Promise<unknown>[] = [];
      listeners.get("fetch")?.({
        request,
        clientId,
        respondWith(value: Promise<Response> | Response) {
          response = Promise.resolve(value);
        },
        waitUntil(value: Promise<unknown>) {
          waits.push(Promise.resolve(value));
        },
      });
      if (!response) throw new Error(`Worker did not intercept ${request.url}`);
      const resolved = await response;
      await Promise.all(waits);
      return resolved;
    },
  };
}

function expectSecretSafe(messages: GoogleMediaWorkerMessage[]): void {
  const serialized = JSON.stringify(messages);
  expect(serialized).not.toContain("ya29.test-token");
  expect(serialized).not.toContain("www.googleapis.com");
}

describe("Google media worker runtime", () => {
  it("takes control immediately when installed and activated", async () => {
    const harness = workerHarness();
    await harness.dispatchInstall();
    await harness.dispatchActivate();
    expect(harness.skipWaiting).toHaveBeenCalledOnce();
    expect(harness.claim).toHaveBeenCalledOnce();
  });

  it("accepts an exact grant, clones it, and acknowledges only its source client", async () => {
    const harness = workerHarness();
    const message = grantMessage();
    await harness.dispatchMessage(message, { id: "client_tv" });
    message.grant.token = "ya29.mutated";
    const response = await harness.dispatchFetch(rawRequest({ range: "bytes=0-" }), "client_tv");

    expect(response.status).toBe(206);
    expect(harness.clientMessages).toContainEqual({
      type: "cloudframe-media-grant-ack",
      requestId: "request_test",
      sessionId: "session_test",
    });
    const request = harness.providerFetch.mock.calls[0]![0];
    expect(request.headers.get("authorization")).toBe("Bearer ya29.test-token");
    expectSecretSafe(harness.clientMessages);
  });

  it.each([
    ["a custom prototype", () => Object.assign(Object.create({ inherited: true }), grantMessage())],
    ["an extra message key", () => ({ ...grantMessage(), clientId: "client_fake" })],
    ["an extra grant key", () => ({ ...grantMessage(), grant: { ...grantMessage().grant, providerId: "file_123" } })],
    ["an expired time", () => ({ ...grantMessage(), grant: { ...grantMessage().grant, expiresAtEpoch: TEST_NOW } })],
    ["a control character in the token", () => ({ ...grantMessage(), grant: { ...grantMessage().grant, token: "ya29.test\ntoken" } })],
    ["a MIME type outside the media kind", () => ({ ...grantMessage(), grant: { ...grantMessage().grant, mimeType: "image/jpeg" } })],
    ["an empty MIME subtype", () => ({ ...grantMessage(), grant: { ...grantMessage().grant, mimeType: "video/" } })],
    ["an invalid session ID", () => ({ ...grantMessage(), grant: { ...grantMessage().grant, sessionId: "other_test" } })],
    ["an invalid request ID", () => ({ ...grantMessage(), requestId: "other_test" })],
    ["a mismatched fingerprint", () => ({ ...grantMessage(), grant: { ...grantMessage().grant, fingerprint: "A".repeat(43) } })],
    ["an unsafe size", () => ({ ...grantMessage(), grant: { ...grantMessage().grant, size: Number.MAX_SAFE_INTEGER + 1 } })],
    ["a non-Google raw URL", () => ({ ...grantMessage(), grant: { ...grantMessage().grant, rawUrl: "https://evil.test/video" } })],
  ])("rejects a grant with %s", async (_label, makeMessage) => {
    const harness = workerHarness();
    await harness.dispatchMessage(makeMessage() as unknown as GoogleMediaPageMessage, { id: "client_tv" });
    expect(harness.clientMessages).toEqual([]);
    expectSecretSafe(harness.clientMessages);
  });

  it("adds only bearer authorization and one Range header", async () => {
    const { dispatchMessage, dispatchFetch, providerFetch, clientMessages } = workerHarness();
    await dispatchMessage(grantMessage(), { id: "client_tv" });
    const response = await dispatchFetch(rawRequest({
      range: "bytes=0-",
      "if-range": '"retired-etag"',
    }), "client_tv");

    expect(response.status).toBe(206);
    const providerRequest = providerFetch.mock.calls[0]![0] as unknown;
    expect(providerRequest).toBeInstanceOf(Request);
    const request = providerRequest as Request;
    expect(request.url).toBe(RAW_URL);
    expect(request.method).toBe("GET");
    expect(request.mode).toBe("cors");
    expect(request.credentials).toBe("omit");
    expect(request.cache).toBe("no-store");
    expect(request.redirect).toBe("follow");
    expect(request.referrer).toBe("");
    expect(request.referrerPolicy).toBe("no-referrer");
    expect(request.headers.get("authorization")).toBe("Bearer ya29.test-token");
    expect(request.headers.get("range")).toBe("bytes=0-");
    expect(request.headers.has("if-range")).toBe(false);
    expect([...request.headers.keys()]).toEqual(["authorization", "range"]);
    expect(providerFetch.mock.calls[0]).toHaveLength(1);
    expectSecretSafe(clientMessages);
  });

  it("reconstructs a same-origin 206 stream from the CORS response", async () => {
    const upstream = new Response(new Uint8Array([1]), {
      status: 206,
      statusText: "provider-secret-detail",
      headers: {
        "content-type": "video/mpeg",
        "content-range": "bytes 0-0/100",
        "accept-ranges": "bytes",
        "content-length": "1",
        "x-google-debug": "secret-detail",
      },
    });
    const { dispatchMessage, dispatchFetch, clientMessages } = workerHarness({ upstream });
    await dispatchMessage(grantMessage(), { id: "client_tv" });
    const response = await dispatchFetch(rawRequest({ range: "bytes=0-0" }), "client_tv");
    expect(response.status).toBe(206);
    expect(response.statusText).toBe("");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1]));
    expect(Object.fromEntries(response.headers)).toEqual({
      "accept-ranges": "bytes",
      "content-length": "1",
      "content-range": "bytes 0-0/100",
      "content-type": "video/mpeg",
    });
    expect(response.headers.has("x-google-debug")).toBe(false);
    expect(clientMessages).toContainEqual({
      type: "cloudframe-media-result",
      sessionId: "session_test",
      attempt: "google-raw",
      outcome: "response",
      status: 206,
    });
    expectSecretSafe(clientMessages);
  });

  it.each([
    ["bytes=0-", 100, "bytes 0-99/100", "100"],
    ["bytes=10-20", 100, "bytes 10-20/100", "11"],
    ["bytes=-25", 100, "bytes 75-99/100", "25"],
  ])("synthesizes CORS-hidden headers for %s", async (header, bodySize, contentRange, contentLength) => {
    const upstream = new Response(new Uint8Array(bodySize), {
      status: 206,
      headers: { "content-type": "video/mpeg" },
    });
    const { dispatchMessage, dispatchFetch, clientMessages } = workerHarness({ upstream });
    await dispatchMessage(grantMessage(), { id: "client_tv" });
    const response = await dispatchFetch(rawRequest({ range: header }), "client_tv");
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(contentLength);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expectSecretSafe(clientMessages);
  });

  it.each([
    ["content-range", { "content-range": "bytes 10-20/100" }, "bytes 10-20/100", "11"],
    ["content-length", { "content-length": "11" }, "bytes 10-20/100", "11"],
  ])("synthesizes only the compatible hidden %s metadata", async (_label, visible, contentRange, contentLength) => {
    const upstream = new Response(new Uint8Array(11), {
      status: 206,
      headers: { "content-type": "video/mpeg", ...visible },
    });
    const harness = workerHarness({ upstream });
    await harness.dispatchMessage(grantMessage(), { id: "client_tv" });
    const response = await harness.dispatchFetch(rawRequest({ range: "bytes=10-20" }), "client_tv");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(contentLength);
    expectSecretSafe(harness.clientMessages);
  });

  it("accepts internally consistent exposed 206 metadata when the grant size is unknown", async () => {
    const upstream = new Response(new Uint8Array(11), {
      status: 206,
      headers: {
        "content-range": "bytes 10-20/100",
        "content-length": "11",
        "content-type": "video/mpeg",
      },
    });
    const message = grantMessage();
    message.grant.size = null;
    const harness = workerHarness({ upstream });
    await harness.dispatchMessage(message, { id: "client_tv" });
    const response = await harness.dispatchFetch(rawRequest({ range: "bytes=10-20" }), "client_tv");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-20/100");
    expect(response.headers.get("content-length")).toBe("11");
    expectSecretSafe(harness.clientMessages);
  });

  it("accepts a provider-clamped open range when exposed metadata is internally consistent", async () => {
    const upstream = new Response(new Uint8Array(90), {
      status: 206,
      headers: {
        "content-range": "bytes 10-99/100",
        "content-length": "90",
      },
    });
    const message = grantMessage();
    message.grant.size = null;
    const harness = workerHarness({ upstream });
    await harness.dispatchMessage(message, { id: "client_tv" });
    const response = await harness.dispatchFetch(rawRequest({ range: "bytes=10-200" }), "client_tv");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-99/100");
    expect(response.headers.get("content-length")).toBe("90");
  });

  it.each([
    ["malformed content-range", { "content-range": "bytes nope", "content-length": "1" }, "bytes=0-0"],
    ["a different requested interval", { "content-range": "bytes 1-1/100", "content-length": "1" }, "bytes=0-0"],
    ["a different known total", { "content-range": "bytes 0-0/101", "content-length": "1" }, "bytes=0-0"],
    ["content-length shorter than the interval", { "content-range": "bytes 0-1/100", "content-length": "1" }, "bytes=0-1"],
    ["content-length longer than the interval", { "content-range": "bytes 0-0/100", "content-length": "2" }, "bytes=0-0"],
    ["only an incompatible content-range", { "content-range": "bytes 1-1/100" }, "bytes=0-0"],
    ["only an incompatible content-length", { "content-length": "2" }, "bytes=0-0"],
  ])("fails closed for 206 metadata with %s", async (_label, headers, range) => {
    const upstream = new Response(new Uint8Array([1]), {
      status: 206,
      headers: { "content-type": "video/mpeg", ...headers },
    });
    const harness = workerHarness({ upstream });
    await harness.dispatchMessage(grantMessage(), { id: "client_tv" });
    const response = await harness.dispatchFetch(rawRequest({ range }), "client_tv");
    expect(response.type).toBe("error");
    expect(harness.clientMessages).toContainEqual({
      type: "cloudframe-media-result",
      sessionId: "session_test",
      attempt: "google-raw",
      outcome: "bridge-error",
    });
    expectSecretSafe(harness.clientMessages);
  });

  it("rejects a 206 response when no byte range was requested", async () => {
    const upstream = new Response(new Uint8Array([1]), {
      status: 206,
      headers: {
        "content-range": "bytes 0-0/100",
        "content-length": "1",
      },
    });
    const harness = workerHarness({ upstream });
    await harness.dispatchMessage(grantMessage(), { id: "client_tv" });
    const response = await harness.dispatchFetch(rawRequest(), "client_tv");
    expect(response.type).toBe("error");
    expectSecretSafe(harness.clientMessages);
  });

  it.each([
    ["an unknown size", null, "bytes=0-"],
    ["an unsatisfiable start", 100, "bytes=100-"],
  ])("fails a hidden 206 safely for %s", async (_label, size, range) => {
    const upstream = new Response(new Uint8Array([1]), {
      status: 206,
      headers: { "content-type": "video/mpeg" },
    });
    const message = grantMessage();
    message.grant.size = size;
    const harness = workerHarness({ upstream });
    await harness.dispatchMessage(message, { id: "client_tv" });
    const response = await harness.dispatchFetch(rawRequest({ range }), "client_tv");
    expect(response.type).toBe("error");
    expect(harness.clientMessages).toContainEqual({
      type: "cloudframe-media-result",
      sessionId: "session_test",
      attempt: "google-raw",
      outcome: "bridge-error",
    });
    expectSecretSafe(harness.clientMessages);
  });

  it("requests memory rehydration by fingerprint after a worker restart", async () => {
    const { dispatchMessage, dispatchFetch, clientMessages } = workerHarness();
    const pending = dispatchFetch(rawRequest({ range: "bytes=0-" }), "client_tv");
    await Promise.resolve();
    expect(clientMessages).toContainEqual(expect.objectContaining({
      type: "cloudframe-media-grant-request",
      lookup: {
        kind: "fingerprint",
        value: await googleMediaFingerprint(RAW_URL),
      },
    }));
    const request = clientMessages.find(message => message.type === "cloudframe-media-grant-request");
    expect(request).toBeDefined();
    await dispatchMessage(grantMessage(request!.requestId), { id: "client_tv" });
    await expect(pending).resolves.toMatchObject({ status: 206 });
    expectSecretSafe(clientMessages);
  });

  it("requests alias rehydration only from the fetching client and then fails closed", async () => {
    const harness = workerHarness();
    const response = await harness.dispatchFetch(
      new Request("https://tv.test/__cloudframe_media__/session_test/MOV00516.MPG"),
      "client_tv",
    );
    expect(response.type).toBe("error");
    expect(harness.providerFetch).not.toHaveBeenCalled();
    expect(harness.clientMessages).toContainEqual(expect.objectContaining({
      type: "cloudframe-media-grant-request",
      lookup: { kind: "session", value: "session_test" },
    }));
    expectSecretSafe(harness.clientMessages);
  });

  it.each([
    ["expired grants", async (harness: WorkerHarness) => {
      const message = grantMessage();
      message.grant.expiresAtEpoch = TEST_NOW;
      await harness.dispatchMessage(message, { id: "client_tv" });
      return harness.dispatchFetch(rawRequest(), "client_tv");
    }, "error", 0],
    ["mismatched client IDs", async (harness: WorkerHarness) => {
      await harness.dispatchMessage(grantMessage(), { id: "client_tv" });
      return harness.dispatchFetch(rawRequest(), "client_other");
    }, "error", 0],
    ["POST requests", async (harness: WorkerHarness) => {
      await harness.dispatchMessage(grantMessage(), { id: "client_tv" });
      return harness.dispatchFetch(new Request(RAW_URL, { method: "POST" }), "client_tv");
    }, "error", 0],
    ["multi-range requests", async (harness: WorkerHarness) => {
      await harness.dispatchMessage(grantMessage(), { id: "client_tv" });
      return harness.dispatchFetch(rawRequest({ range: "bytes=0-1,10-20" }), "client_tv");
    }, "error", 0],
  ])("fails closed for %s", async (_label, act, expectedType, expectedFetches) => {
    const harness = workerHarness();
    const response = await act(harness);
    expect(response.type).toBe(expectedType);
    expect(harness.providerFetch).toHaveBeenCalledTimes(expectedFetches);
    expectSecretSafe(harness.clientMessages);
  });

  it.each([401, 403, 416])("preserves provider status %s in a rebuilt response", async status => {
    const headers = status === 416 ? { "content-range": "bytes */100" } : undefined;
    const harness = workerHarness({ upstream: new Response(null, { status, headers }) });
    await harness.dispatchMessage(grantMessage(), { id: "client_tv" });
    const response = await harness.dispatchFetch(rawRequest({ range: "bytes=0-" }), "client_tv");
    expect(response.status).toBe(status);
    expect(harness.clientMessages).toContainEqual({
      type: "cloudframe-media-result",
      sessionId: "session_test",
      attempt: "google-raw",
      outcome: "response",
      status,
    });
    expectSecretSafe(harness.clientMessages);
  });

  it("turns a rejected provider fetch into secret-safe network evidence", async () => {
    const harness = workerHarness({ fetchError: new Error(`${RAW_URL} ya29.test-token`) });
    await harness.dispatchMessage(grantMessage(), { id: "client_tv" });
    const response = await harness.dispatchFetch(rawRequest({ range: "bytes=0-" }), "client_tv");
    expect(response.type).toBe("error");
    expect(harness.clientMessages).toContainEqual({
      type: "cloudframe-media-result",
      sessionId: "session_test",
      attempt: "google-raw",
      outcome: "network-error",
    });
    expectSecretSafe(harness.clientMessages);
  });

  it("revokes only the exact source-bound session", async () => {
    const harness = workerHarness();
    await harness.dispatchMessage(grantMessage(), { id: "client_tv" });
    await harness.dispatchMessage({
      type: "cloudframe-media-revoke",
      sessionId: "session_test",
    }, { id: "client_other" });
    await expect(harness.dispatchFetch(rawRequest({ range: "bytes=0-" }), "client_tv"))
      .resolves.toMatchObject({ status: 206 });

    await harness.dispatchMessage({
      type: "cloudframe-media-revoke",
      sessionId: "session_test",
    }, { id: "client_tv" });
    const response = await harness.dispatchFetch(rawRequest({ range: "bytes=0-" }), "client_tv");
    expect(response.type).toBe("error");
    expect(harness.providerFetch).toHaveBeenCalledOnce();
    expectSecretSafe(harness.clientMessages);
  });

  it("does not commit a grant revoked while fingerprint validation is pending", async () => {
    const validation = deferred<string>();
    const fingerprint = vi.fn()
      .mockReturnValueOnce(validation.promise)
      .mockResolvedValue(TEST_FINGERPRINT);
    const harness = workerHarness({ fingerprint });
    const pendingGrant = harness.dispatchMessage(
      grantMessage("request_revoked_during_validation"),
      { id: "client_tv" },
    );
    expect(fingerprint).toHaveBeenCalledOnce();

    await harness.dispatchMessage({
      type: "cloudframe-media-revoke",
      sessionId: "session_test",
    }, { id: "client_tv" });
    validation.resolve(TEST_FINGERPRINT);
    await pendingGrant;

    expect(harness.clientMessages).not.toContainEqual(expect.objectContaining({
      type: "cloudframe-media-grant-ack",
      requestId: "request_revoked_during_validation",
    }));
    const raw = await harness.dispatchFetch(rawRequest({ range: "bytes=0-" }), "client_tv");
    const alias = await harness.dispatchFetch(
      new Request(`https://tv.test${googleMediaAlias("session_test", "MOV00516.MPG")}`, {
        headers: { range: "bytes=0-" },
      }),
      "client_tv",
    );
    expect(raw.type).toBe("error");
    expect(alias.type).toBe("error");
    expect(harness.providerFetch).not.toHaveBeenCalled();
    expectSecretSafe(harness.clientMessages);
  });

  it("keeps in-flight grant revocation source-bound", async () => {
    const validation = deferred<string>();
    const fingerprint = vi.fn().mockReturnValueOnce(validation.promise);
    const harness = workerHarness({ fingerprint });
    const pendingGrant = harness.dispatchMessage(
      grantMessage("request_source_bound"),
      { id: "client_tv" },
    );
    expect(fingerprint).toHaveBeenCalledOnce();

    await harness.dispatchMessage({
      type: "cloudframe-media-revoke",
      sessionId: "session_test",
    }, { id: "client_other" });
    validation.resolve(TEST_FINGERPRINT);
    await pendingGrant;

    expect(harness.clientMessages).toContainEqual({
      type: "cloudframe-media-grant-ack",
      requestId: "request_source_bound",
      sessionId: "session_test",
    });
    await expect(harness.dispatchFetch(rawRequest({ range: "bytes=0-" }), "client_tv"))
      .resolves.toMatchObject({ status: 206 });
    expectSecretSafe(harness.clientMessages);
  });

  it("accepts a genuinely later grant after revocation supersedes an older validation", async () => {
    const validation = deferred<string>();
    const fingerprint = vi.fn()
      .mockReturnValueOnce(validation.promise)
      .mockResolvedValue(TEST_FINGERPRINT);
    const harness = workerHarness({ fingerprint });
    const pendingGrant = harness.dispatchMessage(
      grantMessage("request_before_revoke"),
      { id: "client_tv" },
    );
    expect(fingerprint).toHaveBeenCalledOnce();

    await harness.dispatchMessage({
      type: "cloudframe-media-revoke",
      sessionId: "session_test",
    }, { id: "client_tv" });
    await harness.dispatchMessage(
      grantMessage("request_after_revoke"),
      { id: "client_tv" },
    );
    validation.resolve(TEST_FINGERPRINT);
    await pendingGrant;

    expect(harness.clientMessages).not.toContainEqual(expect.objectContaining({
      type: "cloudframe-media-grant-ack",
      requestId: "request_before_revoke",
    }));
    expect(harness.clientMessages).toContainEqual({
      type: "cloudframe-media-grant-ack",
      requestId: "request_after_revoke",
      sessionId: "session_test",
    });
    await expect(harness.dispatchFetch(rawRequest({ range: "bytes=0-" }), "client_tv"))
      .resolves.toMatchObject({ status: 206 });
    expect(harness.providerFetch).toHaveBeenCalledOnce();
    expectSecretSafe(harness.clientMessages);
  });

  it("fails closed when bounded mutation tracking prunes an older in-flight grant", async () => {
    const validation = deferred<string>();
    const fingerprint = vi.fn().mockReturnValueOnce(validation.promise);
    const harness = workerHarness({ fingerprint });
    const pendingGrant = harness.dispatchMessage(
      grantMessage("request_pruned_validation"),
      { id: "client_tv" },
    );
    expect(fingerprint).toHaveBeenCalledOnce();

    for (let index = 0; index < 33; index += 1) {
      await harness.dispatchMessage({
        type: "cloudframe-media-revoke",
        sessionId: `session_prune_${index}`,
      }, { id: "client_tv" });
    }
    validation.resolve(TEST_FINGERPRINT);
    await pendingGrant;

    expect(harness.clientMessages).not.toContainEqual(expect.objectContaining({
      type: "cloudframe-media-grant-ack",
      requestId: "request_pruned_validation",
    }));
    expectSecretSafe(harness.clientMessages);
  });

  it("does not revive an older grant when a later same-session grant fails validation", async () => {
    const validation = deferred<string>();
    const fingerprint = vi.fn()
      .mockReturnValueOnce(validation.promise)
      .mockResolvedValueOnce("A".repeat(43));
    const harness = workerHarness({ fingerprint });
    const olderGrant = harness.dispatchMessage(
      grantMessage("request_older_validation"),
      { id: "client_tv" },
    );
    expect(fingerprint).toHaveBeenCalledOnce();

    await harness.dispatchMessage(
      grantMessage("request_later_invalid"),
      { id: "client_tv" },
    );
    validation.resolve(TEST_FINGERPRINT);
    await olderGrant;

    expect(harness.clientMessages).not.toContainEqual(expect.objectContaining({
      type: "cloudframe-media-grant-ack",
      sessionId: "session_test",
    }));
    expectSecretSafe(harness.clientMessages);
  });

  it("does not let another client replace an existing source-bound session", async () => {
    const harness = workerHarness();
    await harness.dispatchMessage(grantMessage("request_first"), { id: "client_tv" });
    const collision = grantMessage("request_collision");
    collision.grant.token = "ya29.other-client-token";
    await harness.dispatchMessage(collision, { id: "client_other" });

    const response = await harness.dispatchFetch(
      rawRequest({ range: "bytes=0-" }),
      "client_tv",
    );
    expect(response.status).toBe(206);
    const request = harness.providerFetch.mock.calls[0]![0];
    expect(request.headers.get("authorization")).toBe("Bearer ya29.test-token");
    expect(harness.clientMessages).not.toContainEqual(expect.objectContaining({
      type: "cloudframe-media-grant-ack",
      requestId: "request_collision",
    }));
    expectSecretSafe(harness.clientMessages);
    expect(JSON.stringify(harness.clientMessages)).not.toContain("ya29.other-client-token");
  });

  it("evicts the oldest grant when a fifth live session is accepted", async () => {
    const harness = workerHarness();
    for (let index = 1; index <= 5; index += 1) {
      const message = grantMessage(`request_${index}`);
      message.grant.sessionId = `session_${index}`;
      message.grant.filename = `clip-${index}.mpg`;
      await harness.dispatchMessage(message, { id: "client_tv" });
    }

    const oldest = await harness.dispatchFetch(
      new Request(`https://tv.test${googleMediaAlias("session_1", "clip-1.mpg")}`),
      "client_tv",
    );
    expect(oldest.type).toBe("error");
    for (let index = 2; index <= 5; index += 1) {
      const response = await harness.dispatchFetch(
        new Request(`https://tv.test${googleMediaAlias(`session_${index}`, `clip-${index}.mpg`)}`, {
          headers: { range: "bytes=0-" },
        }),
        "client_tv",
      );
      expect(response.status).toBe(206);
    }
    expect(harness.providerFetch).toHaveBeenCalledTimes(4);
    expectSecretSafe(harness.clientMessages);
  });
});
