import type { GoogleBearerMediaUrlResponse } from "@cloudframe/shared";
import {
  googleMediaAlias,
  googleMediaFingerprint,
  isExactGoogleMediaUrl,
  sanitizeMediaFilename,
  type GoogleMediaGrant,
  type GoogleMediaPageMessage,
} from "./google-media-protocol";

const WORKER_URL = "/cloudframe-media-sw.js";
const WORKER_SCOPE = "/";
const GRANT_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_EVIDENCE_TIMEOUT_MS = 300;
const SESSION_ID = /^session_[A-Za-z0-9_-]{1,128}$/u;
const REQUEST_ID = /^request_[A-Za-z0-9_-]{1,128}$/u;
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/u;

export type GoogleMediaSourceKind = "google-raw" | "google-filename";

export interface PreparedGoogleMediaSource {
  sourceUrl: string;
  sourceKind: GoogleMediaSourceKind;
  sessionId: string;
  fingerprint: string;
}

export type GoogleMediaDeliveryEvidence =
  | { outcome: "none"; attempt: GoogleMediaSourceKind }
  | { outcome: "response"; attempt: GoogleMediaSourceKind; status: number }
  | { outcome: "network-error" | "bridge-error"; attempt: GoogleMediaSourceKind };

export type GoogleMediaBridgeErrorCode =
  | "GOOGLE_MEDIA_BRIDGE_UNAVAILABLE"
  | "GOOGLE_MEDIA_BRIDGE_INVALID"
  | "GOOGLE_MEDIA_BRIDGE_TIMEOUT"
  | "GOOGLE_MEDIA_BRIDGE_CANCELLED";

export class GoogleMediaBridgeError extends Error {
  readonly code: GoogleMediaBridgeErrorCode;

  constructor(code: GoogleMediaBridgeErrorCode) {
    super(errorMessage(code));
    this.name = "GoogleMediaBridgeError";
    this.code = code;
  }
}

export interface GoogleMediaBridge {
  prepare(
    descriptor: GoogleBearerMediaUrlResponse,
    item: { name: string; kind: "image" | "video"; mimeType: string; size: number | null },
    signal?: AbortSignal,
  ): Promise<PreparedGoogleMediaSource>;
  filenameSource(sessionId: string): PreparedGoogleMediaSource | null;
  evidence(sessionId: string): GoogleMediaDeliveryEvidence;
  waitForEvidence(sessionId: string, timeoutMs?: number): Promise<GoogleMediaDeliveryEvidence>;
  release(sessionId: string): void;
}

interface GoogleMediaBridgeDependencies {
  serviceWorker?: ServiceWorkerContainer;
  crypto?: Pick<Crypto, "getRandomValues">;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

interface LiveGrant {
  grant: GoogleMediaGrant;
  prepared: PreparedGoogleMediaSource;
  workers: Set<ServiceWorker>;
}

interface PendingGrant {
  sessionId: string;
  worker: ServiceWorker;
  resolve(source: PreparedGoogleMediaSource): void;
  reject(error: GoogleMediaBridgeError): void;
  timer: ReturnType<typeof globalThis.setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

interface EvidenceWaiter {
  resolve(evidence: GoogleMediaDeliveryEvidence): void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

export function createGoogleMediaBridge(
  overrides: GoogleMediaBridgeDependencies = {},
): GoogleMediaBridge {
  const serviceWorker = Object.prototype.hasOwnProperty.call(overrides, "serviceWorker")
    ? overrides.serviceWorker
    : defaultServiceWorker();
  const random = overrides.crypto ?? globalThis.crypto;
  const now = overrides.now ?? (() => Date.now());
  const schedule = overrides.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const cancel = overrides.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const grants = new Map<string, LiveGrant>();
  const pending = new Map<string, PendingGrant>();
  const evidenceBySession = new Map<string, GoogleMediaDeliveryEvidence>();
  const evidenceWaiters = new Map<string, Set<EvidenceWaiter>>();
  let registration: Promise<ServiceWorkerRegistration> | null = null;

  serviceWorker?.addEventListener("message", onMessage);

  return {
    async prepare(descriptor, item, signal) {
      const validated = validatePreparation(descriptor, item, now());
      if (!validated) throw new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_INVALID");
      if (!serviceWorker || !random) {
        throw new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_UNAVAILABLE");
      }
      throwIfAborted(signal);

      let worker: ServiceWorker;
      try {
        registration ??= serviceWorker.register(WORKER_URL, { scope: WORKER_SCOPE });
        await raceAbort(registration, signal);
        await raceAbort(serviceWorker.ready, signal);
        worker = await controllingWorker(serviceWorker, signal);
      } catch (error) {
        if (error instanceof GoogleMediaBridgeError) throw error;
        throw new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_UNAVAILABLE");
      }

      const sessionId = randomId("session", random);
      const requestId = randomId("request", random);
      let fingerprint: string;
      try {
        fingerprint = await raceAbort(googleMediaFingerprint(descriptor.url), signal);
      } catch (error) {
        if (error instanceof GoogleMediaBridgeError) throw error;
        throw new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_UNAVAILABLE");
      }
      throwIfAborted(signal);

      const grant: GoogleMediaGrant = {
        sessionId,
        rawUrl: descriptor.url,
        fingerprint,
        token: descriptor.authorization.token,
        expiresAtEpoch: validated.expiresAtEpoch,
        kind: item.kind,
        mimeType: item.mimeType,
        filename: validated.filename,
        size: item.size,
      };
      const prepared: PreparedGoogleMediaSource = {
        sourceUrl: descriptor.url,
        sourceKind: "google-raw",
        sessionId,
        fingerprint,
      };
      grants.set(sessionId, { grant, prepared, workers: new Set() });
      evidenceBySession.set(sessionId, noneEvidence("google-raw"));

      return new Promise<PreparedGoogleMediaSource>((resolve, reject) => {
        const timer = schedule(() => {
          failPending(requestId, "GOOGLE_MEDIA_BRIDGE_TIMEOUT");
        }, GRANT_ACK_TIMEOUT_MS);
        const entry: PendingGrant = { sessionId, worker, resolve, reject, timer, signal };
        if (signal) {
          entry.abort = () => failPending(requestId, "GOOGLE_MEDIA_BRIDGE_CANCELLED");
          signal.addEventListener("abort", entry.abort, { once: true });
        }
        pending.set(requestId, entry);
        try {
          worker.postMessage({ type: "cloudframe-media-grant", requestId, grant } satisfies GoogleMediaPageMessage);
        } catch {
          failPending(requestId, "GOOGLE_MEDIA_BRIDGE_UNAVAILABLE");
        }
      });
    },

    filenameSource(sessionId) {
      expireGrants();
      const live = grants.get(sessionId);
      if (!live) return null;
      evidenceBySession.set(sessionId, noneEvidence("google-filename"));
      return {
        sourceUrl: googleMediaAlias(sessionId, live.grant.filename),
        sourceKind: "google-filename",
        sessionId,
        fingerprint: live.prepared.fingerprint,
      };
    },

    evidence(sessionId) {
      return evidenceBySession.get(sessionId) ?? noneEvidence("google-raw");
    },

    waitForEvidence(sessionId, timeoutMs = DEFAULT_EVIDENCE_TIMEOUT_MS) {
      const current = evidenceBySession.get(sessionId) ?? noneEvidence("google-raw");
      if (current.outcome !== "none") return Promise.resolve(current);
      const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_EVIDENCE_TIMEOUT_MS;
      return new Promise<GoogleMediaDeliveryEvidence>(resolve => {
        const waiter: EvidenceWaiter = {
          resolve,
          timer: schedule(() => finishEvidenceWaiter(sessionId, waiter), boundedTimeout),
        };
        const waiters = evidenceWaiters.get(sessionId) ?? new Set<EvidenceWaiter>();
        waiters.add(waiter);
        evidenceWaiters.set(sessionId, waiters);
      });
    },

    release(sessionId) {
      const live = grants.get(sessionId);
      if (!live) return;
      const pendingRequestId = findPendingRequest(sessionId);
      if (pendingRequestId) {
        failPending(pendingRequestId, "GOOGLE_MEDIA_BRIDGE_CANCELLED");
        return;
      }
      grants.delete(sessionId);
      resolveEvidenceWaiters(sessionId, noneEvidence("google-raw"));
      evidenceBySession.delete(sessionId);
      revokeWorkers(live.workers, sessionId);
    },
  };

  function onMessage(event: MessageEvent<unknown>): void {
    const message = event.data;
    if (!plainRecord(message) || typeof message.type !== "string") return;
    if (message.type === "cloudframe-media-grant-ack") {
      if (!exactKeys(message, ["type", "requestId", "sessionId"]) ||
        typeof message.requestId !== "string" || !REQUEST_ID.test(message.requestId) ||
        typeof message.sessionId !== "string" || !SESSION_ID.test(message.sessionId)) return;
      const entry = pending.get(message.requestId);
      if (!entry || entry.sessionId !== message.sessionId || !sameWorker(event.source, entry.worker)) return;
      pending.delete(message.requestId);
      cancel(entry.timer);
      removeAbort(entry);
      const live = grants.get(entry.sessionId);
      if (live) {
        live.workers.add(entry.worker);
        entry.resolve(live.prepared);
      }
      else entry.reject(new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_CANCELLED"));
      return;
    }

    if (message.type === "cloudframe-media-grant-request") {
      if (!exactKeys(message, ["type", "requestId", "lookup"]) ||
        typeof message.requestId !== "string" || !REQUEST_ID.test(message.requestId) ||
        !validLookup(message.lookup)) return;
      expireGrants();
      const live = findGrant(message.lookup.kind, message.lookup.value);
      if (!live) return;
      const target = messageTarget(event.source);
      if (!target) return;
      try {
        target.postMessage({
          type: "cloudframe-media-grant",
          requestId: message.requestId,
          grant: live.grant,
        } satisfies GoogleMediaPageMessage);
        live.workers.add(target);
      } catch {
        // A replaced worker may disappear between request and response.
      }
      return;
    }

    if (message.type === "cloudframe-media-result") {
      const evidence = parseResult(message);
      const sessionId = message.sessionId;
      const source = messageTarget(event.source);
      if (typeof sessionId !== "string") return;
      const live = grants.get(sessionId);
      if (!evidence || !live || !source || !live.workers.has(source)) return;
      const expected = evidenceBySession.get(sessionId) ?? noneEvidence("google-raw");
      if (evidence.attempt !== expected.attempt) return;
      evidenceBySession.set(sessionId, evidence);
      resolveEvidenceWaiters(sessionId, evidence);
    }
  }

  function findGrant(kind: "fingerprint" | "session", value: string): LiveGrant | null {
    if (kind === "session") return grants.get(value) ?? null;
    for (const live of grants.values()) {
      if (live.grant.fingerprint === value) return live;
    }
    return null;
  }

  function expireGrants(): void {
    const timestamp = now();
    for (const [sessionId, live] of grants) {
      if (live.grant.expiresAtEpoch <= timestamp) {
        const pendingRequestId = findPendingRequest(sessionId);
        if (pendingRequestId) {
          failPending(pendingRequestId, "GOOGLE_MEDIA_BRIDGE_CANCELLED");
          continue;
        }
        grants.delete(sessionId);
        resolveEvidenceWaiters(sessionId, noneEvidence("google-raw"));
        evidenceBySession.delete(sessionId);
        revokeWorkers(live.workers, sessionId);
      }
    }
  }

  function failPending(requestId: string, code: GoogleMediaBridgeErrorCode): void {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    cancel(entry.timer);
    removeAbort(entry);
    const live = grants.get(entry.sessionId);
    grants.delete(entry.sessionId);
    resolveEvidenceWaiters(entry.sessionId, noneEvidence("google-raw"));
    evidenceBySession.delete(entry.sessionId);
    const workers = live?.workers ?? new Set<ServiceWorker>();
    workers.add(entry.worker);
    revokeWorkers(workers, entry.sessionId);
    entry.reject(new GoogleMediaBridgeError(code));
  }

  function findPendingRequest(sessionId: string): string | null {
    for (const [requestId, entry] of pending) {
      if (entry.sessionId === sessionId) return requestId;
    }
    return null;
  }

  function removeAbort(entry: PendingGrant): void {
    if (entry.signal && entry.abort) entry.signal.removeEventListener("abort", entry.abort);
  }

  function finishEvidenceWaiter(sessionId: string, waiter: EvidenceWaiter): void {
    const waiters = evidenceWaiters.get(sessionId);
    if (!waiters?.delete(waiter)) return;
    if (waiters.size === 0) evidenceWaiters.delete(sessionId);
    waiter.resolve(evidenceBySession.get(sessionId) ?? noneEvidence("google-raw"));
  }

  function resolveEvidenceWaiters(sessionId: string, evidence: GoogleMediaDeliveryEvidence): void {
    const waiters = evidenceWaiters.get(sessionId);
    if (!waiters) return;
    evidenceWaiters.delete(sessionId);
    for (const waiter of waiters) {
      cancel(waiter.timer);
      waiter.resolve(evidence);
    }
  }

  function revokeWorkers(workers: ReadonlySet<ServiceWorker>, sessionId: string): void {
    const revoke = { type: "cloudframe-media-revoke", sessionId } satisfies GoogleMediaPageMessage;
    for (const worker of workers) {
      try {
        worker.postMessage(revoke);
      } catch {
        // Local credential disposal must not depend on worker availability.
      }
    }
  }
}

export const unavailableGoogleMediaBridge: GoogleMediaBridge = {
  prepare: async () => { throw new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_UNAVAILABLE"); },
  filenameSource: () => null,
  evidence: () => noneEvidence("google-raw"),
  waitForEvidence: async () => noneEvidence("google-raw"),
  release: () => undefined,
};

function validatePreparation(
  descriptor: GoogleBearerMediaUrlResponse,
  item: { name: string; kind: "image" | "video"; mimeType: string; size: number | null },
  now: number,
): { expiresAtEpoch: number; filename: string } | null {
  const expiresAtEpoch = Date.parse(descriptor.expiresAt);
  const filename = sanitizeMediaFilename(item.name);
  if (!isExactGoogleMediaUrl(descriptor.url) ||
    descriptor.transport !== "google-bearer" ||
    descriptor.authorization?.scheme !== "Bearer" ||
    !printableSecret(descriptor.authorization.token) ||
    descriptor.kind !== item.kind ||
    !Number.isSafeInteger(expiresAtEpoch) || expiresAtEpoch <= now ||
    new Date(expiresAtEpoch).toISOString() !== descriptor.expiresAt ||
    typeof item.name !== "string" || item.name.length < 1 || filename.length < 1 ||
    typeof item.mimeType !== "string" || item.mimeType.length > 256 ||
    !new RegExp(`^${item.kind}/[A-Za-z0-9!#$&^_.+-]+$`, "u").test(item.mimeType) ||
    (item.size !== null && (!Number.isSafeInteger(item.size) || item.size < 0))) return null;
  return { expiresAtEpoch, filename };
}

function printableSecret(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,8192}$/u.test(value);
}

function randomId(prefix: "session" | "request", crypto: Pick<Crypto, "getRandomValues">): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}_${btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "")}`;
}

async function controllingWorker(
  container: ServiceWorkerContainer,
  signal?: AbortSignal,
): Promise<ServiceWorker> {
  if (container.controller) return container.controller;
  await new Promise<void>((resolve, reject) => {
    const changed = () => {
      if (!container.controller) return;
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_CANCELLED"));
    };
    const cleanup = () => {
      container.removeEventListener("controllerchange", changed);
      signal?.removeEventListener("abort", aborted);
    };
    container.addEventListener("controllerchange", changed);
    signal?.addEventListener("abort", aborted, { once: true });
    changed();
  });
  if (!container.controller) throw new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_UNAVAILABLE");
  return container.controller;
}

function raceAbort<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(promise);
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_CANCELLED"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      value => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_CANCELLED");
}

function parseResult(value: Record<string, unknown>): GoogleMediaDeliveryEvidence | null {
  if (typeof value.sessionId !== "string" || !SESSION_ID.test(value.sessionId) ||
    (value.attempt !== "google-raw" && value.attempt !== "google-filename")) return null;
  if (value.outcome === "response") {
    if (!exactKeys(value, ["type", "sessionId", "attempt", "outcome", "status"]) ||
      typeof value.status !== "number" || !Number.isInteger(value.status) || value.status < 200 || value.status > 599) return null;
    return { attempt: value.attempt, outcome: "response", status: value.status };
  }
  if ((value.outcome === "network-error" || value.outcome === "bridge-error") &&
    exactKeys(value, ["type", "sessionId", "attempt", "outcome"])) {
    return { attempt: value.attempt, outcome: value.outcome };
  }
  return null;
}

function validLookup(value: unknown): value is { kind: "fingerprint" | "session"; value: string } {
  return plainRecord(value) && exactKeys(value, ["kind", "value"]) &&
    typeof value.value === "string" &&
    ((value.kind === "fingerprint" && FINGERPRINT.test(value.value)) ||
      (value.kind === "session" && SESSION_ID.test(value.value)));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor && descriptor.get === undefined && descriptor.set === undefined;
  });
}

function sameWorker(source: MessageEventSource | null, worker: ServiceWorker): boolean {
  return messageTarget(source) === worker;
}

function messageTarget(source: MessageEventSource | null): ServiceWorker | null {
  return source && "postMessage" in source && typeof source.postMessage === "function"
    ? source as ServiceWorker
    : null;
}

function noneEvidence(attempt: GoogleMediaSourceKind): GoogleMediaDeliveryEvidence {
  return { attempt, outcome: "none" };
}

function defaultServiceWorker(): ServiceWorkerContainer | undefined {
  try {
    return typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(code: GoogleMediaBridgeErrorCode): string {
  switch (code) {
    case "GOOGLE_MEDIA_BRIDGE_TIMEOUT": return "Google media bridge timed out";
    case "GOOGLE_MEDIA_BRIDGE_CANCELLED": return "Google media bridge was cancelled";
    case "GOOGLE_MEDIA_BRIDGE_INVALID": return "Google media source is invalid";
    default: return "Google media bridge is unavailable";
  }
}
