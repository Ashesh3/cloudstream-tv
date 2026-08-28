import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ControlAuthError,
  createControlAuth,
  createSealedSessionCodec,
  csrfToken,
  hashPassphrase,
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

const PASSPHRASE = "correct horse battery staple";
const PEPPER = "test-passphrase-pepper";
const CSRF_SECRET = "test-csrf-secret-that-is-long-enough";
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

async function authHarness() {
  const document = testControlDocument();
  document.household.adminPassphraseHash = await hashPassphrase(PASSPHRASE, PEPPER);
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
  const waited: number[] = [];
  const auth = createControlAuth({
    store,
    codec,
    householdId: "h1",
    passphrasePepper: PEPPER,
    csrfSecret: CSRF_SECRET,
    failedLoginDelayMs: 275,
    createId: () => "admin-session-1",
    monotonicNow: () => 10,
    wait: async (milliseconds) => {
      waited.push(milliseconds);
    }
  });
  return {
    auth,
    codec,
    context: { document, revision: document.revision },
    document,
    firestoreReads: 0,
    get loadCount() {
      return loadCount;
    },
    get mutateCount() {
      return mutateCount;
    },
    memory,
    setNow(value: Date) {
      currentNow = value;
    },
    waited
  };
}

function requestWithCookie(name: string, value: string): Request {
  return new Request("https://app.test/api", {
    headers: { cookie: `${name}=${encodeURIComponent(value)}` }
  });
}

function deviceClaims() {
  return {
    version: 2 as const,
    householdId: "h1",
    deviceId: "device-1",
    sessionVersion: 1,
    issuedAt: TEST_NOW.getTime(),
    expiresAt: TEST_NOW.getTime() + 60_000
  };
}

function adminClaims() {
  return {
    version: 2 as const,
    householdId: "h1",
    sessionId: "admin-session-1",
    adminPassphraseVersion: 1,
    issuedAt: TEST_NOW.getTime(),
    expiresAt: TEST_NOW.getTime() + 60_000
  };
}

describe("sealed control authentication", () => {
  it("authenticates a TV from the sealed cookie and request-scoped control document only", async () => {
    const harness = await authHarness();

    const result = await harness.auth.device(
      requestWithCookie(
        "device_session",
        harness.codec.issueDevice(deviceClaims())
      ),
      harness.context,
      TEST_NOW
    );

    expect(result.device.id).toBe("device-1");
    expect(result.sessionVersion).toBe(1);
    expect(harness.loadCount).toBe(0);
    expect(harness.firestoreReads).toBe(0);
  });

  it.each([
    ["disabled", (harness: Awaited<ReturnType<typeof authHarness>>) => {
      harness.document.devices["device-1"]!.enabled = false;
    }],
    ["revoked", (harness: Awaited<ReturnType<typeof authHarness>>) => {
      harness.document.devices["device-1"]!.revokedAt = TEST_NOW.toISOString();
    }],
    ["stale session", (harness: Awaited<ReturnType<typeof authHarness>>) => {
      harness.document.devices["device-1"]!.sessionVersion = 2;
    }]
  ])("rejects a %s device on the next request", async (_scenario, arrange) => {
    const harness = await authHarness();
    arrange(harness);

    await expect(
      harness.auth.device(
        requestWithCookie(
          "device_session",
          harness.codec.issueDevice(deviceClaims())
        ),
        harness.context,
        TEST_NOW
      )
    ).rejects.toMatchObject({
      code: "DEVICE_UNAUTHORIZED",
      clearCookie: expect.stringMatching(/device_session=;.*Max-Age=0/)
    });
    expect(harness.loadCount).toBe(0);
  });

  it.each([
    ["disabled", (harness: Awaited<ReturnType<typeof authHarness>>) => { harness.document.devices["device-1"]!.enabled = false; }],
    ["revoked", (harness: Awaited<ReturnType<typeof authHarness>>) => { harness.document.devices["device-1"]!.revokedAt = TEST_NOW.toISOString(); }],
    ["stale session", (harness: Awaited<ReturnType<typeof authHarness>>) => { harness.document.devices["device-1"]!.sessionVersion = 2; }]
  ])("classifies a current %s device claim as revoked", async (_scenario, arrange) => {
    const harness = await authHarness();
    arrange(harness);
    await expect(harness.auth.device(
      requestWithCookie("device_session", harness.codec.issueDevice(deviceClaims())),
      harness.context,
      TEST_NOW
    )).rejects.toMatchObject({ code: "DEVICE_UNAUTHORIZED", reason: "revoked" });
  });

  it.each([
    ["unknown device", { deviceId: "missing-device" }],
    ["wrong household", { householdId: "other-household" }]
  ])("does not classify %s claims as revoked", async (_scenario, patch) => {
    const harness = await authHarness();
    await expect(harness.auth.device(
      requestWithCookie("device_session", harness.codec.issueDevice({ ...deviceClaims(), ...patch })),
      harness.context,
      TEST_NOW
    )).rejects.toMatchObject({ code: "DEVICE_UNAUTHORIZED", reason: "invalid" });
  });

  it("requires the optional root check to be enabled and assigned to the device", async () => {
    const harness = await authHarness();
    const request = requestWithCookie(
      "device_session",
      harness.codec.issueDevice(deviceClaims())
    );

    await expect(
      harness.auth.device(request, harness.context, TEST_NOW, "root-1")
    ).resolves.toMatchObject({ root: { id: "root-1" } });

    harness.document.devices["device-1"]!.assignedRootIds = [];
    await expect(
      harness.auth.device(request, harness.context, TEST_NOW, "root-1")
    ).rejects.toMatchObject({ code: "DEVICE_UNAUTHORIZED" });

    harness.document.devices["device-1"]!.assignedRootIds = ["root-1"];
    harness.document.roots["root-1"]!.enabled = false;
    await expect(
      harness.auth.device(request, harness.context, TEST_NOW, "root-1")
    ).rejects.toMatchObject({ code: "DEVICE_UNAUTHORIZED" });
  });

  it("rejects sealed claims expired at the request time even when the codec clock has not advanced", async () => {
    const harness = await authHarness();
    const requestTime = new Date(TEST_NOW.getTime() + 60_000);

    await expect(
      harness.auth.device(
        requestWithCookie(
          "device_session",
          harness.codec.issueDevice(deviceClaims())
        ),
        harness.context,
        requestTime
      )
    ).rejects.toMatchObject({ code: "DEVICE_UNAUTHORIZED" });

    await expect(
      harness.auth.admin(
        requestWithCookie(
          "admin_session",
          harness.codec.issueAdmin(adminClaims())
        ),
        harness.context,
        requestTime
      )
    ).rejects.toMatchObject({ code: "ADMIN_UNAUTHORIZED" });
  });

  it("authenticates an admin from current claims and derives CSRF from the sealed session ID", async () => {
    const harness = await authHarness();
    const token = harness.codec.issueAdmin(adminClaims());

    const result = await harness.auth.admin(
      requestWithCookie("admin_session", token),
      harness.context,
      TEST_NOW
    );

    const expectedCsrf = createHmac("sha256", CSRF_SECRET)
      .update("admin-csrf\u0000admin-session-1")
      .digest("hex");
    expect(result).toMatchObject({
      householdId: "h1",
      sessionId: "admin-session-1",
      csrfToken: expectedCsrf
    });
    expect(result.csrfToken).toBe(csrfToken("admin-session-1", CSRF_SECRET));
    expect(harness.loadCount).toBe(0);
  });

  it.each([
    ["admin_session", "admin"],
    ["device_session", "device"]
  ] as const)(
    "rejects duplicate %s cookies without loading control state",
    async (cookieName, kind) => {
      const harness = await authHarness();
      const token = kind === "admin"
        ? harness.codec.issueAdmin(adminClaims())
        : harness.codec.issueDevice(deviceClaims());
      const request = new Request("https://app.test/api", {
        headers: {
          cookie: `${cookieName}=${encodeURIComponent(token)}; ${cookieName}=${encodeURIComponent(token)}`
        }
      });

      const promise = kind === "admin"
        ? harness.auth.admin(request, harness.context, TEST_NOW)
        : harness.auth.device(request, harness.context, TEST_NOW);

      await expect(promise).rejects.toMatchObject({
        code: kind === "admin" ? "ADMIN_UNAUTHORIZED" : "DEVICE_UNAUTHORIZED",
        clearCookie: expect.stringMatching(
          new RegExp(`${cookieName}=;.*Max-Age=0`)
        )
      });
      expect(harness.loadCount).toBe(0);
    }
  );

  it.each([
    ["cross-household", { householdId: "other" }],
    ["stale passphrase", { adminPassphraseVersion: 2 }]
  ])("rejects an admin cookie with %s claims", async (_scenario, patch) => {
    const harness = await authHarness();
    const token = harness.codec.issueAdmin({ ...adminClaims(), ...patch });

    await expect(
      harness.auth.admin(
        requestWithCookie("admin_session", token),
        harness.context,
        TEST_NOW
      )
    ).rejects.toMatchObject({
      code: "ADMIN_UNAUTHORIZED",
      clearCookie: expect.stringMatching(/admin_session=;.*Max-Age=0/)
    });
    expect(harness.loadCount).toBe(0);
  });

  it("logs in from one active Vercel snapshot and issues a one-year sealed cookie without a session mutation", async () => {
    const harness = await authHarness();

    const result = await harness.auth.login(PASSPHRASE, TEST_NOW);

    const claims = harness.codec.openAdmin(result.cookie);
    expect(claims).toEqual({
      version: 2,
      householdId: "h1",
      sessionId: "admin-session-1",
      adminPassphraseVersion: 1,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + YEAR_MS
    });
    expect(result.setCookie).toMatch(
      /admin_session=.*Expires=Fri, 27 Aug 2027 08:00:00 GMT; Path=\/; HttpOnly; Secure; SameSite=Lax/
    );
    expect(result.csrfToken).toBe(
      createHmac("sha256", CSRF_SECRET)
        .update("admin-csrf\u0000admin-session-1")
        .digest("hex")
    );
    expect(harness.loadCount).toBe(1);
    expect(harness.mutateCount).toBe(0);
    expect(harness.memory.durable.writeAttempts).toBe(0);
  });

  it("waits at least the configured delay after failed Argon2 verification", async () => {
    const harness = await authHarness();

    await expect(
      harness.auth.login("wrong passphrase value", TEST_NOW)
    ).rejects.toBeInstanceOf(ControlAuthError);

    expect(harness.waited).toEqual([275]);
    expect(harness.loadCount).toBe(1);
    expect(harness.mutateCount).toBe(0);
  });

  it("subtracts Argon2 verification time from the configured failed-login delay", async () => {
    const harness = await authHarness();
    const samples = [1_000, 1_125];
    const waited: number[] = [];
    const auth = createControlAuth({
      store: {
        load: () => harness.memory.store.load(),
        mutate: (name, reducer) => harness.memory.store.mutate(name, reducer)
      },
      codec: harness.codec,
      householdId: "h1",
      passphrasePepper: PEPPER,
      csrfSecret: CSRF_SECRET,
      failedLoginDelayMs: 275,
      monotonicNow: () => samples.shift()!,
      wait: async (milliseconds) => {
        waited.push(milliseconds);
      }
    });

    await expect(
      auth.login("wrong passphrase value", TEST_NOW)
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    expect(waited).toEqual([150]);
  });

  it("normalizes a household mismatch to delayed invalid credentials", async () => {
    const harness = await authHarness();
    const current = harness.memory.durable.currentDocument!;
    current.householdId = "other-household";
    harness.memory.durable.replaceOutOfBand(current, testAeadKeyring());

    await expect(
      harness.auth.login(PASSPHRASE, TEST_NOW)
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    expect(harness.waited).toEqual([275]);
    expect(harness.loadCount).toBe(1);
  });

  it("normalizes a malformed Argon2 hash to delayed invalid credentials", async () => {
    const harness = await authHarness();
    const current = harness.memory.durable.currentDocument!;
    current.household.adminPassphraseHash = "malformed-argon2-hash";
    harness.memory.durable.replaceOutOfBand(current, testAeadKeyring());

    await expect(
      harness.auth.login(PASSPHRASE, TEST_NOW)
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    expect(harness.waited).toEqual([275]);
    expect(harness.loadCount).toBe(1);
  });

  it("preserves control-store errors that happen before a login document is obtained", async () => {
    const expected = new Error("CONTROL_PLANE_UNAVAILABLE");
    const waited: number[] = [];
    const harness = await authHarness();
    const auth = createControlAuth({
      store: {
        load: async () => {
          throw expected;
        },
        mutate: (name, reducer) => harness.memory.store.mutate(name, reducer)
      },
      codec: harness.codec,
      householdId: "h1",
      passphrasePepper: PEPPER,
      csrfSecret: CSRF_SECRET,
      failedLoginDelayMs: 275,
      wait: async (milliseconds) => {
        waited.push(milliseconds);
      }
    });

    await expect(auth.login(PASSPHRASE, TEST_NOW)).rejects.toBe(expected);
    expect(waited).toEqual([]);
  });

  it("logs out by clearing the sealed cookie only", async () => {
    const harness = await authHarness();

    expect(harness.auth.logout()).toMatchObject({
      authenticated: false,
      clearCookie: expect.stringMatching(/admin_session=;.*Max-Age=0/)
    });
    expect(harness.loadCount).toBe(0);
    expect(harness.mutateCount).toBe(0);
  });
});
