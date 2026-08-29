import {
  validSingleRange,
  type GoogleMediaGrant,
  type GoogleMediaPageMessage,
  type GoogleMediaWorkerMessage,
  type ParsedSingleRange,
} from "./google-media-protocol";

const MAX_GRANTS = 4;
const MAX_MESSAGE_MUTATIONS = 32;
const REHYDRATION_TIMEOUT_MS = 500;
const SESSION_ID = /^session_[A-Za-z0-9_-]{1,128}$/u;
const REQUEST_ID = /^request_[A-Za-z0-9_-]{1,128}$/u;
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/u;
const RESPONSE_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
] as const;

interface GoogleMediaWorkerClient {
  readonly id: string;
  postMessage(message: GoogleMediaWorkerMessage): void;
}

interface GoogleMediaExtendableEvent {
  waitUntil(value: Promise<unknown>): void;
}

interface GoogleMediaMessageEvent extends GoogleMediaExtendableEvent {
  readonly data: unknown;
  readonly source: GoogleMediaWorkerClient | null;
}

interface GoogleMediaFetchEvent extends GoogleMediaExtendableEvent {
  readonly request: Request;
  readonly clientId: string;
  respondWith(value: Promise<Response> | Response): void;
}

export interface GoogleMediaWorkerScope {
  readonly location: { readonly origin: string };
  readonly clients: {
    claim(): Promise<void>;
    get(id: string): Promise<GoogleMediaWorkerClient | undefined>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: GoogleMediaExtendableEvent) => void): void;
  addEventListener(type: "message", listener: (event: GoogleMediaMessageEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: GoogleMediaFetchEvent) => void): void;
}

interface BoundGrant {
  grant: GoogleMediaGrant;
  clientId: string;
}

interface PendingGrant {
  clientId: string;
  lookup: { kind: "fingerprint"; value: string };
  resolve(value: BoundGrant | null): void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

interface MessageMutation {
  key: string;
  stamp: object;
}

interface RuntimeDependencies {
  fetch: typeof globalThis.fetch;
  now: () => number;
  fingerprint: (url: string) => Promise<string>;
  isAllowedMediaUrl: (url: string) => boolean;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

export function installGoogleMediaWorker(
  scope: GoogleMediaWorkerScope,
  dependencies: RuntimeDependencies,
): void {
  const grants = new Map<string, BoundGrant>();
  const pending = new Map<string, PendingGrant>();
  const messageMutations = new Map<string, object>();
  let requestSequence = 0;

  scope.addEventListener("install", event => {
    event.waitUntil(scope.skipWaiting());
  });
  scope.addEventListener("activate", event => {
    event.waitUntil(scope.clients.claim());
  });
  scope.addEventListener("message", event => {
    event.waitUntil(handleMessage(event));
  });
  scope.addEventListener("fetch", event => {
    const raw = allowedRawUrl(event.request.url);
    if (raw === null) return;
    event.respondWith(handleFetch(event, raw));
  });

  function allowedRawUrl(value: string): string | null {
    try {
      return dependencies.isAllowedMediaUrl(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function handleMessage(event: GoogleMediaMessageEvent): Promise<void> {
    const source = validClient(event.source);
    if (!source) return;
    const message = decodePageMessage(event.data);
    if (!message) return;
    if (message.type === "cloudframe-media-revoke") {
      advanceMessageMutation(source.id, message.sessionId);
      const existing = grants.get(message.sessionId);
      if (existing?.clientId === source.id) grants.delete(message.sessionId);
      return;
    }

    const waiting = pending.get(message.requestId);
    if (waiting && (
      waiting.clientId !== source.id ||
      waiting.lookup.value !== message.grant.fingerprint
    )) return;
    const mutation = advanceMessageMutation(source.id, message.grant.sessionId);
    if (!await validGrantFingerprint(message.grant)) return;
    if (!isCurrentMessageMutation(mutation)) return;
    const existing = grants.get(message.grant.sessionId);
    if (existing && existing.clientId !== source.id) return;

    const bound = { grant: message.grant, clientId: source.id };
    storeGrant(bound);
    source.postMessage({
      type: "cloudframe-media-grant-ack",
      requestId: message.requestId,
      sessionId: message.grant.sessionId,
    });
    if (waiting) {
      dependencies.clearTimeout(waiting.timer);
      pending.delete(message.requestId);
      waiting.resolve(bound);
    }
  }

  function decodePageMessage(value: unknown): GoogleMediaPageMessage | null {
    if (!plainDataRecord(value)) return null;
    if (value.type === "cloudframe-media-revoke") {
      if (!exactRecord(value, ["type", "sessionId"]) || !validSessionId(value.sessionId)) return null;
      return { type: "cloudframe-media-revoke", sessionId: value.sessionId };
    }
    if (
      value.type !== "cloudframe-media-grant" ||
      !exactRecord(value, ["type", "requestId", "grant"]) ||
      !validRequestId(value.requestId)
    ) return null;
    const grant = decodeGrant(value.grant);
    return grant ? { type: "cloudframe-media-grant", requestId: value.requestId, grant } : null;
  }

  function decodeGrant(value: unknown): GoogleMediaGrant | null {
    if (!exactRecord(value, [
      "sessionId",
      "rawUrl",
      "fingerprint",
      "token",
      "expiresAtEpoch",
      "kind",
      "mimeType",
      "size",
    ])) return null;
    const expiresAtEpoch = value.expiresAtEpoch;
    const size = value.size;
    if (
      !validSessionId(value.sessionId) ||
      typeof value.rawUrl !== "string" ||
      !allowedRawUrl(value.rawUrl) ||
      typeof value.fingerprint !== "string" ||
      !FINGERPRINT.test(value.fingerprint) ||
      typeof value.token !== "string" ||
      value.token.length < 1 || value.token.length > 8192 ||
      !isVisibleAscii(value.token) ||
      (value.kind !== "image" && value.kind !== "video") ||
      typeof value.mimeType !== "string" ||
      value.mimeType.length < 3 || value.mimeType.length > 256 ||
      !/^(?:image|video)\/[A-Za-z0-9!#$&^_.+-]+$/u.test(value.mimeType) ||
      !value.mimeType.startsWith(`${value.kind}/`) ||
      typeof expiresAtEpoch !== "number" ||
      !Number.isSafeInteger(expiresAtEpoch) ||
      expiresAtEpoch <= dependencies.now() ||
      (size !== null && (
        typeof size !== "number" || !Number.isSafeInteger(size) || size < 0
      ))
    ) return null;
    return {
      sessionId: value.sessionId,
      rawUrl: value.rawUrl,
      fingerprint: value.fingerprint,
      token: value.token,
      expiresAtEpoch,
      kind: value.kind,
      mimeType: value.mimeType,
      size,
    };
  }

  async function validGrantFingerprint(grant: GoogleMediaGrant): Promise<boolean> {
    let fingerprint: string;
    try {
      fingerprint = await dependencies.fingerprint(grant.rawUrl);
    } catch {
      return false;
    }
    return fingerprint === grant.fingerprint;
  }

  function advanceMessageMutation(clientId: string, sessionId: string): MessageMutation {
    const key = messageMutationKey(clientId, sessionId);
    const stamp = {};
    // A missing stamp is also stale: bounded pruning must fail old continuations closed.
    messageMutations.delete(key);
    messageMutations.set(key, stamp);
    while (messageMutations.size > MAX_MESSAGE_MUTATIONS) {
      const oldest = messageMutations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      messageMutations.delete(oldest);
    }
    return { key, stamp };
  }

  function isCurrentMessageMutation(mutation: MessageMutation): boolean {
    return messageMutations.get(mutation.key) === mutation.stamp;
  }

  function storeGrant(bound: BoundGrant): void {
    pruneExpired();
    grants.delete(bound.grant.sessionId);
    grants.set(bound.grant.sessionId, bound);
    while (grants.size > MAX_GRANTS) {
      const oldest = grants.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      grants.delete(oldest);
    }
  }

  function pruneExpired(): void {
    const now = dependencies.now();
    for (const [sessionId, bound] of grants) {
      if (bound.grant.expiresAtEpoch <= now) grants.delete(sessionId);
    }
  }

  async function handleFetch(
    event: GoogleMediaFetchEvent,
    rawUrl: string,
  ): Promise<Response> {
    const client = await fetchClient(event.clientId);
    if (!client) return Response.error();
    pruneExpired();

    let bound = findRawGrant(rawUrl, client.id);
    const conflicting = hasRawGrantForAnotherClient(rawUrl, client.id);
    if (!bound && conflicting) return Response.error();

    if (!bound) {
      let lookup: { kind: "fingerprint"; value: string };
      try {
        lookup = { kind: "fingerprint", value: await dependencies.fingerprint(rawUrl) };
      } catch {
        return Response.error();
      }
      bound = await requestGrant(client, lookup);
      if (!bound) return Response.error();
      bound = findRawGrant(rawUrl, client.id);
      if (!bound) return Response.error();
    }

    const attempt = "google-raw" as const;
    if (event.request.method !== "GET" && event.request.method !== "HEAD") {
      postResult(client, bound.grant.sessionId, attempt, "bridge-error");
      return Response.error();
    }
    const requestedRange = event.request.headers.get("range");
    const range = validSingleRange(requestedRange);
    if (requestedRange !== null && range === null) {
      postResult(client, bound.grant.sessionId, attempt, "bridge-error");
      return Response.error();
    }

    const headers = new Headers();
    headers.set("authorization", `Bearer ${bound.grant.token}`);
    if (range) headers.set("range", range.header);

    let upstream: Response;
    try {
      const providerRequest = new Request(bound.grant.rawUrl, {
        method: event.request.method,
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
        referrer: "",
        referrerPolicy: "no-referrer",
        headers,
      });
      upstream = await dependencies.fetch(providerRequest);
    } catch {
      postResult(client, bound.grant.sessionId, attempt, "network-error");
      return Response.error();
    }

    try {
      const response = rebuildResponse(upstream, range, bound.grant.size);
      if (!response) {
        cancelBody(upstream.body);
        postResult(client, bound.grant.sessionId, attempt, "bridge-error");
        return Response.error();
      }
      postResult(client, bound.grant.sessionId, attempt, "response", response.status);
      return response;
    } catch {
      cancelBody(upstream.body);
      postResult(client, bound.grant.sessionId, attempt, "bridge-error");
      return Response.error();
    }
  }

  function findRawGrant(rawUrl: string, clientId: string): BoundGrant | null {
    for (const bound of grants.values()) {
      if (bound.clientId === clientId && bound.grant.rawUrl === rawUrl) return bound;
    }
    return null;
  }

  function hasRawGrantForAnotherClient(rawUrl: string, clientId: string): boolean {
    for (const bound of grants.values()) {
      if (bound.clientId !== clientId && bound.grant.rawUrl === rawUrl) return true;
    }
    return false;
  }

  function requestGrant(
    client: GoogleMediaWorkerClient,
    lookup: { kind: "fingerprint"; value: string },
  ): Promise<BoundGrant | null> {
    requestSequence += 1;
    const requestId = `request_worker_${requestSequence}`;
    return new Promise(resolve => {
      const timer = dependencies.setTimeout(() => {
        pending.delete(requestId);
        resolve(null);
      }, REHYDRATION_TIMEOUT_MS);
      pending.set(requestId, { clientId: client.id, lookup, resolve, timer });
      client.postMessage({
        type: "cloudframe-media-grant-request",
        requestId,
        lookup: { kind: lookup.kind, value: lookup.value },
      });
    });
  }

  async function fetchClient(clientId: string): Promise<GoogleMediaWorkerClient | null> {
    if (!validClientId(clientId)) return null;
    try {
      return validClient(await scope.clients.get(clientId));
    } catch {
      return null;
    }
  }
}

function messageMutationKey(clientId: string, sessionId: string): string {
  return `${clientId.length}:${clientId}${sessionId}`;
}

function rebuildResponse(
  upstream: Response,
  range: ParsedSingleRange | null,
  size: number | null,
): Response | null {
  if (upstream.status < 200 || upstream.status > 599) return null;
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    if (upstream.status === 206 && (name === "content-length" || name === "content-range")) continue;
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (upstream.status === 206) {
    const metadata = partialResponseMetadata(
      range,
      size,
      upstream.headers.get("content-range"),
      upstream.headers.get("content-length"),
    );
    if (!metadata) return null;
    headers.set("content-range", metadata.contentRange);
    headers.set("content-length", metadata.contentLength);
    if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  }
  const body = upstream.status === 204 || upstream.status === 205 || upstream.status === 304
    ? null
    : upstream.body;
  return new Response(body, {
    status: upstream.status,
    headers,
  });
}

function partialResponseMetadata(
  range: ParsedSingleRange | null,
  knownSize: number | null,
  visibleContentRange: string | null,
  visibleContentLength: string | null,
): { contentRange: string; contentLength: string } | null {
  if (!range) return null;
  const parsedContentRange = visibleContentRange === null
    ? null
    : parseContentRange(visibleContentRange);
  if (visibleContentRange !== null && !parsedContentRange) return null;
  if (
    parsedContentRange && knownSize !== null &&
    parsedContentRange.size !== knownSize
  ) return null;
  const size = parsedContentRange?.size ?? knownSize;
  const interval = concreteInterval(range, size);
  if (!interval) return null;
  if (
    parsedContentRange && (
      parsedContentRange.start !== interval.start ||
      parsedContentRange.end !== interval.end ||
      parsedContentRange.size !== interval.size
    )
  ) return null;
  const parsedContentLength = visibleContentLength === null
    ? null
    : parseDecimalInteger(visibleContentLength);
  if (
    visibleContentLength !== null &&
    (parsedContentLength === null || parsedContentLength !== interval.length)
  ) return null;
  return {
    contentRange: visibleContentRange ??
      `bytes ${interval.start}-${interval.end}/${interval.size}`,
    contentLength: visibleContentLength ?? String(interval.length),
  };
}

function parseContentRange(
  value: string,
): { start: number; end: number; size: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value);
  if (!match) return null;
  const start = parseDecimalInteger(match[1]!);
  const end = parseDecimalInteger(match[2]!);
  const size = parseDecimalInteger(match[3]!);
  return start !== null && end !== null && size !== null &&
    start <= end && end < size
    ? { start, end, size }
    : null;
}

function parseDecimalInteger(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === value
    ? parsed
    : null;
}

function concreteInterval(
  range: ParsedSingleRange | null,
  size: number | null,
): { start: number; end: number; size: number; length: number } | null {
  if (!range || size === null || !Number.isSafeInteger(size) || size <= 0) return null;
  if (range.suffixLength !== null) {
    const length = Math.min(range.suffixLength, size);
    return { start: size - length, end: size - 1, size, length };
  }
  if (range.start === null || range.start >= size) return null;
  const end = range.end === null ? size - 1 : Math.min(range.end, size - 1);
  if (end < range.start) return null;
  return { start: range.start, end, size, length: end - range.start + 1 };
}

function postResult(
  client: GoogleMediaWorkerClient,
  sessionId: string,
  attempt: "google-raw",
  outcome: "response" | "network-error" | "bridge-error",
  status?: number,
): void {
  const message: GoogleMediaWorkerMessage = status === undefined
    ? { type: "cloudframe-media-result", sessionId, attempt, outcome }
    : { type: "cloudframe-media-result", sessionId, attempt, outcome, status };
  client.postMessage(message);
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body) void body.cancel().catch(() => undefined);
}

function validClient(value: GoogleMediaWorkerClient | null | undefined): GoogleMediaWorkerClient | null {
  return value && validClientId(value.id) && typeof value.postMessage === "function" ? value : null;
}

function validClientId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 1024 && !hasControlCharacters(value);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plainDataRecord(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.indexOf(key) >= 0);
}

function plainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor || !descriptor.enumerable || !("value" in descriptor) ||
      descriptor.get !== undefined || descriptor.set !== undefined
    ) return false;
  }
  return true;
}

function isVisibleAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 33 || code > 126) return false;
  }
  return true;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
