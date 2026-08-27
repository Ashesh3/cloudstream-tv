import type {
  ApiError,
  ApiResult,
  ControlRequestDto,
  DirectMediaUrlResponse,
  DirectThumbnailItem,
  TvBootstrapResponse,
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
  mediaUrl(handle: string, signal?: AbortSignal): Promise<DirectMediaUrlResponse>;
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  if (!response.ok || !isApiResult(payload)) {
    throw normalizeError(payload, response.status);
  }
  if (!payload.ok) throw normalizeError(payload, response.status);
  return payload.data as T;
}

export const tvApi: TvApi = {
  bootstrap: () => request("/api/bootstrap"),
  createDeviceRequest: name => request("/api/device-requests", {
    method: "POST",
    body: JSON.stringify({ name })
  }),
  requestStatus: () => request("/api/device-requests/status"),
  home: () => request("/api/tv/home"),
  folder: (handle, cursor) => {
    const query = cursor !== undefined && cursor !== null
      ? `?cursor=${encodeURIComponent(cursor)}`
      : "";
    return request(`/api/tv/folders/${encodeURIComponent(handle)}${query}`);
  },
  thumbnailUrls: (handles, signal) => request("/api/tv/thumbnail-urls", {
    method: "POST",
    body: JSON.stringify({ handles, maxDimension: 720 }),
    signal
  }),
  mediaUrl: (handle, signal) => request("/api/tv/media-url", {
    method: "POST",
    body: JSON.stringify({ handle }),
    signal
  })
};

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isApiResult(value: unknown): value is ApiResult<unknown> {
  return Boolean(value && typeof value === "object" && "ok" in value && typeof (value as { ok?: unknown }).ok === "boolean");
}

function normalizeError(value: unknown, status: number): TvApiError {
  const result = value as (Partial<ApiError> & { ok?: unknown; error?: Partial<ApiError> }) | null;
  const error = result?.error ?? result;
  const code = boundedCode(error?.code) ?? "REQUEST_FAILED";
  const retryAfterSeconds = boundedRetry(error?.retryAfterSeconds);
  return new TvApiError(status, code, safeMessage(code), retryAfterSeconds);
}

function boundedCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
}

function boundedRetry(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 86_400
    ? Number(value)
    : undefined;
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
