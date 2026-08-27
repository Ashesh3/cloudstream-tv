import type {
  ApiResult,
  BootstrapResponse,
  DeviceRequestDto,
  MediaUrlResponse,
  MediaNodeDto,
  ThumbnailUrlItem,
  TvRootCardDto
} from "@cloudframe/shared";

export interface TvHomeResponse {
  roots: TvRootCardDto[];
}

export interface TvFolderResponse {
  parent: MediaNodeDto;
  breadcrumbs: MediaNodeDto[];
  children: MediaNodeDto[];
  nextCursor: string | null;
}

export interface TvApi {
  bootstrap(): Promise<BootstrapResponse>;
  createDeviceRequest(name: string): Promise<{ request: DeviceRequestDto }>;
  requestStatus(): Promise<BootstrapResponse>;
  home(): Promise<TvHomeResponse>;
  folder(nodeId: string, cursor?: string | null): Promise<TvFolderResponse>;
  thumbnailUrls(nodeIds: string[], signal?: AbortSignal): Promise<{ items: ThumbnailUrlItem[] }>;
  mediaUrl(nodeId: string, signal?: AbortSignal): Promise<MediaUrlResponse>;
}

export class TvApiError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "TvApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  const result = await response.json() as ApiResult<T>;
  if (!result.ok) {
    throw new TvApiError(result.error.code, result.error.message, result.error.retryAfterSeconds);
  }
  return result.data;
}

export const tvApi: TvApi = {
  bootstrap: () => request("/api/bootstrap"),
  createDeviceRequest: name => request("/api/device-requests", {
    method: "POST",
    body: JSON.stringify({ name })
  }),
  requestStatus: () => request("/api/device-requests/status"),
  home: () => request("/api/tv/home"),
  folder: (nodeId, cursor) => {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return request(`/api/tv/folders/${encodeURIComponent(nodeId)}${query}`);
  },
  thumbnailUrls: (nodeIds, signal) => request("/api/tv/thumbnail-urls", {
    method: "POST",
    body: JSON.stringify({ nodeIds, maxDimension: 720 }),
    signal
  }),
  mediaUrl: (nodeId, signal) => request("/api/tv/media-url", {
    method: "POST",
    body: JSON.stringify({ nodeId }),
    signal
  })
};
