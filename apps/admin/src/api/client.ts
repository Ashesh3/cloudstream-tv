import type {
  AdminFolderTreeResponse,
  AdminOverviewResponse,
  AdminProviderFolderPageResponse,
  AdminSettingsResponse,
  ApiError,
  ApiResult,
  ApproveDeviceRequestBody,
  AssignedRootDto,
  CreateAssignedRootBody,
  DeviceDto,
  DeviceRequestDto,
  SourceDto,
  SourceImpactResponse,
  ThumbnailUrlItem,
  UpdateAdminSettingsBody,
  UpdateDeviceBody
} from "@cloudframe/shared";

export type AdminSource = SourceDto & { roots: AssignedRootDto[] };

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
  login(passphrase: string): Promise<{ authenticated: true }>;
  logout(): Promise<{ authenticated: false }>;
  overview(): Promise<AdminOverviewResponse>;
  approveRequest(requestId: string, body: ApproveDeviceRequestBody): Promise<{ device: DeviceDto }>;
  denyRequest(requestId: string): Promise<{ request: DeviceRequestDto }>;
  updateDevice(deviceId: string, body: UpdateDeviceBody): Promise<{ device: DeviceDto }>;
  revokeDevice(deviceId: string): Promise<{ revoked: true }>;
  settings(): Promise<AdminSettingsResponse>;
  updateSettings(body: UpdateAdminSettingsBody): Promise<AdminSettingsResponse>;
  rotatePassphrase(currentPassphrase: string, newPassphrase: string): Promise<{ authenticated: false }>;
  sources(): Promise<{ sources: AdminSource[] }>;
  authorizeSource(provider: "google" | "onedrive", reconnectSourceId?: string): Promise<{ authorizationUrl: string }>;
  syncSource(sourceId: string): Promise<unknown>;
  sourceImpact(sourceId: string): Promise<SourceImpactResponse>;
  removeSource(sourceId: string): Promise<{ removed: true; roots: AssignedRootDto[]; devices: DeviceDto[] }>;
  sourceTree(sourceId: string, parentNodeId?: string): Promise<AdminFolderTreeResponse>;
  providerFolders(sourceId: string, input: { providerFolderId?: string; cursor?: string | null; limit?: number; signal?: AbortSignal }): Promise<AdminProviderFolderPageResponse>;
  createRoot(sourceId: string, body: CreateAssignedRootBody): Promise<{ root: AssignedRootDto }>;
  rootImpact(rootId: string): Promise<SourceImpactResponse>;
  removeRoot(rootId: string): Promise<{ removed: true; roots: AssignedRootDto[]; devices: DeviceDto[] }>;
  thumbnailUrls(nodeIds: string[]): Promise<{ items: ThumbnailUrlItem[] }>;
}

type Fetcher = typeof fetch;

export function createAdminApi(fetcher: Fetcher = fetch): AdminApi {
  let csrfToken: string | null = null;

  async function request<T>(path: string, init: RequestInit = {}, retryCsrf = true): Promise<T> {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (method !== "GET" && method !== "HEAD" && csrfToken) headers.set("x-csrf-token", csrfToken);
    let response: Response;
    try {
      response = await fetcher(path, { ...init, headers, credentials: "include" });
    } catch {
      throw new AdminApiError(0, "NETWORK_ERROR", "Cloudframe could not reach the server.");
    }
    const refreshed = response.headers.get("x-csrf-token");
    if (refreshed) csrfToken = refreshed;
    const payload = await safeJson(response);
    if (!response.ok) {
      const error = normalizeError(payload, response.status);
      if (response.status === 403 && retryCsrf && refreshed && isCsrfFailure(error.code) && method !== "GET" && method !== "HEAD") {
        return request<T>(path, init, false);
      }
      throw error;
    }
    if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true) {
      throw new AdminApiError(response.status, "INVALID_RESPONSE", "The server returned an unexpected response.");
    }
    return (payload as ApiResult<T> & { ok: true }).data;
  }

  const json = (value: unknown) => JSON.stringify(value);
  return {
    login: passphrase => request("/api/admin/login", { method: "POST", body: json({ passphrase }) }),
    logout: () => request("/api/admin/logout", { method: "POST", body: json({}) }),
    overview: () => request("/api/admin/overview"),
    approveRequest: (id, body) => request(`/api/admin/requests/${encodeURIComponent(id)}/approve`, { method: "POST", body: json(body) }),
    denyRequest: id => request(`/api/admin/requests/${encodeURIComponent(id)}/deny`, { method: "POST", body: json({}) }),
    updateDevice: (id, body) => request(`/api/admin/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: json(body) }),
    revokeDevice: id => request(`/api/admin/devices/${encodeURIComponent(id)}`, { method: "DELETE", body: json({}) }),
    settings: () => request("/api/admin/settings"),
    updateSettings: body => request("/api/admin/settings", { method: "PATCH", body: json(body) }),
    rotatePassphrase: (currentPassphrase, newPassphrase) => request("/api/admin/settings/passphrase", { method: "POST", body: json({ currentPassphrase, newPassphrase }) }),
    sources: () => request("/api/admin/sources"),
    authorizeSource: (provider, reconnectSourceId) => request(`/api/admin/sources/${provider}/authorize`, { method: "POST", body: json(reconnectSourceId ? { reconnectSourceId } : {}) }),
    syncSource: id => request(`/api/admin/sources/${encodeURIComponent(id)}/sync`, { method: "POST", body: json({}) }),
    sourceImpact: id => request(`/api/admin/sources/${encodeURIComponent(id)}/impact`),
    removeSource: id => request(`/api/admin/sources/${encodeURIComponent(id)}`, { method: "DELETE", body: json({ confirm: true }) }),
    sourceTree: (id, parentNodeId) => request(`/api/admin/sources/${encodeURIComponent(id)}/tree${parentNodeId ? `?parentNodeId=${encodeURIComponent(parentNodeId)}` : ""}`),
    providerFolders: (id, input) => {
      const query = new URLSearchParams();
      if (input.providerFolderId) query.set("providerFolderId", input.providerFolderId);
      if (input.cursor) query.set("cursor", input.cursor);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return request(`/api/admin/sources/${encodeURIComponent(id)}/provider-folders${suffix}`, { signal: input.signal });
    },
    createRoot: (id, body) => request(`/api/admin/sources/${encodeURIComponent(id)}/roots`, { method: "POST", body: json(body) }),
    rootImpact: id => request(`/api/admin/roots/${encodeURIComponent(id)}/impact`),
    removeRoot: id => request(`/api/admin/roots/${encodeURIComponent(id)}`, { method: "DELETE", body: json({ confirm: true }) }),
    thumbnailUrls: nodeIds => request("/api/admin/thumbnail-urls", { method: "POST", body: json({ nodeIds, maxDimension: 360 }) })
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeError(payload: unknown, status: number): AdminApiError {
  const value = payload as Partial<ApiError> | null;
  return new AdminApiError(
    status,
    typeof value?.code === "string" ? value.code : "REQUEST_FAILED",
    typeof value?.message === "string" ? value.message : "The request could not be completed.",
    typeof value?.retryAfterSeconds === "number" ? value.retryAfterSeconds : undefined
  );
}

function isCsrfFailure(code: string): boolean {
  return code === "CSRF_INVALID";
}
