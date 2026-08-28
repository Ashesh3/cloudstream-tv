import type {
  ApiError,
  ControlDeviceDto,
  ControlHouseholdDto,
  ControlRequestDto,
  DirectMediaUrlResponse,
  DirectThumbnailItem,
  MediaOrder,
  TvBootstrapResponse,
  TvBrowseItemDto,
  TvFolderPageResponse,
  TvRootDto
} from "@cloudframe/shared";

export interface TvHomeResponse {
  roots: TvRootDto[];
}

export interface TvApi {
  bootstrap(): Promise<TvBootstrapResponse>;
  createDeviceRequest(name: string): Promise<{ request: ControlRequestDto }>;
  requestStatus(): Promise<TvBootstrapResponse>;
  home(): Promise<TvHomeResponse>;
  folder(handle: string, cursor?: string | null): Promise<TvFolderPageResponse>;
  thumbnailUrls(handles: string[], signal?: AbortSignal): Promise<{ items: DirectThumbnailItem[] }>;
  mediaUrl(handle: string, signal?: AbortSignal, expected?: { itemId: string; kind: "image" | "video" }): Promise<DirectMediaUrlResponse>;
}

export class TvApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "TvApiError";
  }
}

type Decoder<T> = (value: unknown) => T | null;

async function request<T>(path: string, decoder: Decoder<T>, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers
      }
    });
  } catch {
    throw new TvApiError(0, "NETWORK_ERROR", "Cloudframe could not reach the server.");
  }
  const payload = await safeJson(response);
  if (!response.ok) throw normalizeError(payload, response.status);
  try {
    if (!exactRecord(payload, ["ok", "data"]) || payload.ok !== true) throw new Error("INVALID_RESPONSE");
    const decoded = decoder(payload.data);
    if (decoded === null) throw new Error("INVALID_RESPONSE");
    return decoded;
  } catch {
    throw invalidResponse(response.status);
  }
}

export const tvApi: TvApi = {
  bootstrap: () => request("/api/bootstrap", decodeBootstrap),
  createDeviceRequest: name => request("/api/device-requests", decodeCreateRequest, {
    method: "POST",
    body: JSON.stringify({ name })
  }),
  requestStatus: () => request("/api/device-requests/status", decodeBootstrap),
  home: () => request("/api/tv/home", decodeHome),
  folder: (handle, cursor) => {
    const query = cursor !== undefined && cursor !== null
      ? `?cursor=${encodeURIComponent(cursor)}`
      : "";
    return request(`/api/tv/folders/${encodeURIComponent(handle)}${query}`, decodeFolder);
  },
  thumbnailUrls: (handles, signal) => request("/api/tv/thumbnail-urls", decodeThumbnails, {
    method: "POST",
    body: JSON.stringify({ handles, maxDimension: 720 }),
    signal
  }),
  mediaUrl: (handle, signal, expected) => request("/api/tv/media-url", value => decodeMedia(value, expected), {
    method: "POST",
    body: JSON.stringify({ handle }),
    signal
  })
};

function decodeBootstrap(value: unknown): TvBootstrapResponse | null {
  if (!exactRecord(value, ["enrollment"])) return null;
  const enrollment = value.enrollment;
  if (!plainDataRecord(enrollment) || typeof enrollment.state !== "string") return null;
  if (["requests-disabled", "unenrolled", "denied", "expired", "revoked"].includes(enrollment.state)) {
    return exactRecord(enrollment, ["state"])
      ? { enrollment: { state: enrollment.state as "requests-disabled" | "unenrolled" | "denied" | "expired" | "revoked" } }
      : null;
  }
  if (enrollment.state === "pending" && exactRecord(enrollment, ["state", "request"])) {
    const request = decodeControlRequest(enrollment.request);
    return request ? { enrollment: { state: "pending", request } } : null;
  }
  if (enrollment.state === "ready" && exactRecord(enrollment, ["state", "device", "household"])) {
    const device = decodeControlDevice(enrollment.device);
    const household = decodeControlHousehold(enrollment.household);
    return device && household ? { enrollment: { state: "ready", device, household } } : null;
  }
  return null;
}

function decodeCreateRequest(value: unknown): { request: ControlRequestDto } | null {
  if (!exactRecord(value, ["request"])) return null;
  const request = decodeControlRequest(value.request);
  return request ? { request } : null;
}

function decodeHome(value: unknown): TvHomeResponse | null {
  if (!exactRecord(value, ["roots"]) || !ordinaryArray(value.roots, 32)) return null;
  const roots: TvRootDto[] = [];
  for (const raw of value.roots) {
    const root = decodeRoot(raw);
    if (!root) return null;
    roots.push(root);
  }
  return { roots };
}

function decodeFolder(value: unknown): TvFolderPageResponse | null {
  if (!exactRecord(value, ["parent", "children", "nextCursor"]) || !ordinaryArray(value.children, 100)) return null;
  const parent = decodeBrowseItem(value.parent);
  if (!parent || parent.kind !== "folder") return null;
  const children: TvBrowseItemDto[] = [];
  for (const raw of value.children) {
    const child = decodeBrowseItem(raw);
    if (!child) return null;
    children.push(child);
  }
  const nextCursor = value.nextCursor === null ? null : validOpaque(value.nextCursor, 4096);
  return nextCursor !== null || value.nextCursor === null ? { parent, children, nextCursor } : null;
}

function decodeThumbnails(value: unknown): { items: DirectThumbnailItem[] } | null {
  if (!exactRecord(value, ["items"]) || !ordinaryArray(value.items, 100)) return null;
  const items: DirectThumbnailItem[] = [];
  for (const raw of value.items) {
    const item = decodeThumbnail(raw);
    if (!item) return null;
    items.push(item);
  }
  return { items };
}

function decodeMedia(value: unknown, expected?: { itemId: string; kind: "image" | "video" }): DirectMediaUrlResponse | null {
  if (!exactRecord(value, ["itemId", "kind", "url", "expiresAt", "revision"])) return null;
  const itemId = validItemId(value.itemId);
  const kind = value.kind === "image" || value.kind === "video" ? value.kind : null;
  const url = validHttpsUrl(value.url);
  const expiry = futureTimestamp(value.expiresAt);
  const revision = nullableRevision(value.revision);
  return itemId && kind && (!expected || (expected.itemId === itemId && expected.kind === kind)) && url && expiry && revision.valid
    ? { itemId, kind, url, expiresAt: expiry.iso, revision: revision.value }
    : null;
}

function decodeThumbnail(value: unknown): DirectThumbnailItem | null {
  if (!plainDataRecord(value) || !validItemId(value.itemId)) return null;
  const itemId = value.itemId as string;
  if (value.status === "unavailable") {
    return exactRecord(value, ["itemId", "status"]) ? { itemId, status: "unavailable" } : null;
  }
  if (value.status !== "ready" || !exactRecord(value, ["itemId", "status", "url", "expiresAt", "revision"])) return null;
  const url = validHttpsUrl(value.url);
  const expiry = futureTimestamp(value.expiresAt);
  const revision = nullableRevision(value.revision);
  return url && expiry && revision.valid
    ? { itemId, status: "ready", url, expiresAt: expiry.iso, revision: revision.value }
    : null;
}

function decodeRoot(value: unknown): TvRootDto | null {
  if (!exactRecord(value, ["id", "handle", "displayName", "provider", "accountLabel"])) return null;
  const id = validItemId(value.id);
  const handle = validOpaque(value.handle, 8192);
  const displayName = visibleName(value.displayName);
  const provider = value.provider === "google" || value.provider === "onedrive" ? value.provider : null;
  const accountLabel = visibleName(value.accountLabel);
  return id && handle && displayName && provider && accountLabel ? { id, handle, displayName, provider, accountLabel } : null;
}

function decodeBrowseItem(value: unknown): TvBrowseItemDto | null {
  if (!exactRecord(value, [
    "id", "handle", "name", "normalizedName", "kind", "mimeType", "size", "width", "height",
    "capturedAt", "createdAtProvider", "modifiedAtProvider", "thumbnailRevision", "hasPreview"
  ])) return null;
  const id = validItemId(value.id);
  const handle = validOpaque(value.handle, 8192);
  const name = providerName(value.name);
  const normalizedName = providerNormalizedName(value.normalizedName);
  const kind = value.kind === "folder" || value.kind === "image" || value.kind === "video" ? value.kind : null;
  const mimeType = nullableString(value.mimeType, 256);
  const size = nullableNonNegative(value.size);
  const width = nullableNonNegative(value.width);
  const height = nullableNonNegative(value.height);
  const capturedAt = nullableTimestamp(value.capturedAt);
  const createdAtProvider = nullableTimestamp(value.createdAtProvider);
  const modifiedAtProvider = nullableTimestamp(value.modifiedAtProvider);
  const thumbnailRevision = nullableRevision(value.thumbnailRevision);
  if (!id || !handle || !name || normalizedName === null || !kind || !mimeType.valid || !size.valid || !width.valid || !height.valid || !capturedAt.valid || !createdAtProvider.valid || !modifiedAtProvider.valid || !thumbnailRevision.valid || typeof value.hasPreview !== "boolean") return null;
  if (kind === "folder" && (mimeType.value !== null || value.hasPreview)) return null;
  if (kind !== "folder" && (mimeType.value === null || mimeType.value.indexOf(`${kind}/`) !== 0)) return null;
  return {
    id, handle, name, normalizedName, kind, mimeType: mimeType.value, size: size.value, width: width.value,
    height: height.value, capturedAt: capturedAt.value, createdAtProvider: createdAtProvider.value,
    modifiedAtProvider: modifiedAtProvider.value, thumbnailRevision: thumbnailRevision.value, hasPreview: value.hasPreview
  };
}

function decodeControlRequest(value: unknown): ControlRequestDto | null {
  if (!exactRecord(value, ["id", "requestedName", "status", "createdAt", "expiresAt", "resolvedAt", "approvedDeviceId"])) return null;
  const id = validControlId(value.id);
  const requestedName = visibleName(value.requestedName);
  const status = ["pending", "approved", "denied", "expired"].includes(String(value.status)) ? value.status as ControlRequestDto["status"] : null;
  const createdAt = canonicalTimestamp(value.createdAt);
  const expiresAt = canonicalTimestamp(value.expiresAt);
  const resolvedAt = nullableTimestamp(value.resolvedAt);
  const approvedDeviceId = value.approvedDeviceId === null ? null : validControlId(value.approvedDeviceId);
  return id && requestedName && status && createdAt && expiresAt && resolvedAt.valid && (approvedDeviceId !== null || value.approvedDeviceId === null)
    ? { id, requestedName, status, createdAt, expiresAt, resolvedAt: resolvedAt.value, approvedDeviceId }
    : null;
}

function decodeControlDevice(value: unknown): ControlDeviceDto | null {
  if (!exactRecord(value, ["id", "name", "enabled", "assignedRootIds", "mediaOrder", "slideshowSeconds", "createdAt", "approvedAt", "revokedAt"])) return null;
  if (!ordinaryArray(value.assignedRootIds, 32)) return null;
  const assignedRootIds: string[] = [];
  for (const raw of value.assignedRootIds) {
    const id = validControlId(raw);
    if (!id) return null;
    assignedRootIds.push(id);
  }
  const id = validControlId(value.id);
  const name = visibleName(value.name);
  const mediaOrder = nullableMediaOrder(value.mediaOrder);
  const slideshowSeconds = value.slideshowSeconds === null ? null : positiveInteger(value.slideshowSeconds, 3600);
  const createdAt = canonicalTimestamp(value.createdAt);
  const approvedAt = canonicalTimestamp(value.approvedAt);
  const revokedAt = nullableTimestamp(value.revokedAt);
  return id && name && typeof value.enabled === "boolean" && mediaOrder.valid && (slideshowSeconds !== null || value.slideshowSeconds === null) && createdAt && approvedAt && revokedAt.valid
    ? { id, name, enabled: value.enabled, assignedRootIds, mediaOrder: mediaOrder.value, slideshowSeconds, createdAt, approvedAt, revokedAt: revokedAt.value }
    : null;
}

function decodeControlHousehold(value: unknown): ControlHouseholdDto | null {
  if (!exactRecord(value, ["allowNewDeviceRequests", "defaultMediaOrder", "defaultSlideshowSeconds"])) return null;
  const order = mediaOrder(value.defaultMediaOrder);
  const seconds = positiveInteger(value.defaultSlideshowSeconds, 3600);
  return typeof value.allowNewDeviceRequests === "boolean" && order && seconds !== null
    ? { allowNewDeviceRequests: value.allowNewDeviceRequests, defaultMediaOrder: order, defaultSlideshowSeconds: seconds }
    : null;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function invalidResponse(status: number): TvApiError {
  return new TvApiError(status, "INVALID_RESPONSE", "The server returned an unexpected response.");
}

function normalizeError(value: unknown, status: number): TvApiError {
  const result = value as (Partial<ApiError> & { ok?: unknown; error?: Partial<ApiError> }) | null;
  const error = result?.error ?? result;
  const code = boundedCode(error?.code) ?? "REQUEST_FAILED";
  const retryAfterSeconds = boundedRetry(error?.retryAfterSeconds);
  return new TvApiError(status, code, safeMessage(code), retryAfterSeconds);
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
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return false;
  }
  return true;
}

function ordinaryArray(value: unknown, limit: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit) return false;
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

function validItemId(value: unknown): string | null {
  return typeof value === "string" && /^item_[A-Za-z0-9_-]{1,256}$/.test(value) ? value : null;
}

function validControlId(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && value === value.trim() ? value : null;
}

function validOpaque(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength && value === value.trim() ? value : null;
}

function visibleName(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 120 && value === value.trim() ? value : null;
}

function providerName(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 1024 && !hasC0Control(value) ? value : null;
}

function providerNormalizedName(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 2048 && !hasC0Control(value) ? value : null;
}

function hasC0Control(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 31) return true;
  }
  return false;
}

function mediaOrder(value: unknown): MediaOrder | null {
  return value === "captured-desc" || value === "captured-asc" || value === "name-asc" ? value : null;
}

function nullableMediaOrder(value: unknown): { valid: boolean; value: MediaOrder | null } {
  if (value === null) return { valid: true, value: null };
  const decoded = mediaOrder(value);
  return { valid: decoded !== null, value: decoded };
}

function positiveInteger(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum ? Number(value) : null;
}

function nullableNonNegative(value: unknown): { valid: boolean; value: number | null } {
  if (value === null) return { valid: true, value: null };
  return { valid: Number.isFinite(value) && Number(value) >= 0 && Number.isSafeInteger(value), value: Number(value) };
}

function nullableString(value: unknown, maximum: number): { valid: boolean; value: string | null } {
  if (value === null) return { valid: true, value: null };
  return { valid: typeof value === "string" && value.length >= 1 && value.length <= maximum, value: typeof value === "string" ? value : null };
}

function nullableRevision(value: unknown): { valid: boolean; value: string | null } {
  return nullableString(value, 256);
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString() === value ? value : null;
}

function nullableTimestamp(value: unknown): { valid: boolean; value: string | null } {
  if (value === null) return { valid: true, value: null };
  const decoded = canonicalTimestamp(value);
  return { valid: decoded !== null, value: decoded };
}

function futureTimestamp(value: unknown): { iso: string; epoch: number } | null {
  const iso = canonicalTimestamp(value);
  if (!iso) return null;
  const epoch = Date.parse(iso);
  return epoch > Date.now() ? { iso, epoch } : null;
}

function validHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "" ? value : null;
  } catch {
    return null;
  }
}

function boundedCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
}

function boundedRetry(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 86_400 ? Number(value) : undefined;
}

function safeMessage(code: string): string {
  if (code === "DEVICE_UNAUTHORIZED") return "This TV needs to reconnect to Cloudframe.";
  if (code === "NAVIGATION_EXPIRED") return "This collection needs to be refreshed.";
  if (code === "ITEM_NOT_FOUND") return "This collection is no longer available.";
  if (code === "PROVIDER_REAUTH_REQUIRED") return "This source needs attention in Cloudframe Admin.";
  if (code === "PROVIDER_THROTTLED") return "The provider is busy. Try again shortly.";
  if (code === "NETWORK_ERROR" || code === "PROVIDER_TIMEOUT" || code === "PROVIDER_UNAVAILABLE") return "This source is temporarily unavailable.";
  return "The request could not be completed.";
}
