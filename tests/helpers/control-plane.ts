import type {
  ControlPlaneDevice,
  ControlPlaneDocumentV2,
  EncryptedSecret
} from "@cloudframe/shared";

export const TEST_NOW = new Date("2026-08-27T08:00:00.000Z");

const encrypted = (byte: number): EncryptedSecret => ({
  keyVersion: "v1",
  iv: Buffer.alloc(12, byte).toString("base64url"),
  ciphertext: Buffer.from(`cipher-${byte}`).toString("base64url"),
  authTag: Buffer.alloc(16, byte).toString("base64url")
});

export function testAeadKeyring() {
  return { currentVersion: "v1", keys: { v1: Buffer.alloc(32, 7) } };
}

export function testControlDevice(id = "device-1"): ControlPlaneDevice {
  return {
    id,
    name: id === "device-1" ? "Living Room" : `TV ${id}`,
    enabled: true,
    assignedRootIds: id === "device-1" ? ["root-1"] : [],
    mediaOrder: null,
    slideshowSeconds: null,
    sessionVersion: 1,
    createdAt: TEST_NOW.toISOString(),
    approvedAt: TEST_NOW.toISOString(),
    revokedAt: null
  };
}

export function testControlDocument(): ControlPlaneDocumentV2 {
  return {
    schemaVersion: 2,
    householdId: "h1",
    revision: 1,
    updatedAt: TEST_NOW.toISOString(),
    household: {
      adminPassphraseHash: "argon2-test-hash",
      adminPassphraseVersion: 1,
      allowNewDeviceRequests: true,
      defaultMediaOrder: "captured-desc",
      defaultSlideshowSeconds: 8
    },
    devices: { "device-1": testControlDevice() },
    pendingDeviceRequests: {
      "request-1": {
        id: "request-1",
        requestedName: "Bedroom",
        requestSecretHash: "request-secret-hash",
        status: "pending",
        createdAt: TEST_NOW.toISOString(),
        expiresAt: new Date(TEST_NOW.getTime() + 30 * 60_000).toISOString(),
        resolvedAt: null,
        approvedDeviceId: null
      }
    },
    sources: {
      "source-1": {
        id: "source-1",
        provider: "google",
        providerAccountId: "account-1",
        providerRootId: "provider-root",
        accountLabel: "family@example.test",
        encryptedRefreshToken: encrypted(1),
        encryptedBootstrapAccessToken: null,
        bootstrapAccessTokenExpiresAt: null,
        credentialVersion: 1,
        status: "healthy",
        createdAt: TEST_NOW.toISOString()
      }
    },
    roots: {
      "root-1": {
        id: "root-1",
        sourceId: "source-1",
        providerNodeId: "provider-trips",
        displayName: "Trips",
        ancestryProviderIds: ["provider-root"],
        enabled: true,
        createdAt: TEST_NOW.toISOString()
      }
    }
  };
}

export function testDocumentAtRevision(revision: number): ControlPlaneDocumentV2 {
  const document = testControlDocument();
  return {
    ...document,
    revision,
    updatedAt: new Date(TEST_NOW.getTime() + revision * 1_000).toISOString()
  };
}
