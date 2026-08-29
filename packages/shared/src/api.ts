import type {
  MediaOrder,
  ProviderKind,
  DeviceRequestStatus
} from "./contracts";

export interface ApiError {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export interface ControlHouseholdDto {
  allowNewDeviceRequests: boolean;
  defaultMediaOrder: MediaOrder;
  defaultSlideshowSeconds: number;
}

export interface ControlDeviceDto {
  id: string;
  name: string;
  enabled: boolean;
  assignedRootIds: string[];
  mediaOrder: MediaOrder | null;
  slideshowSeconds: number | null;
  createdAt: string;
  approvedAt: string;
  revokedAt: string | null;
}

export interface ControlRequestDto {
  id: string;
  requestedName: string;
  status: DeviceRequestStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  approvedDeviceId: string | null;
}

export type DeviceRequestDto = ControlRequestDto;

export interface ControlSourceDto {
  id: string;
  provider: ProviderKind;
  accountLabel: string;
  status: "healthy" | "reauth-required" | "disabled";
  createdAt: string;
}

export interface ControlRootDto {
  id: string;
  sourceId: string;
  displayName: string;
  enabled: boolean;
  createdAt: string;
}

export interface AdminSnapshotResponse {
  revision: number;
  household: ControlHouseholdDto;
  pendingRequests: ControlRequestDto[];
  devices: ControlDeviceDto[];
  sources: ControlSourceDto[];
  roots: ControlRootDto[];
  storage: { mode: "local"; revision: number };
}

export type InstallationStatusResponse =
  | { state: "unconfigured" }
  | { state: "configured" };

export interface ClaimInstallationBody {
  setupCode: string;
  passphrase: string;
}

export interface TvBootstrapResponse {
  enrollment:
    | { state: "requests-disabled" | "unenrolled" }
    | { state: "pending"; request: ControlRequestDto }
    | { state: "ready"; device: ControlDeviceDto; household: ControlHouseholdDto }
    | { state: "denied" | "expired" | "revoked" };
}

export interface TvBrowseItemDto {
  id: string;
  handle: string;
  name: string;
  normalizedName: string;
  kind: "folder" | "image" | "video";
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  capturedAt: string | null;
  createdAtProvider: string | null;
  modifiedAtProvider: string | null;
  thumbnailRevision: string | null;
  hasPreview: boolean;
}

export interface TvRootDto {
  id: string;
  handle: string;
  displayName: string;
  provider: "google" | "onedrive";
  accountLabel: string;
}

export interface TvFolderPageResponse {
  parent: TvBrowseItemDto;
  children: TvBrowseItemDto[];
  nextCursor: string | null;
}

export interface DirectThumbnailItem {
  itemId: string;
  status: "ready" | "unavailable";
  url?: string;
  expiresAt?: string;
  revision?: string | null;
}

export interface DirectMediaResponseBase {
  itemId: string;
  kind: "image" | "video";
  url: string;
  expiresAt: string;
  revision: string | null;
}

export interface DirectProviderMediaUrlResponse extends DirectMediaResponseBase {
  transport: "direct";
}

export interface GoogleBearerMediaUrlResponse extends DirectMediaResponseBase {
  transport: "google-bearer";
  authorization: {
    scheme: "Bearer";
    token: string;
  };
}

export type DirectMediaUrlResponse =
  | DirectProviderMediaUrlResponse
  | GoogleBearerMediaUrlResponse;

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export interface DeviceDto extends ControlDeviceDto {
  id: string;
  lastSeenAt: string;
}

export interface ProviderFolderDto {
  providerNodeId: string;
  parentProviderId: string | null;
  name: string;
  assignedRootId: string | null;
}

export interface AdminProviderFolderPageResponse {
  source: ControlSourceDto;
  current: ProviderFolderDto;
  breadcrumbs: ProviderFolderDto[];
  folders: ProviderFolderDto[];
  nextCursor: string | null;
}

export interface AssignedRootDto {
  id: string;
  sourceId: string;
  providerNodeId: string;
  displayName: string;
  ancestryProviderIds: string[];
  enabled: boolean;
  createdAt: string;
}

export interface ApproveDeviceRequestBody {
  name: string;
  rootIds: string[];
}

export interface UpdateDeviceBody {
  name?: string;
  enabled?: boolean;
  assignedRootIds?: string[];
  mediaOrder?: MediaOrder | null;
  slideshowSeconds?: number | null;
}

export interface UpdateAdminSettingsBody {
  allowNewDeviceRequests?: boolean;
  defaultMediaOrder?: MediaOrder;
  defaultSlideshowSeconds?: number;
}

export interface SourceImpactResponse {
  roots: AssignedRootDto[];
  devices: DeviceDto[];
}

export interface CreateAssignedRootBody {
  providerNodeId: string;
  displayName?: string;
}
