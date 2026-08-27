import { describe, expect, it } from "vitest";

import {
  ControlEnrollmentError,
  createControlAdminService,
  createControlEnrollmentService,
  createSealedSessionCodec,
  hashOpaqueToken,
  type ControlPlaneStore
} from "@cloudframe/server";
import {
  controlStoreHarness
} from "../packages/server/src/control-plane/memory";
import {
  TEST_NOW,
  testAeadKeyring,
  testControlDocument
} from "./helpers/control-plane";

const REQUEST_LIFETIME_MS = 30 * 60 * 1_000;
const SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;

function enrollmentHarness() {
  const document = testControlDocument();
  document.pendingDeviceRequests = {};
  document.devices = {};
  const memory = controlStoreHarness(document);
  let loadCount = 0;
  let mutateCount = 0;
  const store: ControlPlaneStore = {
    async load() {
      loadCount += 1;
      return memory.store.load();
    },
    async mutate(name, reducer) {
      mutateCount += 1;
      return memory.store.mutate(name, reducer);
    }
  };
  let currentNow = TEST_NOW;
  const codec = createSealedSessionCodec(testAeadKeyring(), () => currentNow);
  let id = 0;
  const admin = createControlAdminService({
    store,
    cache: memory.cache,
    passphrasePepper: "test-pepper",
    now: () => currentNow,
    createId: () => "device-1"
  });
  const rawSecret = "request-secret-that-never-enters-the-control-document";
  const enrollment = createControlEnrollmentService({
    store,
    codec,
    admin,
    householdId: "h1",
    createId: () => `request-${++id}`,
    issueRequestSecret: () => ({
      raw: rawSecret,
      hash: hashOpaqueToken(rawSecret)
    })
  });
  return {
    admin,
    codec,
    document,
    enrollment,
    firestoreReads: 0,
    get loadCount() {
      return loadCount;
    },
    get mutateCount() {
      return mutateCount;
    },
    memory,
    rawSecret,
    setNow(value: Date) {
      currentNow = value;
    }
  };
}

describe("sealed control enrollment", () => {
  it("creates one pending mutation with only the request-secret hash and a 30-minute sealed cookie", async () => {
    const harness = enrollmentHarness();

    const created = await harness.enrollment.createRequest(
      "  Living Room  ",
      "203.0.113.8",
      TEST_NOW
    );

    const claims = harness.codec.openRequest(created.cookie);
    expect(claims).toEqual({
      version: 2,
      householdId: "h1",
      requestId: "request-1",
      requestSecret: harness.rawSecret,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + REQUEST_LIFETIME_MS
    });
    expect(created.request).toMatchObject({
      id: "request-1",
      requestedName: "Living Room",
      status: "pending",
      expiresAt: new Date(TEST_NOW.getTime() + REQUEST_LIFETIME_MS).toISOString()
    });
    expect(created.setRequestCookie).toMatch(
      /device_request=.*HttpOnly; Secure; SameSite=Lax/
    );
    expect(harness.memory.durable.currentDocument?.pendingDeviceRequests["request-1"])
      .toMatchObject({ requestSecretHash: hashOpaqueToken(harness.rawSecret) });
    expect(JSON.stringify(harness.memory.durable.currentDocument)).not.toContain(
      harness.rawSecret
    );
    expect(harness.loadCount).toBe(0);
    expect(harness.mutateCount).toBe(1);
    expect(harness.memory.durable.writeAttempts).toBe(1);
    expect(harness.firestoreReads).toBe(0);
  });

  it("polls pending request state from Vercel without Firestore reads", async () => {
    const harness = enrollmentHarness();
    const created = await harness.enrollment.createRequest(
      "Living Room",
      "203.0.113.8",
      TEST_NOW
    );

    const status = await harness.enrollment.status(created.cookie, TEST_NOW);

    expect(status.enrollment.state).toBe("pending");
    expect(harness.loadCount).toBe(1);
    expect(harness.firestoreReads).toBe(0);
  });

  it("uses a supplied request context without reloading Vercel state", async () => {
    const harness = enrollmentHarness();
    const created = await harness.enrollment.createRequest(
      "Living Room",
      "203.0.113.8",
      TEST_NOW
    );
    const document = harness.memory.durable.currentDocument!;

    const status = await harness.enrollment.status(
      created.cookie,
      TEST_NOW,
      { document, revision: document.revision }
    );

    expect(status.enrollment.state).toBe("pending");
    expect(harness.loadCount).toBe(0);
  });

  it("approval lets the existing secret-bound request cookie claim the device", async () => {
    const harness = enrollmentHarness();
    const created = await harness.enrollment.createRequest(
      "Living Room",
      "203.0.113.8",
      TEST_NOW
    );

    const approved = await harness.enrollment.approve(
      "request-1",
      { name: "Living Room", rootIds: ["root-1"] },
      TEST_NOW
    );
    expect(approved.device).not.toHaveProperty("lastSeenAt");
    const status = await harness.enrollment.status(created.cookie, TEST_NOW);

    expect(status.enrollment).toMatchObject({
      state: "ready",
      device: {
        id: "device-1",
        name: "Living Room",
        assignedRootIds: ["root-1"]
      }
    });
    expect(status.setDeviceCookie).toMatch(
      /device_session=.*HttpOnly; Secure; SameSite=Lax/
    );
    expect(status.clearRequestCookie).toMatch(/device_request=;.*Max-Age=0/);
    const deviceClaims = harness.codec.openDevice(status.deviceCookie!);
    expect(deviceClaims).toEqual({
      version: 2,
      householdId: "h1",
      deviceId: "device-1",
      sessionVersion: 1,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + SESSION_LIFETIME_MS
    });
    expect(harness.memory.durable.currentDocument?.pendingDeviceRequests["request-1"])
      .toBeUndefined();
    expect(harness.memory.durable.currentDocument?.devices["device-1"])
      .toMatchObject({ sessionVersion: 1, revokedAt: null, enabled: true });
    expect(harness.firestoreReads).toBe(0);
  });

  it("consumes an approved request so a sequential replay cannot claim another device cookie", async () => {
    const harness = enrollmentHarness();
    const created = await harness.enrollment.createRequest(
      "Living Room",
      "203.0.113.8",
      TEST_NOW
    );
    await harness.enrollment.approve(
      "request-1",
      { name: "Living Room", rootIds: ["root-1"] },
      TEST_NOW
    );

    const first = await harness.enrollment.status(created.cookie, TEST_NOW);

    expect(first.setDeviceCookie).toBeTruthy();
    expect(harness.memory.durable.currentDocument?.pendingDeviceRequests["request-1"])
      .toBeUndefined();
    expect(harness.memory.durable.currentDocument?.revision).toBe(4);
    expect(harness.memory.durable.writeAttempts).toBe(3);
    await expect(
      harness.enrollment.status(created.cookie, TEST_NOW)
    ).rejects.toMatchObject({
      code: "DEVICE_REQUEST_REQUIRED",
      clearCookie: expect.stringMatching(/device_request=;.*Max-Age=0/)
    });
  });

  it("allows exactly one of two concurrent approved-request claims to receive a device cookie", async () => {
    const harness = enrollmentHarness();
    const created = await harness.enrollment.createRequest(
      "Living Room",
      "203.0.113.8",
      TEST_NOW
    );
    await harness.enrollment.approve(
      "request-1",
      { name: "Living Room", rootIds: ["root-1"] },
      TEST_NOW
    );

    const claims = await Promise.allSettled([
      harness.enrollment.status(created.cookie, TEST_NOW),
      harness.enrollment.status(created.cookie, TEST_NOW)
    ]);

    const fulfilled = claims.filter(
      (claim): claim is PromiseFulfilledResult<Awaited<ReturnType<typeof harness.enrollment.status>>> =>
        claim.status === "fulfilled"
    );
    const rejected = claims.filter(
      (claim): claim is PromiseRejectedResult => claim.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.setDeviceCookie).toBeTruthy();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      code: "DEVICE_REQUEST_REQUIRED",
      clearCookie: expect.stringMatching(/device_request=;.*Max-Age=0/)
    });
    expect(harness.memory.durable.currentDocument?.pendingDeviceRequests["request-1"])
      .toBeUndefined();
  });

  it("uses the supplied approval time for the device and approved request record", async () => {
    const harness = enrollmentHarness();
    await harness.enrollment.createRequest(
      "Living Room",
      "203.0.113.8",
      TEST_NOW
    );
    const approvedAt = new Date(TEST_NOW.getTime() + 5 * 60_000);

    await harness.enrollment.approve(
      "request-1",
      { name: "Living Room", rootIds: ["root-1"] },
      approvedAt
    );

    expect(harness.memory.durable.currentDocument?.devices["device-1"])
      .toMatchObject({
        createdAt: approvedAt.toISOString(),
        approvedAt: approvedAt.toISOString()
      });
    expect(harness.memory.durable.currentDocument?.pendingDeviceRequests["request-1"])
      .toMatchObject({ resolvedAt: approvedAt.toISOString() });
  });

  it.each(["denied", "expired"] as const)(
    "clears the request cookie for %s enrollment",
    async (state) => {
      const harness = enrollmentHarness();
      const created = await harness.enrollment.createRequest(
        "Living Room",
        "203.0.113.8",
        TEST_NOW
      );
      if (state === "denied") {
        await harness.enrollment.deny("request-1", TEST_NOW);
      } else {
        const current = harness.memory.durable.currentDocument!;
        current.pendingDeviceRequests["request-1"]!.expiresAt = new Date(
          TEST_NOW.getTime() - 1
        ).toISOString();
        current.pendingDeviceRequests["request-1"]!.status = "expired";
        current.pendingDeviceRequests["request-1"]!.resolvedAt = TEST_NOW.toISOString();
        harness.memory.durable.replaceOutOfBand(current, testAeadKeyring());
      }

      const status = await harness.enrollment.status(created.cookie, TEST_NOW);

      expect(status.enrollment.state).toBe(state);
      expect(status.clearRequestCookie).toMatch(/device_request=;.*Max-Age=0/);
      expect(status.setDeviceCookie).toBeUndefined();
    }
  );

  it("treats an approved request as revoked when its device is disabled, revoked, or missing", async () => {
    for (const scenario of ["disabled", "revoked", "missing"] as const) {
      const harness = enrollmentHarness();
      const created = await harness.enrollment.createRequest(
        "Living Room",
        "203.0.113.8",
        TEST_NOW
      );
      await harness.enrollment.approve(
        "request-1",
        { name: "Living Room", rootIds: ["root-1"] },
        TEST_NOW
      );
      const current = harness.memory.durable.currentDocument!;
      if (scenario === "disabled") current.devices["device-1"]!.enabled = false;
      if (scenario === "revoked") current.devices["device-1"]!.revokedAt = TEST_NOW.toISOString();
      if (scenario === "missing") delete current.devices["device-1"];
      harness.memory.durable.replaceOutOfBand(current, testAeadKeyring());

      const status = await harness.enrollment.status(created.cookie, TEST_NOW);

      expect(status.enrollment.state).toBe("revoked");
      expect(status.clearRequestCookie).toMatch(/device_request=;.*Max-Age=0/);
      expect(status.deviceCookie).toBeUndefined();
    }
  });

  it("rejects a cookie whose secret or household does not match the current request", async () => {
    const harness = enrollmentHarness();
    const created = await harness.enrollment.createRequest(
      "Living Room",
      "203.0.113.8",
      TEST_NOW
    );
    const claims = harness.codec.openRequest(created.cookie);

    for (const token of [
      harness.codec.issueRequest({ ...claims, requestSecret: "wrong-secret" }),
      harness.codec.issueRequest({ ...claims, householdId: "other" })
    ]) {
      await expect(
        harness.enrollment.status(token, TEST_NOW)
      ).rejects.toMatchObject({
        code: "DEVICE_REQUEST_REQUIRED",
        clearCookie: expect.stringMatching(/device_request=;.*Max-Age=0/)
      });
    }
  });

  it("rejects request creation when enrollment is disabled without writing", async () => {
    const harness = enrollmentHarness();
    const current = harness.memory.durable.currentDocument!;
    current.household.allowNewDeviceRequests = false;
    harness.memory.durable.replaceOutOfBand(current, testAeadKeyring());

    await expect(
      harness.enrollment.createRequest("Living Room", "203.0.113.8", TEST_NOW)
    ).rejects.toBeInstanceOf(ControlEnrollmentError);

    expect(harness.memory.durable.writeAttempts).toBe(0);
    expect(harness.memory.durable.currentDocument?.pendingDeviceRequests).toEqual({});
  });
});
