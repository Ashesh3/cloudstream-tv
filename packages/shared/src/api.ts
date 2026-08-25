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

export interface HouseholdDto {
  id: string;
  createdAt: string;
  allowNewDeviceRequests: boolean;
  defaultMediaOrder: Household["defaultMediaOrder"];
  defaultSlideshowSeconds: number;
}

export interface DeviceRequestDto {
  id: string;
  requestedName: string;
  status: DeviceRequest["status"];
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  approvedDeviceId: string | null;
}

export interface DeviceDto {
  id: string;
  name: string;
  enabled: boolean;
  assignedRootIds: string[];
  mediaOrder: Device["mediaOrder"];
  slideshowSeconds: number | null;
  createdAt: string;
  approvedAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface SourceDto {
  id: string;
  provider: Source["provider"];
  accountLabel: string;
  status: Source["status"];
  accessTokenExpiresAt: string | null;
  nextSyncAt: string | null;
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSyncErrorCode: string | null;
  createdAt: string;
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

export interface MediaNodeDto
  extends Omit<
    MediaNode,
    | "capturedAt"
    | "createdAtProvider"
    | "modifiedAtProvider"
    | "indexedAt"
  > {
  capturedAt: string | null;
  createdAtProvider: string | null;
  modifiedAtProvider: string | null;
  indexedAt: string;
}

export interface BootstrapResponse {
  enrollment:
    | { state: "requests-disabled" }
    | { state: "unenrolled" }
    | { state: "pending"; request: DeviceRequestDto }
    | { state: "ready"; device: DeviceDto; household: HouseholdDto }
    | { state: "denied" | "expired" | "revoked" };
}

export type BootstrapDomainResponse =
  | { enrollment: { state: "requests-disabled" | "unenrolled" } }
  | { enrollment: { state: "pending"; request: DeviceRequest } }
  | { enrollment: { state: "ready"; device: Device; household: Household } }
  | { enrollment: { state: "denied" | "expired" | "revoked" } };

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
  roots: AssignedRootDto[];
  parent: MediaNodeDto | null;
  breadcrumbs: MediaNodeDto[];
  children: MediaNodeDto[];
}

export interface MediaUrlResponse {
  url: string;
  expiresAt: string;
  revision: string | null;
}

export interface AdminOverviewResponse {
  household: HouseholdDto;
  pendingRequests: DeviceRequestDto[];
  devices: DeviceDto[];
  sources: SourceDto[];
  roots: AssignedRootDto[];
}

export interface AdminOverviewDomainResponse {
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

const iso = (value: Date): string => value.toISOString();
const nullableIso = (value: Date | null): string | null =>
  value ? iso(value) : null;

export function encodeHouseholdDto(value: Household): HouseholdDto {
  return {
    id: value.id,
    createdAt: iso(value.createdAt),
    allowNewDeviceRequests: value.allowNewDeviceRequests,
    defaultMediaOrder: value.defaultMediaOrder,
    defaultSlideshowSeconds: value.defaultSlideshowSeconds
  };
}

export function encodeDeviceRequestDto(value: DeviceRequest): DeviceRequestDto {
  return {
    id: value.id,
    requestedName: value.requestedName,
    status: value.status,
    createdAt: iso(value.createdAt),
    expiresAt: iso(value.expiresAt),
    resolvedAt: nullableIso(value.resolvedAt),
    approvedDeviceId: value.approvedDeviceId
  };
}

export function encodeDeviceDto(value: Device): DeviceDto {
  return {
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    assignedRootIds: [...value.assignedRootIds],
    mediaOrder: value.mediaOrder,
    slideshowSeconds: value.slideshowSeconds,
    createdAt: iso(value.createdAt),
    approvedAt: iso(value.approvedAt),
    lastSeenAt: iso(value.lastSeenAt),
    revokedAt: nullableIso(value.revokedAt)
  };
}

export function encodeSourceDto(value: Source): SourceDto {
  return {
    id: value.id,
    provider: value.provider,
    accountLabel: value.accountLabel,
    status: value.status,
    accessTokenExpiresAt: nullableIso(value.accessTokenExpiresAt),
    nextSyncAt: nullableIso(value.nextSyncAt),
    lastSyncStartedAt: nullableIso(value.lastSyncStartedAt),
    lastSyncCompletedAt: nullableIso(value.lastSyncCompletedAt),
    lastSyncErrorCode: value.lastSyncErrorCode,
    createdAt: iso(value.createdAt)
  };
}

export function encodeAssignedRootDto(value: AssignedRoot): AssignedRootDto {
  return {
    id: value.id,
    sourceId: value.sourceId,
    providerNodeId: value.providerNodeId,
    displayName: value.displayName,
    ancestryProviderIds: [...value.ancestryProviderIds],
    enabled: value.enabled,
    createdAt: iso(value.createdAt)
  };
}

export function encodeMediaNodeDto(value: MediaNode): MediaNodeDto {
  return {
    ...value,
    capturedAt: nullableIso(value.capturedAt),
    createdAtProvider: nullableIso(value.createdAtProvider),
    modifiedAtProvider: nullableIso(value.modifiedAtProvider),
    indexedAt: iso(value.indexedAt)
  };
}

export function decodeMediaNodeDto(value: MediaNodeDto): MediaNode {
  return {
    ...value,
    capturedAt: value.capturedAt ? new Date(value.capturedAt) : null,
    createdAtProvider: value.createdAtProvider
      ? new Date(value.createdAtProvider)
      : null,
    modifiedAtProvider: value.modifiedAtProvider
      ? new Date(value.modifiedAtProvider)
      : null,
    indexedAt: new Date(value.indexedAt)
  };
}

export function encodeBootstrapResponse(
  value: BootstrapDomainResponse
): BootstrapResponse {
  const enrollment = value.enrollment;
  if (enrollment.state === "pending") {
    return {
      enrollment: {
        state: "pending",
        request: encodeDeviceRequestDto(enrollment.request)
      }
    };
  }
  if (enrollment.state === "ready") {
    return {
      enrollment: {
        state: "ready",
        device: encodeDeviceDto(enrollment.device),
        household: encodeHouseholdDto(enrollment.household)
      }
    };
  }
  return { enrollment };
}

export function encodeAdminOverviewResponse(
  value: AdminOverviewDomainResponse
): AdminOverviewResponse {
  return {
    household: encodeHouseholdDto(value.household),
    pendingRequests: value.pendingRequests.map(encodeDeviceRequestDto),
    devices: value.devices.map(encodeDeviceDto),
    sources: value.sources.map(encodeSourceDto),
    roots: value.roots.map(encodeAssignedRootDto)
  };
}
