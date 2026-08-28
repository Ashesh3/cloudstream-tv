import type { EncryptedSecret, MediaOrder, ProviderKind } from "./contracts";

export const CONTROL_PLANE_LIMITS = {
  devices: 8,
  pendingRequests: 8,
  sources: 4,
  roots: 32,
  ancestryEntries: 64,
  visibleNameLength: 120
} as const;

export interface ControlPlaneDocumentV2 {
  schemaVersion: 2;
  householdId: string;
  revision: number;
  updatedAt: string;
  household: {
    adminPassphraseHash: string;
    adminPassphraseVersion: number;
    allowNewDeviceRequests: boolean;
    defaultMediaOrder: MediaOrder;
    defaultSlideshowSeconds: number;
  };
  devices: Record<string, ControlPlaneDevice>;
  pendingDeviceRequests: Record<string, ControlPlaneRequest>;
  sources: Record<string, ControlPlaneSource>;
  roots: Record<string, ControlPlaneRoot>;
}

export interface ControlPlaneDevice {
  id: string;
  name: string;
  enabled: boolean;
  assignedRootIds: string[];
  mediaOrder: MediaOrder | null;
  slideshowSeconds: number | null;
  sessionVersion: number;
  createdAt: string;
  approvedAt: string;
  revokedAt: string | null;
}

export interface ControlPlaneRequest {
  id: string;
  requestedName: string;
  requestSecretHash: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  approvedDeviceId: string | null;
}

export interface ControlPlaneSource {
  id: string;
  provider: ProviderKind;
  providerAccountId: string;
  providerRootId: string;
  accountLabel: string;
  encryptedRefreshToken: EncryptedSecret;
  encryptedBootstrapAccessToken: EncryptedSecret | null;
  bootstrapAccessTokenExpiresAt: string | null;
  credentialVersion: number;
  status: "healthy" | "reauth-required" | "disabled";
  createdAt: string;
}

export interface ControlPlaneRoot {
  id: string;
  sourceId: string;
  providerNodeId: string;
  displayName: string;
  ancestryProviderIds: string[];
  enabled: boolean;
  createdAt: string;
}
