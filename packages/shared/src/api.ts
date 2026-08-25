import type {
  AssignedRoot,
  Device,
  DeviceRequest,
  Household,
  MediaNode,
  Source,
  WatchHistory
} from "./contracts";

export interface ApiError {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface BootstrapResponse {
  enrollment:
    | { state: "requests-disabled" }
    | { state: "unenrolled" }
    | { state: "pending"; request: DeviceRequest }
    | { state: "ready"; device: Device; household: Household }
    | { state: "denied" | "expired" | "revoked" };
}

export interface CreateDeviceRequestBody {
  requestedName: string;
}

export interface ApproveDeviceRequestBody {
  name: string;
  rootIds: string[];
}

export interface UpdateDeviceBody {
  name?: string;
  enabled?: boolean;
  assignedRootIds?: string[];
  mediaOrder?: Device["mediaOrder"];
  slideshowSeconds?: number | null;
}

export interface BrowseFolderResponse {
  roots: AssignedRoot[];
  parent: MediaNode | null;
  breadcrumbs: MediaNode[];
  children: MediaNode[];
}

export interface MediaUrlResponse {
  url: string;
  expiresAt: string;
  revision: string | null;
}

export interface AdminOverviewResponse {
  household: Household;
  pendingRequests: DeviceRequest[];
  devices: Device[];
  sources: Source[];
  roots: AssignedRoot[];
}

export type SaveWatchHistoryBody = Pick<
  WatchHistory,
  "nodeId" | "positionSeconds" | "durationSeconds" | "completed"
>;
