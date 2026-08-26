export type EntityId = string;
export type MediaOrder = "captured-desc" | "captured-asc" | "name-asc";
export type ProviderKind = "google" | "onedrive";
export type MediaNodeKind = "folder" | "image" | "video";

export interface StoredEntity {
  id: EntityId;
}

export interface Household extends StoredEntity {
  createdAt: Date;
  allowNewDeviceRequests: boolean;
  defaultMediaOrder: MediaOrder;
  defaultSlideshowSeconds: number;
  adminPassphraseHash: string;
  adminPassphraseVersion: number;
}

export interface AdminSession extends StoredEntity {
  householdId: EntityId;
  tokenHash: string;
  passphraseVersion: number;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export type DeviceRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired";

export interface DeviceRequest extends StoredEntity {
  householdId: EntityId;
  requestSecretHash: string;
  requestedName: string;
  status: DeviceRequestStatus;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
  approvedDeviceId: EntityId | null;
}

export interface Device extends StoredEntity {
  householdId: EntityId;
  name: string;
  enabled: boolean;
  assignedRootIds: EntityId[];
  mediaOrder: MediaOrder | null;
  slideshowSeconds: number | null;
  createdAt: Date;
  approvedAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface DeviceSession extends StoredEntity {
  householdId: EntityId;
  deviceId: EntityId;
  tokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface EncryptedSecret {
  keyVersion: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface IndexCheckpoint {
  mode: "initial" | "delta" | "reconcile";
  providerPageCursor: string | null;
  processedNodeCount: number;
  generation: string;
  currentProviderFolderId?: string | null;
  pendingProviderFolderIds?: string[];
  reconciliationCursor?: string | null;
  pageFingerprint?: string;
}

export type SourceStatus =
  | "healthy"
  | "syncing"
  | "reauth-required"
  | "error"
  | "disabled";

export interface Source extends StoredEntity {
  householdId: EntityId;
  provider: ProviderKind;
  providerAccountId: string | null;
  providerRootId: string | null;
  accountLabel: string;
  encryptedRefreshToken: EncryptedSecret;
  encryptedAccessToken: EncryptedSecret | null;
  accessTokenExpiresAt: Date | null;
  status: SourceStatus;
  deltaCursor: string | null;
  crawlCheckpoint: IndexCheckpoint | null;
  activeWorkflowRunId: string | null;
  syncGeneration: string | null;
  nextSyncAt: Date | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastSyncStartedAt: Date | null;
  lastSyncCompletedAt: Date | null;
  lastSyncErrorCode: string | null;
  createdAt: Date;
}

export interface OAuthState extends StoredEntity {
  stateHash: string;
  householdId: EntityId;
  adminSessionId: EntityId;
  provider: ProviderKind;
  redirectUri: string;
  reconnectSourceId: EntityId | null;
  encryptedCodeVerifier: EncryptedSecret;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface AssignedRoot extends StoredEntity {
  householdId: EntityId;
  sourceId: EntityId;
  providerNodeId: string;
  displayName: string;
  ancestryProviderIds: string[];
  enabled: boolean;
  createdAt: Date;
}

export interface MediaNode extends StoredEntity {
  householdId: EntityId;
  sourceId: EntityId;
  provider: ProviderKind;
  providerNodeId: string;
  parentNodeId: EntityId | null;
  ancestorNodeIds: EntityId[];
  name: string;
  normalizedName: string;
  kind: MediaNodeKind;
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  capturedAt: Date | null;
  createdAtProvider: Date | null;
  modifiedAtProvider: Date | null;
  thumbnailRevision: string | null;
  hasPreview: boolean;
  folderCoverNodeIds: EntityId[];
  childFolderCount: number;
  childMediaCount: number;
  available: boolean;
  indexedAt: Date;
  syncGeneration?: string;
}

export interface WatchHistory extends StoredEntity {
  householdId: EntityId;
  deviceId: EntityId;
  nodeId: EntityId;
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;
  updatedAt: Date;
}

export interface SyncLeaseInput {
  sourceId: EntityId;
  owner: string;
  now: Date;
  expiresAt: Date;
}

export interface ApproveDeviceRequestInput {
  requestId: EntityId;
  device: Device;
  session: DeviceSession;
  rootIds: EntityId[];
  approvedAt: Date;
}

export interface RotateAdminPassphraseInput {
  householdId: EntityId;
  adminPassphraseHash: string;
  revokedAt: Date;
}

export interface UpdateHouseholdSettingsInput {
  householdId: EntityId;
  allowNewDeviceRequests: boolean;
  defaultMediaOrder: MediaOrder;
  defaultSlideshowSeconds: number;
}

export interface ConnectSourceInput {
  source: Source;
}

export interface RemoveSourceInput {
  householdId: EntityId;
  sourceId: EntityId;
}

export interface DisableRootInput {
  householdId: EntityId;
  rootId: EntityId;
}
