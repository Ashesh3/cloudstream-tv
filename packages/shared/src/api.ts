import type {
  AssignedRoot,
  Device,
  DeviceRequest,
  Household,
  IndexCheckpoint,
  MediaNode,
  Source,
  WatchHistory
} from "./contracts";
import {
  sourceIndexStateKind,
  type SourceIndexStateKind
} from "./index-state";

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
  indexProgress: { mode: IndexCheckpoint["mode"]; processedNodeCount: number; pendingFolderCount: number; reconciliationActive: boolean } | null;
  createdAt: string;
  providerRootId: string | null;
  indexState: SourceIndexStateDto;
}

export interface SourceIndexStateDto {
  kind: SourceIndexStateKind;
  processedNodeCount: number;
  pendingFolderCount: number;
  recoverable: boolean;
  errorCode: string | null;
}

export interface ProviderFolderDto {
  providerNodeId: string;
  parentProviderId: string | null;
  name: string;
  assignedRootId: string | null;
}

export interface AdminProviderFolderPageResponse {
  source: SourceDto;
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

export interface MediaNodeDto {
  id: string;
  sourceId: string;
  provider: MediaNode["provider"];
  parentNodeId: string | null;
  name: string;
  normalizedName: string;
  kind: MediaNode["kind"];
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  capturedAt: string | null;
  createdAtProvider: string | null;
  modifiedAtProvider: string | null;
  thumbnailRevision: string | null;
  hasPreview: boolean;
  folderCoverNodeIds: string[];
  childFolderCount: number;
  childMediaCount: number;
  available: boolean;
}

export interface WatchHistoryDto {
  nodeId: string;
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;
  updatedAt: string;
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
  nextCursor?: string | null;
}

export interface ThumbnailUrlItem {
  nodeId: string;
  status: "ready" | "unavailable";
  url?: string;
  expiresAt?: string;
  revision?: string | null;
}

export interface TvRootCardDto {
  id: string;
  sourceId: string;
  displayName: string;
  provider: Source["provider"];
  accountLabel: string;
  nodeId: string;
  folderCoverNodeIds: string[];
  childFolderCount: number;
  childMediaCount: number;
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

export interface AdminSettingsResponse {
  allowNewDeviceRequests: boolean;
  defaultMediaOrder: Household["defaultMediaOrder"];
  defaultSlideshowSeconds: number;
  indexHealth: { totalNodeCount: number; availableNodeCount: number; indexingSourceCount: number; estimatedFirestoreDocumentCount: number };
}

export interface UpdateAdminSettingsBody {
  allowNewDeviceRequests?: boolean;
  defaultMediaOrder?: Household["defaultMediaOrder"];
  defaultSlideshowSeconds?: number;
}

export interface RotateAdminPassphraseBody {
  currentPassphrase: string;
  newPassphrase: string;
}

export interface SourceImpactResponse {
  roots: AssignedRootDto[];
  devices: DeviceDto[];
}

export interface AdminFolderTreeResponse {
  source: SourceDto;
  parent: MediaNodeDto | null;
  folders: Array<MediaNodeDto & { assignedRootId: string | null }>;
}

export interface CreateAssignedRootBody {
  providerNodeId: string;
  displayName?: string;
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

export function encodeSourceDto(value: Source, enabledRootCount: number): SourceDto {
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
    indexProgress: value.crawlCheckpoint ? {
      mode: value.crawlCheckpoint.mode,
      processedNodeCount: value.crawlCheckpoint.processedNodeCount,
      pendingFolderCount: value.crawlCheckpoint.pendingProviderFolderIds?.length ?? 0,
      reconciliationActive: value.crawlCheckpoint.mode === "reconcile"
    } : null,
    createdAt: iso(value.createdAt),
    providerRootId: value.providerRootId,
    indexState: encodeSourceIndexState(value, enabledRootCount)
  };
}

export function encodeSourceIndexState(
  source: Source,
  enabledRootCount: number
): SourceIndexStateDto {
  const checkpoint = source.crawlCheckpoint;
  const processedNodeCount = checkpoint?.processedNodeCount ?? 0;
  const pendingFolderCount = checkpoint?.pendingProviderFolderIds?.length ?? 0;
  const errorCode = source.lastSyncErrorCode;
  const kind = sourceIndexStateKind(source, enabledRootCount);
  return {
    kind,
    processedNodeCount,
    pendingFolderCount,
    recoverable:
      kind === "quota-exhausted" ||
      kind === "reauth-required" ||
      kind === "provider-error" ||
      (kind === "queued" && source.activeWorkflowRunId === null),
    errorCode: kind === "quota-exhausted" || kind === "reauth-required" || kind === "provider-error"
      ? errorCode
      : null
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
    id: value.id,
    sourceId: value.sourceId,
    provider: value.provider,
    parentNodeId: value.parentNodeId,
    name: value.name,
    normalizedName: value.normalizedName,
    kind: value.kind,
    mimeType: value.mimeType,
    size: value.size,
    width: value.width,
    height: value.height,
    capturedAt: nullableIso(value.capturedAt),
    createdAtProvider: nullableIso(value.createdAtProvider),
    modifiedAtProvider: nullableIso(value.modifiedAtProvider),
    thumbnailRevision: value.thumbnailRevision,
    hasPreview: value.hasPreview,
    folderCoverNodeIds: [...value.folderCoverNodeIds],
    childFolderCount: value.childFolderCount,
    childMediaCount: value.childMediaCount,
    available: value.available
  };
}

export function decodeMediaNodeDto(value: MediaNodeDto): MediaNode {
  return {
    ...value,
    householdId: "",
    providerNodeId: "",
    ancestorNodeIds: [],
    capturedAt: value.capturedAt ? new Date(value.capturedAt) : null,
    createdAtProvider: value.createdAtProvider
      ? new Date(value.createdAtProvider)
      : null,
    modifiedAtProvider: value.modifiedAtProvider
      ? new Date(value.modifiedAtProvider)
      : null,
    indexedAt: new Date(0)
  };
}


export function encodeWatchHistoryDto(value: WatchHistory): WatchHistoryDto {
  return {
    nodeId: value.nodeId,
    positionSeconds: value.positionSeconds,
    durationSeconds: value.durationSeconds,
    completed: value.completed,
    updatedAt: iso(value.updatedAt)
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
  const enabledRootCountBySource = new Map<string, number>();
  for (const root of value.roots) {
    if (!root.enabled) continue;
    enabledRootCountBySource.set(
      root.sourceId,
      (enabledRootCountBySource.get(root.sourceId) ?? 0) + 1
    );
  }
  return {
    household: encodeHouseholdDto(value.household),
    pendingRequests: value.pendingRequests.map(encodeDeviceRequestDto),
    devices: value.devices.map(encodeDeviceDto),
    sources: value.sources.map(source =>
      encodeSourceDto(source, enabledRootCountBySource.get(source.id) ?? 0)
    ),
    roots: value.roots.map(encodeAssignedRootDto)
  };
}
