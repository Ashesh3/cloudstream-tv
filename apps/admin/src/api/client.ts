import type {
  AdminSnapshotResponse,
  ApproveDeviceRequestBody,
  ClaimInstallationBody,
  ControlDeviceDto,
  ControlHouseholdDto,
  ControlRequestDto,
  ControlRootDto,
  ControlSourceDto,
  CreateAssignedRootBody,
  MediaOrder,
  InstallationStatusResponse,
  ProviderFolderDto,
  ProviderKind,
  UpdateAdminSettingsBody,
  UpdateDeviceBody,
  TranscodeDiagnosticResponse
} from "@cloudframe/shared";
import { assertProviderAuthorizationUrl } from "@cloudframe/shared";

export interface AdminProviderFolderPage {
  source: ControlSourceDto;
  current: ProviderFolderDto;
  breadcrumbs: ProviderFolderDto[];
  folders: ProviderFolderDto[];
  nextCursor: string | null;
}

export interface AdminImpact {
  roots: ControlRootDto[];
  devices: ControlDeviceDto[];
}

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export interface AdminApi {
  installationStatus(): Promise<InstallationStatusResponse>;
  claimInstallation(body: ClaimInstallationBody): Promise<{ configured: true }>;
  login(passphrase: string): Promise<{ authenticated: true }>;
  logout(): Promise<{ authenticated: false }>;
  snapshot(): Promise<AdminSnapshotResponse>;
  transcodeStatus(signal?: AbortSignal): Promise<TranscodeDiagnosticResponse>;
  approveRequest(requestId: string, body: ApproveDeviceRequestBody): Promise<{ device: ControlDeviceDto }>;
  denyRequest(requestId: string): Promise<{ request: ControlRequestDto }>;
  updateDevice(deviceId: string, body: UpdateDeviceBody): Promise<{ device: ControlDeviceDto }>;
  revokeDevice(deviceId: string): Promise<{ revoked: true }>;
  updateSettings(body: UpdateAdminSettingsBody): Promise<{ revision: number }>;
  rotatePassphrase(currentPassphrase: string, newPassphrase: string): Promise<{ authenticated: false; revision: number }>;
  authorizeSource(provider: "google" | "onedrive", reconnectSourceId?: string): Promise<{ authorizationUrl: string }>;
  sourceImpact(sourceId: string): Promise<AdminImpact>;
  removeSource(sourceId: string): Promise<{ removed: true } & AdminImpact>;
  providerFolders(sourceId: string, input: { providerFolderId?: string; cursor?: string | null; limit?: number; signal?: AbortSignal }): Promise<AdminProviderFolderPage>;
  createRoot(sourceId: string, body: CreateAssignedRootBody): Promise<{ root: ControlRootDto }>;
  rootImpact(rootId: string): Promise<AdminImpact>;
  removeRoot(rootId: string): Promise<{ removed: true } & AdminImpact>;
}

type Fetcher = typeof fetch;
type Decoder<T> = (value: unknown) => T;
const parseJson = JSON.parse;
const MAX_ADMIN_RESPONSE_BYTES = 4 * 1024 * 1024;
const isArrayBufferView = ArrayBuffer.isView;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayName = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;

export function createAdminApi(fetcher: Fetcher = fetch): AdminApi {
  let csrfToken: string | null = null;
  let issuedRequest = 0;
  let appliedCsrfRequest = 0;

  async function request<T>(path: string, decode: Decoder<T>, init: RequestInit = {}, retryCsrf = true, requestId = ++issuedRequest): Promise<T> {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (method !== "GET" && method !== "HEAD" && csrfToken) headers.set("x-csrf-token", csrfToken);
    let response: Response;
    try {
      response = await fetcher(path, { ...init, headers, credentials: "include" });
    } catch (cause) {
      if (init.signal?.aborted) throw cause;
      throw new AdminApiError(0, "NETWORK_ERROR", "Cloudframe could not reach the server.");
    }
    let refreshed: string | null;
    try { refreshed = response.headers.get("x-csrf-token"); } catch { throw invalidResponse(response.status); }
    if (refreshed && requestId >= appliedCsrfRequest) {
      csrfToken = refreshed;
      appliedCsrfRequest = requestId;
    }
    const payload = await safeJson(response);
    if (!response.ok) {
      const error = decodeError(payload, response.status);
      if (response.status === 403 && retryCsrf && refreshed && error.code === "CSRF_INVALID" && method !== "GET" && method !== "HEAD") {
        return request(path, decode, init, false, requestId);
      }
      throw error;
    }
    try {
      const data = decodeSuccessEnvelope(payload, response.status);
      return decode(data);
    } catch {
      throw invalidResponse(response.status);
    }
  }

  const json = (value: unknown) => JSON.stringify(value);
  return {
    installationStatus: () => request("/api/setup/status", installationStatus),
    claimInstallation: body => request("/api/setup/claim", configuredTrue, { method: "POST", body: json(body) }),
    login: passphrase => request("/api/admin/login", authenticatedTrue, { method: "POST", body: json({ passphrase }) }),
    logout: () => request("/api/admin/logout", authenticatedFalse, { method: "POST", body: json({}) }),
    snapshot: () => request("/api/admin/snapshot", adminSnapshot),
    transcodeStatus: signal => request("/api/admin/transcodes/status", transcodeDiagnostic, { signal }),
    approveRequest: (id, body) => request(`/api/admin/requests/${encodeURIComponent(id)}/approve`, deviceResult, { method: "POST", body: json(body) }),
    denyRequest: id => request(`/api/admin/requests/${encodeURIComponent(id)}/deny`, requestResult, { method: "POST", body: json({}) }),
    updateDevice: (id, body) => request(`/api/admin/devices/${encodeURIComponent(id)}`, deviceResult, { method: "PATCH", body: json(body) }),
    revokeDevice: id => request(`/api/admin/devices/${encodeURIComponent(id)}`, removedFlag("revoked"), { method: "DELETE", body: json({}) }),
    updateSettings: body => request("/api/admin/settings", revisionResult, { method: "PATCH", body: json(body) }),
    rotatePassphrase: (currentPassphrase, newPassphrase) => request("/api/admin/passphrase", passphraseResult, { method: "POST", body: json({ currentPassphrase, newPassphrase }) }),
    authorizeSource: (provider, reconnectSourceId) => request(`/api/admin/sources/${provider}/authorize`, value => authorizationResult(provider, value), { method: "POST", body: json(reconnectSourceId ? { reconnectSourceId } : {}) }),
    sourceImpact: id => request(`/api/admin/sources/${encodeURIComponent(id)}/impact`, impactResult),
    removeSource: id => request(`/api/admin/sources/${encodeURIComponent(id)}`, removalResult, { method: "DELETE", body: json({ confirm: true }) }),
    providerFolders: (id, input) => {
      const query = new URLSearchParams();
      if (input.providerFolderId) query.set("providerFolderId", input.providerFolderId);
      if (input.cursor) query.set("cursor", input.cursor);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return request(`/api/admin/sources/${encodeURIComponent(id)}/provider-folders${suffix}`, providerFolderPage, { signal: input.signal });
    },
    createRoot: (id, body) => request(`/api/admin/sources/${encodeURIComponent(id)}/roots`, rootResult, { method: "POST", body: json(body) }),
    rootImpact: id => request(`/api/admin/roots/${encodeURIComponent(id)}/impact`, impactResult),
    removeRoot: id => request(`/api/admin/roots/${encodeURIComponent(id)}`, removalResult, { method: "DELETE", body: json({ confirm: true }) })
  };
}

async function safeJson(response: Response): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null;
  try {
    reader = response.body?.getReader() ?? null;
  } catch { return null; }
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try { read = await reader.read(); }
      catch { cancelReaderBestEffort(reader); return null; }
      if (read.done) break;
      const chunk = responseByteChunk(read.value);
      if (!chunk) { cancelReaderBestEffort(reader); return null; }
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_ADMIN_RESPONSE_BYTES) { cancelReaderBestEffort(reader); return null; }
      chunks.push(chunk.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* Lock release is cleanup only. */ }
  }
  if (totalBytes < 1) return null;
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      const validated = responseByteChunk(chunk);
      if (!validated || validated.byteLength > totalBytes - offset) return null;
      bytes.set(validated.value, offset);
      offset += validated.byteLength;
    }
    if (offset !== totalBytes) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseJson(text) as unknown;
  } catch { return null; }
}

function responseByteChunk(value: unknown): { value: Uint8Array; byteLength: number } | null {
  if (!isArrayBufferView(value) || !typedArrayName || !typedArrayByteLength) return null;
  try {
    if (Reflect.apply(typedArrayName, value, []) !== "Uint8Array") return null;
    const byteLength = Reflect.apply(typedArrayByteLength, value, []) as unknown;
    if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) return null;
    return { value: value as Uint8Array, byteLength };
  } catch { return null; }
}

function cancelReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    const cancellation = reader.cancel();
    if (cancellation && typeof (cancellation as PromiseLike<unknown>).then === "function") void Promise.resolve(cancellation).catch(() => undefined);
  } catch { /* Cancellation is advisory cleanup only. */ }
}

function decodeSuccessEnvelope(value: unknown, status: number): unknown {
  const record = exactRecord(value, ["ok", "data"]);
  if (record.ok !== true || !("data" in record)) throw invalidResponse(status);
  return record.data;
}

function decodeError(value: unknown, status: number): AdminApiError {
  try {
    const record = exactRecord(value, ["code", "message", "retryAfterSeconds"], ["code", "message"]);
    const code = stringValue(record.code);
    stringValue(record.message);
    const retryAfterSeconds = record.retryAfterSeconds === undefined ? undefined : nonNegativeNumber(record.retryAfterSeconds);
    return new AdminApiError(status, code, safeMessage(code, status), retryAfterSeconds);
  } catch {
    return new AdminApiError(status, "REQUEST_FAILED", safeMessage("REQUEST_FAILED", status));
  }
}

function safeMessage(code: string, status: number): string {
  const messages: Record<string, string> = {
    ADMIN_UNAUTHORIZED: "Your admin session expired. Sign in again.",
    INVALID_CREDENTIALS: "The passphrase was not accepted.",
    CSRF_INVALID: "Your admin session changed. Try again.",
    ORIGIN_INVALID: "This admin request was blocked.",
    RATE_LIMITED: "Too many requests. Wait a moment and try again.",
    DEVICE_STALE: "That device changed. The household ledger will refresh.",
    DEVICE_NOT_FOUND: "That device is no longer available.",
    DEVICE_REQUEST_RESOLVED: "That device request was already resolved.",
    SOURCE_NOT_FOUND: "That source is no longer available.",
    ROOT_NOT_FOUND: "That folder is no longer available.",
    PROVIDER_REAUTH_REQUIRED: "Reauthorization required.",
    PROVIDER_UNAVAILABLE: "Provider temporarily unavailable. Try again.",
    PROVIDER_TIMEOUT: "Provider temporarily unavailable. Try again."
  };
  return messages[code] ?? (status >= 500 ? "Cloudframe is temporarily unavailable. Try again." : "The request could not be completed.");
}

function invalidResponse(status: number) {
  return new AdminApiError(status, "INVALID_RESPONSE", "The server returned an unexpected response.");
}

function exactRecord(value: unknown, allowed: string[], required = allowed): Record<string, unknown> {
  if (!plainDataRecord(value)) throw new Error("record");
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || !allowed.includes(key)) || required.some(key => !keys.includes(key))) throw new Error("keys");
  return value;
}
function plainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return false;
  }
  return true;
}
const stringValue = (value: unknown) => { if (typeof value !== "string") throw new Error("string"); return value; };
const boundedString = (value: unknown, minimum: number, maximum: number) => { const result = stringValue(value); if (result.length < minimum || result.length > maximum) throw new Error("string bounds"); return result; };
const booleanValue = (value: unknown) => { if (typeof value !== "boolean") throw new Error("boolean"); return value; };
const nonNegativeNumber = (value: unknown) => { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("number"); return value; };
const boundedNumber = (value: unknown, minimum: number, maximum: number) => { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error("number bounds"); return value; };
const integerValue = (value: unknown) => { const number = nonNegativeNumber(value); if (!Number.isSafeInteger(number)) throw new Error("integer"); return number; };
const nullableString = (value: unknown) => value === null ? null : stringValue(value);
const arrayOf = <T,>(value: unknown, decode: Decoder<T>) => { if (!ordinaryArray(value)) throw new Error("array"); return value.map(decode); };
function ordinaryArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys[keys.length - 1] !== "length") return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || lengthDescriptor.enumerable || !("value" in lengthDescriptor)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return false;
  }
  return true;
}
const enumValue = <T extends string>(value: unknown, allowed: readonly T[]): T => { if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error("enum"); return value as T; };

function authenticatedTrue(value: unknown) { const record = exactRecord(value, ["authenticated"]); if (record.authenticated !== true) throw new Error("auth"); return { authenticated: true as const }; }
function authenticatedFalse(value: unknown) { const record = exactRecord(value, ["authenticated"]); if (record.authenticated !== false) throw new Error("auth"); return { authenticated: false as const }; }
function installationStatus(value: unknown): InstallationStatusResponse { const record = exactRecord(value, ["state"]); return { state: enumValue(record.state, ["unconfigured", "configured"] as const) }; }
function configuredTrue(value: unknown) { const record = exactRecord(value, ["configured"]); if (record.configured !== true) throw new Error("configured"); return { configured: true as const }; }
function revisionResult(value: unknown) { const record = exactRecord(value, ["revision"]); return { revision: integerValue(record.revision) }; }
function passphraseResult(value: unknown) { const record = exactRecord(value, ["authenticated", "revision"]); if (record.authenticated !== false) throw new Error("auth"); return { authenticated: false as const, revision: integerValue(record.revision) }; }
function removedFlag<K extends "revoked">(key: K) { return (value: unknown) => { const record = exactRecord(value, [key]); if (record[key] !== true) throw new Error(key); return { [key]: true } as Record<K, true>; }; }
function authorizationResult(provider: ProviderKind, value: unknown) { const record = exactRecord(value, ["authorizationUrl"]); return { authorizationUrl: assertProviderAuthorizationUrl(provider, stringValue(record.authorizationUrl)) }; }

function household(value: unknown): ControlHouseholdDto {
  const record = exactRecord(value, ["allowNewDeviceRequests", "defaultMediaOrder", "defaultSlideshowSeconds"]);
  return { allowNewDeviceRequests: booleanValue(record.allowNewDeviceRequests), defaultMediaOrder: mediaOrder(record.defaultMediaOrder), defaultSlideshowSeconds: integerValue(record.defaultSlideshowSeconds) };
}
function mediaOrder(value: unknown): MediaOrder { return enumValue(value, ["captured-desc", "captured-asc", "name-asc"] as const); }
function requestDto(value: unknown): ControlRequestDto {
  const record = exactRecord(value, ["id", "requestedName", "status", "createdAt", "expiresAt", "resolvedAt", "approvedDeviceId"]);
  return { id: stringValue(record.id), requestedName: stringValue(record.requestedName), status: enumValue(record.status, ["pending", "approved", "denied", "expired"] as const), createdAt: stringValue(record.createdAt), expiresAt: stringValue(record.expiresAt), resolvedAt: nullableString(record.resolvedAt), approvedDeviceId: nullableString(record.approvedDeviceId) };
}
function deviceDto(value: unknown): ControlDeviceDto {
  const record = exactRecord(value, ["id", "name", "enabled", "assignedRootIds", "mediaOrder", "slideshowSeconds", "createdAt", "approvedAt", "revokedAt"]);
  return { id: stringValue(record.id), name: stringValue(record.name), enabled: booleanValue(record.enabled), assignedRootIds: arrayOf(record.assignedRootIds, stringValue), mediaOrder: record.mediaOrder === null ? null : mediaOrder(record.mediaOrder), slideshowSeconds: record.slideshowSeconds === null ? null : integerValue(record.slideshowSeconds), createdAt: stringValue(record.createdAt), approvedAt: stringValue(record.approvedAt), revokedAt: nullableString(record.revokedAt) };
}
function sourceDto(value: unknown): ControlSourceDto {
  const record = exactRecord(value, ["id", "provider", "accountLabel", "status", "createdAt"]);
  return { id: stringValue(record.id), provider: enumValue(record.provider, ["google", "onedrive"] as const), accountLabel: stringValue(record.accountLabel), status: enumValue(record.status, ["healthy", "reauth-required", "disabled"] as const), createdAt: stringValue(record.createdAt) };
}
function rootDto(value: unknown): ControlRootDto {
  const record = exactRecord(value, ["id", "sourceId", "displayName", "enabled", "createdAt"]);
  return { id: stringValue(record.id), sourceId: stringValue(record.sourceId), displayName: stringValue(record.displayName), enabled: booleanValue(record.enabled), createdAt: stringValue(record.createdAt) };
}
function providerFolder(value: unknown): ProviderFolderDto {
  const record = exactRecord(value, ["providerNodeId", "parentProviderId", "name", "assignedRootId"]);
  return { providerNodeId: stringValue(record.providerNodeId), parentProviderId: nullableString(record.parentProviderId), name: stringValue(record.name), assignedRootId: nullableString(record.assignedRootId) };
}
function localStorage(value: unknown): AdminSnapshotResponse["storage"] {
  const record = exactRecord(value, ["mode", "revision"]);
  if (record.mode !== "local") throw new Error("storage");
  return { mode: "local", revision: integerValue(record.revision) };
}
function adminSnapshot(value: unknown): AdminSnapshotResponse {
  const record = exactRecord(value, ["revision", "household", "pendingRequests", "devices", "sources", "roots", "storage"]);
  const revision = integerValue(record.revision);
  const storage = localStorage(record.storage);
  if (storage.revision !== revision) throw new Error("storage");
  return { revision, household: household(record.household), pendingRequests: arrayOf(record.pendingRequests, requestDto), devices: arrayOf(record.devices, deviceDto), sources: arrayOf(record.sources, sourceDto), roots: arrayOf(record.roots, rootDto), storage };
}
function transcodeDiagnostic(value: unknown): TranscodeDiagnosticResponse {
  const record = exactRecord(value, ["active", "leaseDeviceName", "queuedDemandedWindows", "busyRejections", "cacheBytes", "cacheMaxBytes", "lastErrorCode"]);
  const active = record.active === null ? null : (() => {
    const current = exactRecord(record.active, ["itemName", "provider", "stage", "windowIndex", "progressPercent", "speed"]);
    const itemName = boundedString(current.itemName, 1, 512);
    const windowIndex = current.windowIndex === null ? null : integerValue(current.windowIndex);
    const progressPercent = current.progressPercent === null ? null : boundedNumber(current.progressPercent, 0, 100);
    const speed = current.speed === null ? null : boundedString(current.speed, 1, 64);
    return { itemName, provider: enumValue(current.provider, ["google", "onedrive"] as const), stage: enumValue(current.stage, ["probing", "encoding"] as const), windowIndex, progressPercent, speed };
  })();
  const lastErrorCode = record.lastErrorCode === null ? null : boundedString(record.lastErrorCode, 1, 64);
  if (lastErrorCode !== null && !/^[A-Z][A-Z0-9_]*$/u.test(lastErrorCode)) throw new Error("error code");
  return {
    active,
    leaseDeviceName: record.leaseDeviceName === null ? null : boundedString(record.leaseDeviceName, 1, 256),
    queuedDemandedWindows: integerValue(record.queuedDemandedWindows),
    busyRejections: integerValue(record.busyRejections),
    cacheBytes: integerValue(record.cacheBytes),
    cacheMaxBytes: integerValue(record.cacheMaxBytes),
    lastErrorCode,
  };
}
function deviceResult(value: unknown) { const record = exactRecord(value, ["device"]); return { device: deviceDto(record.device) }; }
function requestResult(value: unknown) { const record = exactRecord(value, ["request"]); return { request: requestDto(record.request) }; }
function rootResult(value: unknown) { const record = exactRecord(value, ["root"]); return { root: rootDto(record.root) }; }
function impactResult(value: unknown): AdminImpact { const record = exactRecord(value, ["roots", "devices"]); return { roots: arrayOf(record.roots, rootDto), devices: arrayOf(record.devices, deviceDto) }; }
function removalResult(value: unknown) { const record = exactRecord(value, ["removed", "roots", "devices"]); if (record.removed !== true) throw new Error("removed"); return { removed: true as const, roots: arrayOf(record.roots, rootDto), devices: arrayOf(record.devices, deviceDto) }; }
function providerFolderPage(value: unknown): AdminProviderFolderPage {
  const record = exactRecord(value, ["source", "current", "breadcrumbs", "folders", "nextCursor"]);
  return { source: sourceDto(record.source), current: providerFolder(record.current), breadcrumbs: arrayOf(record.breadcrumbs, providerFolder), folders: arrayOf(record.folders, providerFolder), nextCursor: nullableString(record.nextCursor) };
}
