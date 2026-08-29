// @vitest-environment jsdom

import type { GoogleBearerMediaUrlResponse } from "@cloudframe/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleMediaBridge,
  type GoogleMediaBridge,
  type PreparedGoogleMediaSource,
} from "./google-media-bridge";
import type { GoogleMediaPageMessage, GoogleMediaWorkerMessage } from "./google-media-protocol";

const TEST_NOW = Date.parse("2026-08-29T12:00:00.000Z");
const RAW_URL =
  "https://www.googleapis.com/drive/v3/files/MOV00516?alt=media&supportsAllDrives=true";

function descriptor(overrides: Partial<GoogleBearerMediaUrlResponse> = {}): GoogleBearerMediaUrlResponse {
  return {
    itemId: "item_MOV00516",
    kind: "video",
    transport: "google-bearer",
    url: RAW_URL,
    authorization: { scheme: "Bearer", token: "ya29.test-token" },
    expiresAt: new Date(TEST_NOW + 60_000).toISOString(),
    revision: null,
    ...overrides,
  };
}

function mediaItem() {
  return { name: "MOV00516.MPG", kind: "video" as const, mimeType: "video/mpeg", size: 100 };
}

interface FakeServiceWorker {
  register: ReturnType<typeof vi.fn>;
  ready: Promise<ServiceWorkerRegistration>;
  controller: FakeWorker | null;
  originalWorker: FakeWorker;
  restartedWorker: FakeWorker;
  unboundWorker: FakeWorker;
  emitMessage(message: unknown, source?: FakeWorker | null): void;
  emitControllerChange(controller?: FakeWorker): void;
}

interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn<(message: GoogleMediaPageMessage) => void>>;
}

function bridgeHarness(options: {
  serviceWorker?: FakeServiceWorker | undefined;
  controlled?: boolean;
  now?: () => number;
} = {}) {
  const messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  const controllerListeners = new Set<() => void>();
  const originalWorker = { postMessage: vi.fn<(message: GoogleMediaPageMessage) => void>() };
  const restartedWorker = { postMessage: vi.fn<(message: GoogleMediaPageMessage) => void>() };
  const unboundWorker = { postMessage: vi.fn<(message: GoogleMediaPageMessage) => void>() };
  const fake: FakeServiceWorker = options.serviceWorker ?? {
    register: vi.fn().mockResolvedValue({}),
    ready: Promise.resolve({} as ServiceWorkerRegistration),
    controller: options.controlled === false ? null : originalWorker,
    originalWorker,
    restartedWorker,
    unboundWorker,
    emitMessage(message, source) {
      if (source === undefined) source = fake.controller;
      for (const listener of messageListeners) {
        listener({ data: message, source } as unknown as MessageEvent<unknown>);
      }
    },
    emitControllerChange(controller = restartedWorker) {
      this.controller = controller;
      for (const listener of controllerListeners) listener();
    },
  };
  const serviceWorker = Object.prototype.hasOwnProperty.call(options, "serviceWorker")
    ? options.serviceWorker
    : fake;
  if (serviceWorker) {
    Object.assign(serviceWorker, {
      addEventListener(type: string, listener: EventListener) {
        if (type === "message") messageListeners.add(listener as (event: MessageEvent<unknown>) => void);
        if (type === "controllerchange") controllerListeners.add(listener as () => void);
      },
      removeEventListener(type: string, listener: EventListener) {
        if (type === "message") messageListeners.delete(listener as (event: MessageEvent<unknown>) => void);
        if (type === "controllerchange") controllerListeners.delete(listener as () => void);
      },
    });
  }

  let random = 0;
  const bridge = createGoogleMediaBridge({
    serviceWorker: serviceWorker as unknown as ServiceWorkerContainer | undefined,
    crypto: {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        random += 1;
        if (array instanceof Uint8Array) array.fill(random);
        return array;
      },
    } as Crypto,
    now: options.now ?? (() => TEST_NOW),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  return { bridge, fake };
}

async function postedGrant(fake: FakeServiceWorker) {
  await vi.waitFor(() => expect(fake.controller?.postMessage).toHaveBeenCalled());
  return fake.controller!.postMessage.mock.calls.at(-1)![0] as GoogleMediaPageMessage & {
    type: "cloudframe-media-grant";
  };
}

async function prepareAndAck(): Promise<{
  bridge: GoogleMediaBridge;
  fake: FakeServiceWorker;
  prepared: PreparedGoogleMediaSource;
}> {
  const { bridge, fake } = bridgeHarness();
  const pending = bridge.prepare(descriptor(), mediaItem());
  const posted = await postedGrant(fake);
  fake.emitMessage({
    type: "cloudframe-media-grant-ack",
    requestId: posted.requestId,
    sessionId: posted.grant.sessionId,
  } satisfies GoogleMediaWorkerMessage);
  return { bridge, fake, prepared: await pending };
}

describe("Google media page bridge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("registers lazily and resolves prepare only after a matching grant ack", async () => {
    const { bridge, fake } = bridgeHarness();
    expect(fake.register).not.toHaveBeenCalled();
    const pending = bridge.prepare(descriptor(), mediaItem(), new AbortController().signal);
    expect(fake.register).toHaveBeenCalledWith("/cloudframe-media-sw.js", { scope: "/" });
    const posted = await postedGrant(fake);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(posted.grant).toMatchObject({
      rawUrl: RAW_URL,
      token: "ya29.test-token",
      kind: "video",
      mimeType: "video/mpeg",
      size: 100,
    });
    expect(posted.grant).not.toHaveProperty("clientId");
    fake.emitMessage({
      type: "cloudframe-media-grant-ack",
      requestId: posted.requestId,
      sessionId: posted.grant.sessionId,
    });
    await expect(pending).resolves.toMatchObject({ sourceUrl: descriptor().url, sourceKind: "google-raw" });
  });

  it("registers the fixed root-scope worker only once across preparations", async () => {
    const { bridge, fake, prepared } = await prepareAndAck();
    const pending = bridge.prepare(descriptor({ itemId: "item_MOV00516_again" }), mediaItem());
    await vi.waitFor(() => expect(fake.controller?.postMessage).toHaveBeenCalledTimes(2));
    const posted = fake.controller!.postMessage.mock.calls.at(-1)![0] as GoogleMediaPageMessage & {
      type: "cloudframe-media-grant";
    };
    expect(posted.grant.sessionId).not.toBe(prepared.sessionId);
    fake.emitMessage({
      type: "cloudframe-media-grant-ack",
      requestId: posted.requestId,
      sessionId: posted.grant.sessionId,
    });
    await pending;
    expect(fake.register).toHaveBeenCalledOnce();
  });

  it("keeps the token only in its private live-grant map", async () => {
    const { prepared } = await prepareAndAck();
    expect(JSON.stringify(prepared)).not.toContain("ya29.test-token");
    expect(document.documentElement.outerHTML).not.toContain("ya29.test-token");
  });

  it("regrants a live credential only for an exact fingerprint lookup", async () => {
    const { prepared, fake } = await prepareAndAck();
    fake.emitMessage({
      type: "cloudframe-media-grant-request",
      requestId: "request_worker_1",
      lookup: { kind: "fingerprint", value: prepared.fingerprint },
    } satisfies GoogleMediaWorkerMessage);
    expect(fake.controller?.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "cloudframe-media-grant",
      requestId: "request_worker_1",
    }));

    const callCount = fake.controller!.postMessage.mock.calls.length;
    fake.emitMessage({
      type: "cloudframe-media-grant-request",
      requestId: "request_worker_2",
      lookup: { kind: "fingerprint", value: "A".repeat(43) },
    } satisfies GoogleMediaWorkerMessage);
    expect(fake.controller?.postMessage).toHaveBeenCalledTimes(callCount);
  });

  it("ignores result evidence from a worker source not bound to the live session", async () => {
    const { bridge, fake, prepared } = await prepareAndAck();
    const result = {
      type: "cloudframe-media-result",
      sessionId: prepared.sessionId,
      attempt: "google-raw",
      outcome: "response",
      status: 206,
    } satisfies GoogleMediaWorkerMessage;
    fake.emitMessage(result, fake.unboundWorker);
    expect(bridge.evidence(prepared.sessionId)).toEqual({ attempt: "google-raw", outcome: "none" });
    fake.emitMessage(result, fake.originalWorker);
    expect(bridge.evidence(prepared.sessionId)).toEqual({
      attempt: "google-raw", outcome: "response", status: 206,
    });
  });

  it("binds a restarted worker after successful exact rehydration", async () => {
    const { bridge, fake, prepared } = await prepareAndAck();
    fake.emitMessage({
      type: "cloudframe-media-grant-request",
      requestId: "request_worker_restarted",
      lookup: { kind: "fingerprint", value: prepared.fingerprint },
    } satisfies GoogleMediaWorkerMessage, fake.restartedWorker);
    expect(fake.restartedWorker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "cloudframe-media-grant",
      requestId: "request_worker_restarted",
    }));
    fake.emitMessage({
      type: "cloudframe-media-result",
      sessionId: prepared.sessionId,
      attempt: "google-raw",
      outcome: "response",
      status: 206,
    } satisfies GoogleMediaWorkerMessage, fake.restartedWorker);
    expect(bridge.evidence(prepared.sessionId)).toEqual({
      attempt: "google-raw", outcome: "response", status: 206,
    });
  });

  it("fails with a stable error when service workers are unavailable", async () => {
    const { bridge } = bridgeHarness({ serviceWorker: undefined });
    await expect(bridge.prepare(descriptor(), mediaItem()))
      .rejects.toMatchObject({ code: "GOOGLE_MEDIA_BRIDGE_UNAVAILABLE" });
  });

  it("times out and cancels pending preparation without leaking credentials", async () => {
    const { bridge, fake } = bridgeHarness();
    const timedOut = bridge.prepare(descriptor(), mediaItem());
    const timedOutExpectation = expect(timedOut).rejects.toMatchObject({
      code: "GOOGLE_MEDIA_BRIDGE_TIMEOUT",
    });
    await postedGrant(fake);
    await vi.advanceTimersByTimeAsync(5_001);
    await timedOutExpectation;

    const controller = new AbortController();
    const cancelled = bridge.prepare(descriptor(), mediaItem(), controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "GOOGLE_MEDIA_BRIDGE_CANCELLED" });
    expect(document.documentElement.outerHTML).not.toContain("ya29.test-token");
  });

  it("records bounded delivery evidence and revokes the exact session", async () => {
    const { bridge, fake, prepared } = await prepareAndAck();
    fake.emitMessage({
      type: "cloudframe-media-result",
      sessionId: prepared.sessionId,
      attempt: "google-raw",
      outcome: "response",
      status: 206,
    } satisfies GoogleMediaWorkerMessage);
    expect(bridge.evidence(prepared.sessionId)).toEqual({
      attempt: "google-raw", outcome: "response", status: 206,
    });
    await expect(bridge.waitForEvidence(prepared.sessionId, 300)).resolves.toEqual({
      attempt: "google-raw", outcome: "response", status: 206,
    });
    bridge.release(prepared.sessionId);
    expect(fake.controller?.postMessage).toHaveBeenLastCalledWith({
      type: "cloudframe-media-revoke", sessionId: prepared.sessionId,
    });
  });

  it("revokes both the original and regranted workers after a controller change", async () => {
    const { bridge, fake, prepared } = await prepareAndAck();
    fake.emitControllerChange(fake.restartedWorker);
    fake.emitMessage({
      type: "cloudframe-media-grant-request",
      requestId: "request_worker_regrant",
      lookup: { kind: "fingerprint", value: prepared.fingerprint },
    } satisfies GoogleMediaWorkerMessage, fake.restartedWorker);

    bridge.release(prepared.sessionId);

    const revoke = { type: "cloudframe-media-revoke", sessionId: prepared.sessionId };
    expect(fake.originalWorker.postMessage).toHaveBeenCalledWith(revoke);
    expect(fake.restartedWorker.postMessage).toHaveBeenCalledWith(revoke);
  });

  it("revokes every authorized worker exactly once", async () => {
    const { bridge, fake, prepared } = await prepareAndAck();
    for (const requestId of ["request_worker_first", "request_worker_again"]) {
      fake.emitMessage({
        type: "cloudframe-media-grant-request",
        requestId,
        lookup: { kind: "fingerprint", value: prepared.fingerprint },
      } satisfies GoogleMediaWorkerMessage, fake.restartedWorker);
    }

    bridge.release(prepared.sessionId);
    bridge.release(prepared.sessionId);

    const isRevoke = ([message]: [GoogleMediaPageMessage]) => message.type === "cloudframe-media-revoke";
    expect(fake.originalWorker.postMessage.mock.calls.filter(isRevoke)).toHaveLength(1);
    expect(fake.restartedWorker.postMessage.mock.calls.filter(isRevoke)).toHaveLength(1);
  });

  it("revokes every worker reached by an unacknowledged grant when preparation times out", async () => {
    const { bridge, fake } = bridgeHarness();
    const pending = bridge.prepare(descriptor(), mediaItem());
    const rejection = expect(pending).rejects.toMatchObject({ code: "GOOGLE_MEDIA_BRIDGE_TIMEOUT" });
    const posted = await postedGrant(fake);
    fake.emitMessage({
      type: "cloudframe-media-grant-request",
      requestId: "request_worker_pending",
      lookup: { kind: "fingerprint", value: posted.grant.fingerprint },
    } satisfies GoogleMediaWorkerMessage, fake.restartedWorker);

    await vi.advanceTimersByTimeAsync(5_001);
    await rejection;

    const isRevoke = ([message]: [GoogleMediaPageMessage]) => message.type === "cloudframe-media-revoke";
    expect(fake.originalWorker.postMessage.mock.calls.filter(isRevoke)).toHaveLength(1);
    expect(fake.restartedWorker.postMessage.mock.calls.filter(isRevoke)).toHaveLength(1);
  });

  it("cancels preparation and revokes the reached worker when released before acknowledgement", async () => {
    const { bridge, fake } = bridgeHarness();
    const pending = bridge.prepare(descriptor(), mediaItem());
    const rejection = expect(pending).rejects.toMatchObject({ code: "GOOGLE_MEDIA_BRIDGE_CANCELLED" });
    const posted = await postedGrant(fake);

    bridge.release(posted.grant.sessionId);
    await rejection;

    const isRevoke = ([message]: [GoogleMediaPageMessage]) => message.type === "cloudframe-media-revoke";
    expect(fake.originalWorker.postMessage.mock.calls.filter(isRevoke)).toHaveLength(1);
  });

  it("cancels preparation and revokes the reached worker when its grant expires", async () => {
    let timestamp = TEST_NOW;
    const { bridge, fake } = bridgeHarness({ now: () => timestamp });
    const pending = bridge.prepare(descriptor(), mediaItem());
    const rejection = expect(pending).rejects.toMatchObject({ code: "GOOGLE_MEDIA_BRIDGE_CANCELLED" });
    const posted = await postedGrant(fake);

    timestamp = TEST_NOW + 60_001;
    void bridge.evidence(posted.grant.sessionId);
    fake.emitMessage({
      type: "cloudframe-media-grant-request",
      requestId: "request_worker_expiry_probe",
      lookup: { kind: "fingerprint", value: posted.grant.fingerprint },
    } satisfies GoogleMediaWorkerMessage);
    await rejection;

    const isRevoke = ([message]: [GoogleMediaPageMessage]) => message.type === "cloudframe-media-revoke";
    expect(fake.originalWorker.postMessage.mock.calls.filter(isRevoke)).toHaveLength(1);
  });

  it("waits through one controllerchange before granting", async () => {
    const { bridge, fake } = bridgeHarness({ controlled: false });
    const pending = bridge.prepare(descriptor(), mediaItem());
    await Promise.resolve();
    expect(fake.controller).toBeNull();
    fake.emitControllerChange();
    const posted = await postedGrant(fake);
    fake.emitMessage({
      type: "cloudframe-media-grant-ack",
      requestId: posted.requestId,
      sessionId: posted.grant.sessionId,
    });
    await expect(pending).resolves.toMatchObject({ sessionId: posted.grant.sessionId });
  });

  it("rejects an already-expired descriptor before registration", async () => {
    const { bridge, fake } = bridgeHarness();
    const expired = descriptor({ expiresAt: new Date(TEST_NOW).toISOString() });
    await expect(bridge.prepare(expired, mediaItem()))
      .rejects.toMatchObject({ code: "GOOGLE_MEDIA_BRIDGE_INVALID" });
    expect(fake.register).not.toHaveBeenCalled();
  });

  it("ignores unknown and mismatched acknowledgement and result messages", async () => {
    const { bridge, fake } = bridgeHarness();
    const pending = bridge.prepare(descriptor(), mediaItem());
    const posted = await postedGrant(fake);
    fake.emitMessage({ type: "unknown", token: "intruder" });
    fake.emitMessage({
      type: "cloudframe-media-grant-ack",
      requestId: `${posted.requestId}_wrong`,
      sessionId: posted.grant.sessionId,
    });
    fake.emitMessage({
      type: "cloudframe-media-grant-ack",
      requestId: posted.requestId,
      sessionId: `${posted.grant.sessionId}_wrong`,
    });
    fake.emitMessage({
      type: "cloudframe-media-result",
      sessionId: "session_unknown",
      attempt: "google-raw",
      outcome: "response",
      status: 206,
    });
    expect(bridge.evidence("session_unknown")).toEqual({ attempt: "google-raw", outcome: "none" });
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.emitMessage({
      type: "cloudframe-media-grant-ack",
      requestId: posted.requestId,
      sessionId: posted.grant.sessionId,
    });
    await pending;
  });

  it("resolves a pending evidence wait when a matching result arrives", async () => {
    const { bridge, fake, prepared } = await prepareAndAck();
    const pending = bridge.waitForEvidence(prepared.sessionId, 300);
    fake.emitMessage({
      type: "cloudframe-media-result",
      sessionId: prepared.sessionId,
      attempt: "google-raw",
      outcome: "network-error",
    } satisfies GoogleMediaWorkerMessage);
    await expect(pending).resolves.toEqual({ attempt: "google-raw", outcome: "network-error" });
  });

  it("returns none when the bounded evidence wait expires", async () => {
    const { bridge, prepared } = await prepareAndAck();
    const pending = bridge.waitForEvidence(prepared.sessionId, 300);
    await vi.advanceTimersByTimeAsync(301);
    await expect(pending).resolves.toEqual({ attempt: "google-raw", outcome: "none" });
  });
});
