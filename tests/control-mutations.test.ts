import { describe, expect, it } from "vitest";

import {
  approveDeviceRequestMutation,
  connectSourceMutation,
  createDeviceRequestMutation,
  createOrEnableRootMutation,
  markSourceReauthRequiredMutation,
  reconnectSourceMutation,
  removeRootMutation,
  removeSourceMutation,
  resolveDeviceRequestMutation,
  revokeDeviceMutation,
  rotatePassphraseMutation,
  rotateSourceCredentialsMutation,
  updateDeviceMutation,
  updateSettingsMutation
} from "@cloudframe/server";
import {
  CONTROL_PLANE_LIMITS,
  type ControlPlaneRequest,
  type ControlPlaneRoot,
  type ControlPlaneSource,
  type EncryptedSecret
} from "@cloudframe/shared";
import {
  TEST_NOW,
  testControlDevice,
  testControlDocument
} from "./helpers/control-plane";

const later = new Date("2026-08-27T09:00:00.000Z");

function secret(byte: number): EncryptedSecret {
  return {
    keyVersion: "v1",
    iv: Buffer.alloc(12, byte).toString("base64url"),
    ciphertext: Buffer.from(`rotated-${byte}`).toString("base64url"),
    authTag: Buffer.alloc(16, byte).toString("base64url")
  };
}

describe("control-plane mutations", () => {
  it("revokes a device without mutating the input or advancing document metadata", () => {
    const current = testControlDocument();
    const before = structuredClone(current);

    const result = revokeDeviceMutation(current, "device-1", later);

    expect(result.changed).toBe(true);
    expect(result.next.devices["device-1"]).toMatchObject({
      enabled: false,
      sessionVersion: 2,
      revokedAt: later.toISOString()
    });
    expect(result.next.revision).toBe(1);
    expect(result.next.updatedAt).toBe(TEST_NOW.toISOString());
    expect(current).toEqual(before);
    expect(JSON.stringify(result.next)).not.toContain("watchHistory");
  });

  it("treats repeated revocation as an idempotent no-op", () => {
    const revoked = revokeDeviceMutation(
      testControlDocument(),
      "device-1",
      later
    ).next;

    const result = revokeDeviceMutation(
      revoked,
      "device-1",
      new Date("2026-08-27T10:00:00.000Z")
    );

    expect(result.changed).toBe(false);
    expect(result.next.devices["device-1"].sessionVersion).toBe(2);
    expect(result.next.devices["device-1"].revokedAt).toBe(later.toISOString());
  });

  it("removing a root atomically removes it from every device assignment", () => {
    const current = testControlDocument();
    current.devices["device-2"] = {
      ...testControlDevice("device-2"),
      assignedRootIds: ["root-1"]
    };

    const result = removeRootMutation(current, "root-1");

    expect(result.next.roots["root-1"]).toBeUndefined();
    expect(result.next.devices["device-1"].assignedRootIds).toEqual([]);
    expect(result.next.devices["device-2"].assignedRootIds).toEqual([]);
  });

  it("removing a source atomically removes its roots and every dependent assignment", () => {
    const result = removeSourceMutation(testControlDocument(), "source-1");

    expect(result.changed).toBe(true);
    expect(result.next.sources).toEqual({});
    expect(result.next.roots).toEqual({});
    expect(result.next.devices["device-1"].assignedRootIds).toEqual([]);
    expect(result.result.rootIds).toEqual(["root-1"]);
    expect(result.result.deviceIds).toEqual(["device-1"]);
  });

  it("does not change an idempotent settings update", () => {
    const current = testControlDocument();

    const result = updateSettingsMutation(current, current.household);

    expect(result.changed).toBe(false);
    expect(result.next).toEqual(current);
  });

  it("changes only requested settings and leaves revision ownership to the store", () => {
    const current = testControlDocument();
    const result = updateSettingsMutation(current, {
      allowNewDeviceRequests: false
    });

    expect(result.next.household).toMatchObject({
      allowNewDeviceRequests: false,
      defaultMediaOrder: "captured-desc",
      defaultSlideshowSeconds: 8
    });
    expect(result.next.revision).toBe(1);
  });

  it("rotates only the passphrase hash and invalidates every admin session version", () => {
    const result = rotatePassphraseMutation(testControlDocument(), "new-hash");

    expect(result.next.household).toMatchObject({
      adminPassphraseHash: "new-hash",
      adminPassphraseVersion: 2,
      allowNewDeviceRequests: true
    });
  });

  it("rejects an expired request approval without creating a device", () => {
    const device = {
      ...testControlDevice("device-2"),
      assignedRootIds: ["root-1"],
      createdAt: later.toISOString(),
      approvedAt: later.toISOString()
    };

    expect(() =>
      approveDeviceRequestMutation(
        testControlDocument(),
        "request-1",
        device,
        ["root-1"]
      )
    ).toThrowError(expect.objectContaining({ code: "DEVICE_REQUEST_EXPIRED" }));
  });

  it("approves a live request and creates its device atomically", () => {
    const approvedAt = new Date(TEST_NOW.getTime() + 5 * 60_000);
    const device = {
      ...testControlDevice("device-2"),
      name: "Bedroom",
      assignedRootIds: ["root-1"],
      createdAt: approvedAt.toISOString(),
      approvedAt: approvedAt.toISOString()
    };

    const result = approveDeviceRequestMutation(
      testControlDocument(),
      "request-1",
      device,
      ["root-1"]
    );

    expect(result.next.devices["device-2"]).toEqual(device);
    expect(result.next.pendingDeviceRequests["request-1"]).toMatchObject({
      status: "approved",
      resolvedAt: approvedAt.toISOString(),
      approvedDeviceId: "device-2"
    });
  });

  it("expires a request when resolving it after its deadline", () => {
    const result = resolveDeviceRequestMutation(
      testControlDocument(),
      "request-1",
      "denied",
      later
    );

    expect(result.next.pendingDeviceRequests["request-1"]).toMatchObject({
      status: "expired",
      resolvedAt: later.toISOString()
    });
  });

  it("prunes expired requests before enforcing the pending request ceiling", () => {
    const current = testControlDocument();
    for (let index = 1; index < CONTROL_PLANE_LIMITS.pendingRequests; index += 1) {
      const id = `expired-${index}`;
      current.pendingDeviceRequests[id] = {
        ...current.pendingDeviceRequests["request-1"],
        id,
        expiresAt: new Date(TEST_NOW.getTime() - index * 1_000).toISOString()
      };
    }
    const request: ControlPlaneRequest = {
      id: "request-new",
      requestedName: "Office",
      requestSecretHash: "new-secret-hash",
      status: "pending",
      createdAt: later.toISOString(),
      expiresAt: new Date(later.getTime() + 30 * 60_000).toISOString(),
      resolvedAt: null,
      approvedDeviceId: null
    };

    const result = createDeviceRequestMutation(current, request);

    expect(result.changed).toBe(true);
    expect(Object.keys(result.next.pendingDeviceRequests)).toEqual([
      "request-new"
    ]);
  });

  it("rejects device assignments to missing or disabled roots", () => {
    expect(() =>
      updateDeviceMutation(testControlDocument(), "device-1", {
        assignedRootIds: ["missing-root"]
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_ROOT_ASSIGNMENT" }));
  });

  it("connects a source only while the source ceiling has capacity", () => {
    const current = testControlDocument();
    const source = current.sources["source-1"];
    for (let index = 2; index <= CONTROL_PLANE_LIMITS.sources; index += 1) {
      current.sources[`source-${index}`] = {
        ...source,
        id: `source-${index}`,
        providerAccountId: `account-${index}`
      };
    }
    const extra: ControlPlaneSource = {
      ...source,
      id: "source-extra",
      providerAccountId: "account-extra"
    };

    expect(() => connectSourceMutation(current, extra)).toThrowError(
      expect.objectContaining({ code: "CONTROL_PLANE_LIMIT_EXCEEDED" })
    );
  });

  it("requires reconnects to match provider, account, and provider root", () => {
    expect(() =>
      reconnectSourceMutation(testControlDocument(), "source-1", {
        provider: "google",
        providerAccountId: "other-account",
        providerRootId: "provider-root",
        accountLabel: "other@example.test",
        encryptedRefreshToken: secret(2),
        encryptedBootstrapAccessToken: null,
        bootstrapAccessTokenExpiresAt: null
      })
    ).toThrowError(expect.objectContaining({ code: "SOURCE_IDENTITY_MISMATCH" }));
  });

  it("reconnects only the requested source and advances its credential version", () => {
    const current = testControlDocument();
    const other: ControlPlaneSource = {
      ...current.sources["source-1"],
      id: "source-2",
      providerAccountId: "account-2"
    };
    current.sources[other.id] = other;

    const result = reconnectSourceMutation(current, "source-1", {
      provider: "google",
      providerAccountId: "account-1",
      providerRootId: "provider-root",
      accountLabel: "renamed@example.test",
      encryptedRefreshToken: secret(3),
      encryptedBootstrapAccessToken: secret(4),
      bootstrapAccessTokenExpiresAt: later.toISOString()
    });

    expect(result.next.sources["source-1"]).toMatchObject({
      accountLabel: "renamed@example.test",
      credentialVersion: 2,
      status: "healthy"
    });
    expect(result.next.sources["source-2"]).toEqual(other);
  });

  it("marks reauthorization idempotently", () => {
    const first = markSourceReauthRequiredMutation(
      testControlDocument(),
      "source-1"
    );
    const second = markSourceReauthRequiredMutation(first.next, "source-1");

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
  });

  it("creates, reenables, and idempotently retains roots for an existing source", () => {
    const current = testControlDocument();
    const root: ControlPlaneRoot = {
      id: "root-2",
      sourceId: "source-1",
      providerNodeId: "provider-office",
      displayName: "Office",
      ancestryProviderIds: ["provider-root"],
      enabled: true,
      createdAt: later.toISOString()
    };
    const created = createOrEnableRootMutation(current, root);
    const repeated = createOrEnableRootMutation(created.next, root);

    expect(created.next.roots["root-2"]).toEqual(root);
    expect(repeated.changed).toBe(false);
  });

  it("rotates refresh credentials only at the expected credential version", () => {
    const stale = rotateSourceCredentialsMutation(
      testControlDocument(),
      "source-1",
      2,
      secret(5)
    );
    const rotated = rotateSourceCredentialsMutation(
      testControlDocument(),
      "source-1",
      1,
      secret(5)
    );

    expect(stale.changed).toBe(false);
    expect(rotated.next.sources["source-1"]).toMatchObject({
      credentialVersion: 2,
      encryptedRefreshToken: secret(5)
    });
  });
});
