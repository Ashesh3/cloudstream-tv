import { describe, expect, it } from "vitest";

import {
  ControlAdminServiceError,
  createControlAdminService
} from "@cloudframe/server";
import {
  controlStoreHarness
} from "../packages/server/src/control-plane/memory";
import {
  TEST_NOW,
  testControlDevice,
  testControlDocument
} from "./helpers/control-plane";

const PASSPHRASE = "correct horse battery staple";
const NEXT_PASSPHRASE = "a replacement household passphrase";

async function serviceHarness() {
  const document = testControlDocument();
  const { hashPassphrase } = await import("@cloudframe/server");
  document.household.adminPassphraseHash = await hashPassphrase(
    PASSPHRASE,
    "test-pepper"
  );
  const harness = controlStoreHarness(document);
  const service = createControlAdminService({
    store: harness.store,
    passphrasePepper: "test-pepper",
    now: () => new Date("2026-08-27T08:10:00.000Z"),
    createId: () => "device-created"
  });
  return { ...harness, service };
}

describe("control admin service", () => {
  it("returns one browser-safe, sorted admin snapshot from local encrypted state", async () => {
    const document = testControlDocument();
    document.pendingDeviceRequests["expired"] = {
      ...document.pendingDeviceRequests["request-1"],
      id: "expired",
      requestedName: "Expired",
      expiresAt: new Date(TEST_NOW.getTime() - 1_000).toISOString()
    };
    document.pendingDeviceRequests["request-2"] = {
      ...document.pendingDeviceRequests["request-1"],
      id: "request-2",
      requestedName: "Attic",
      createdAt: new Date(TEST_NOW.getTime() + 1_000).toISOString()
    };
    document.devices["device-2"] = {
      ...testControlDevice("device-2"),
      name: "Attic TV"
    };
    document.sources["source-2"] = {
      ...document.sources["source-1"],
      id: "source-2",
      providerAccountId: "account-2",
      accountLabel: "aaa@example.test"
    };
    document.roots["root-2"] = {
      ...document.roots["root-1"],
      id: "root-2",
      sourceId: "source-2",
      providerNodeId: "provider-attic",
      displayName: "Attic"
    };
    const harness = controlStoreHarness(document);
    const service = createControlAdminService({
      store: harness.store,
      passphrasePepper: "pepper",
      now: () => new Date("2026-08-27T08:10:00.000Z")
    });

    const snapshot = await service.snapshot("h1");

    expect(snapshot).toMatchObject({
      revision: 1,
      storage: { mode: "local", revision: 1 }
    });
    expect(snapshot).not.toHaveProperty("recoveryCopy");
    expect(snapshot.pendingRequests.map((request) => request.id)).toEqual([
      "request-2",
      "request-1"
    ]);
    expect(snapshot.devices.map((device) => device.id)).toEqual([
      "device-2",
      "device-1"
    ]);
    expect(snapshot.sources.map((source) => source.id)).toEqual([
      "source-2",
      "source-1"
    ]);
    expect(snapshot.roots.map((root) => root.id)).toEqual([
      "root-2",
      "root-1"
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /adminPassphraseHash|requestSecretHash|providerNodeId|providerAccountId|providerRootId|encrypted|accessToken|refreshToken|credentialVersion|sessionVersion/
    );
  });

  it("performs one local mutation for settings", async () => {
    const harness = await serviceHarness();

    const result = await harness.service.updateSettings("h1", {
      allowNewDeviceRequests: false,
      defaultMediaOrder: "name-asc",
      defaultSlideshowSeconds: 10
    });

    expect(result.revision).toBe(2);
    expect(harness.durable.writeAttempts).toBe(1);
  });

  it("performs zero writes for an idempotent settings update", async () => {
    const harness = await serviceHarness();

    const result = await harness.service.updateSettings("h1", {
      allowNewDeviceRequests: true,
      defaultMediaOrder: "captured-desc",
      defaultSlideshowSeconds: 8
    });

    expect(result.revision).toBe(1);
    expect(harness.durable.writeAttempts).toBe(0);
  });

  it("verifies the current passphrase before rotating the hash and version", async () => {
    const harness = await serviceHarness();

    await expect(
      harness.service.rotatePassphrase("h1", "wrong passphrase value", NEXT_PASSPHRASE)
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(harness.durable.writeAttempts).toBe(0);

    const result = await harness.service.rotatePassphrase(
      "h1",
      PASSPHRASE,
      NEXT_PASSPHRASE
    );

    expect(result.revision).toBe(2);
    expect(harness.current().household.adminPassphraseVersion).toBe(2);
    expect(harness.current().household.adminPassphraseHash).not.toBe(
      PASSPHRASE
    );
  });

  it("approves, updates, and revokes a device through one mutation per action", async () => {
    const harness = await serviceHarness();

    const approved = await harness.service.approveRequest("h1", "request-1", {
      name: "Bedroom",
      rootIds: ["root-1"]
    });
    const updated = await harness.service.updateDevice(
      "h1",
      approved.device.id,
      { name: "Guest Room", slideshowSeconds: 12 }
    );
    const revoked = await harness.service.revokeDevice(
      "h1",
      approved.device.id
    );

    expect(approved.device).toMatchObject({
      id: "device-created",
      name: "Bedroom",
      assignedRootIds: ["root-1"]
    });
    expect(updated.device).toMatchObject({
      id: "device-created",
      name: "Guest Room",
      slideshowSeconds: 12
    });
    expect(revoked).toEqual({ revoked: true });
    expect(harness.current().devices["device-created"]).toMatchObject({
      enabled: false,
      sessionVersion: 2
    });
    expect(harness.durable.writeAttempts).toBe(3);
  });

  it("denies a pending request with a browser-safe resolved request", async () => {
    const harness = await serviceHarness();

    const result = await harness.service.denyRequest("h1", "request-1");

    expect(result.request).toMatchObject({
      id: "request-1",
      status: "denied",
      resolvedAt: "2026-08-27T08:10:00.000Z",
      approvedDeviceId: null
    });
    expect(JSON.stringify(result)).not.toContain("requestSecretHash");
  });

  it("reports and atomically removes source and root impact", async () => {
    const sourceHarness = await serviceHarness();
    const sourceImpact = await sourceHarness.service.sourceImpact("h1", "source-1");
    const removedSource = await sourceHarness.service.removeSource("h1", "source-1");

    expect(sourceImpact.roots.map((root) => root.id)).toEqual(["root-1"]);
    expect(sourceImpact.devices.map((device) => device.id)).toEqual(["device-1"]);
    expect(removedSource).toMatchObject({ removed: true });
    expect(sourceHarness.current().roots).toEqual({});
    expect(
      sourceHarness.current().devices["device-1"].assignedRootIds
    ).toEqual([]);

    const rootHarness = await serviceHarness();
    const rootImpact = await rootHarness.service.rootImpact("h1", "root-1");
    const removedRoot = await rootHarness.service.removeRoot("h1", "root-1");

    expect(rootImpact.roots.map((root) => root.id)).toEqual(["root-1"]);
    expect(rootImpact.devices.map((device) => device.id)).toEqual(["device-1"]);
    expect(removedRoot).toMatchObject({ removed: true });
    expect(rootHarness.current().roots).toEqual({});
  });

  it("rejects cross-household reads and mutations", async () => {
    const harness = await serviceHarness();

    await expect(harness.service.snapshot("other-household")).rejects.toBeInstanceOf(
      ControlAdminServiceError
    );
    await expect(
      harness.service.updateSettings("other-household", {
        allowNewDeviceRequests: false
      })
    ).rejects.toMatchObject({ code: "HOUSEHOLD_NOT_FOUND" });
    expect(harness.durable.writeAttempts).toBe(0);
  });
});
