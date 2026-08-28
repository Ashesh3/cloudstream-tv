export type EntityId = string;
export type MediaOrder = "captured-desc" | "captured-asc" | "name-asc";
export type ProviderKind = "google" | "onedrive";
export type DeviceRequestStatus = "pending" | "approved" | "denied" | "expired";

export interface EncryptedSecret {
  keyVersion: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

/** Temporary retained compatibility records used only by the bounded legacy cookie exchange. */
export interface Household {
  id: EntityId;
  createdAt: Date;
  allowNewDeviceRequests: boolean;
  defaultMediaOrder: MediaOrder;
  defaultSlideshowSeconds: number;
  adminPassphraseHash: string;
  adminPassphraseVersion: number;
}

export interface AdminSession {
  id: EntityId;
  householdId: EntityId;
  tokenHash: string;
  passphraseVersion: number;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface Device {
  id: EntityId;
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

export interface DeviceSession {
  id: EntityId;
  householdId: EntityId;
  deviceId: EntityId;
  tokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}
