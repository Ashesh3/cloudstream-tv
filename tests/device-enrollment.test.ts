import type {
  AssignedRoot,
  Device,
  DeviceRequest,
  DeviceSession
} from "@cloudframe/shared";
import { hashOpaqueToken } from "@cloudframe/server";
import { describe, expect, it } from "vitest";
import {
  cookieHeader,
  cookieValue,
  createTestApi,
  jsonRequest,
  setCookies
} from "./helpers/api";

describe("device enrollment policy", () => {
  it("rejects a device request while new requests are disabled", async () => {
    const { app } = await createTestApi({ allowNewDeviceRequests: false });

    const response = await app(
      jsonRequest("/api/device-requests", "POST", { name: "Living Room" })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "DEVICE_REQUESTS_DISABLED"
    });
  });

  it.each(["", "   ", "x".repeat(81)])(
    "rejects an invalid device name without persisting a request: %j",
    async name => {
      const { app, repository, householdId } = await createTestApi();
      const response = await app(
        jsonRequest("/api/device-requests", "POST", { name })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "INVALID_DEVICE_NAME"
      });
      expect(await repository.listDeviceRequests(householdId)).toEqual([]);
    }
  );

  it("creates a 30-minute opaque request cookie and stores only its hash", async () => {
    const { app, repository, householdId, now } = await createTestApi();

    const response = await app(
      jsonRequest("/api/device-requests", "POST", { name: "  Living Room  " })
    );

    expect(response.status).toBe(201);
    const raw = cookieValue(response, "device_request");
    expect(raw).toBeTruthy();
    expect(setCookies(response).join("\n")).toMatch(
      /device_request=.*HttpOnly; Secure; SameSite=Lax/
    );
    const requests = await repository.listDeviceRequests(householdId);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestedName: "Living Room",
      requestSecretHash: hashOpaqueToken(raw!),
      status: "pending",
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000)
    });
    expect(JSON.stringify(requests[0])).not.toContain(raw!);
  });

  it("reports pending enrollment using only the request cookie", async () => {
    const { app } = await createTestApi();
    const create = await app(
      jsonRequest("/api/device-requests", "POST", { name: "Living Room" })
    );
    const raw = cookieValue(create, "device_request")!;

    const status = await app(
      jsonRequest("/api/device-requests/status", "GET", undefined, {
        cookie: cookieHeader(["device_request", raw])
      })
    );

    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body).toMatchObject({
      ok: true,
      data: { enrollment: { state: "pending", request: { requestedName: "Living Room" } } }
    });
    expect(JSON.stringify(body)).not.toContain("requestSecretHash");
  });

  it("clears an invalid device cookie when bootstrap falls back to unenrolled", async () => {
    const { app } = await createTestApi();

    const response = await app(
      jsonRequest("/api/bootstrap", "GET", undefined, {
        cookie: cookieHeader(["device_session", "invalid-device-token"])
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { enrollment: { state: "unenrolled" } }
    });
    expect(
      setCookies(response).some(value =>
        /device_session=;.*Max-Age=0/.test(value)
      )
    ).toBe(true);
  });

  it("preserves device-cookie clearing when bootstrap falls back to request status", async () => {
    const { app } = await createTestApi();
    const created = await app(
      jsonRequest("/api/device-requests", "POST", { name: "Living Room" })
    );
    const requestRaw = cookieValue(created, "device_request")!;

    const response = await app(
      jsonRequest("/api/bootstrap", "GET", undefined, {
        cookie: cookieHeader(
          ["device_session", "invalid-device-token"],
          ["device_request", requestRaw]
        )
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { enrollment: { state: "pending" } }
    });
    expect(
      setCookies(response).some(value =>
        /device_session=;.*Max-Age=0/.test(value)
      )
    ).toBe(true);
  });

  it("does not hide unexpected device-auth repository failures during bootstrap", async () => {
    const { app, repository } = await createTestApi();
    repository.authenticateDeviceSession = async () => {
      throw new Error("firestore unavailable");
    };

    const response = await app(
      jsonRequest("/api/bootstrap", "GET", undefined, {
        cookie: cookieHeader(["device_session", "device-token"])
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred."
    });
  });

  it("atomically approves and promotes the request secret into a permanent device cookie", async () => {
    const { app, repository, householdId, origin } = await createTestApi();
    const root = makeRoot(householdId);
    await repository.putRoot(root);
    const create = await app(
      jsonRequest("/api/device-requests", "POST", { name: "Living Room" })
    );
    const requestRaw = cookieValue(create, "device_request")!;
    const request = (await repository.listDeviceRequests(householdId))[0]!;
    const admin = await login(app);

    const approval = await app(
      jsonRequest(
        `/api/admin/requests/${request.id}/approve`,
        "POST",
        { name: "  Family TV  ", rootIds: [root.id] },
        adminMutationHeaders(origin, admin)
      )
    );
    expect(approval.status).toBe(200);
    expect(await repository.getDeviceRequest(request.id)).toMatchObject({
      status: "approved"
    });
    const status = await app(
      jsonRequest("/api/device-requests/status", "GET", undefined, {
        cookie: cookieHeader(["device_request", requestRaw])
      })
    );

    expect(status.status).toBe(200);
    expect(cookieValue(status, "device_session")).toBe(requestRaw);
    expect(setCookies(status).some(value => /device_request=;.*Max-Age=0/.test(value))).toBe(true);
    await expect(status.json()).resolves.toMatchObject({
      ok: true,
      data: {
        enrollment: {
          state: "ready",
          device: { name: "Family TV", assignedRootIds: [root.id] }
        }
      }
    });
    expect(await repository.getDeviceSessionByHash(hashOpaqueToken(requestRaw))).toMatchObject({
      tokenHash: request.requestSecretHash
    });
  });

  it.each([
    { body: { name: "TV", rootIds: [] }, code: "ROOT_ASSIGNMENT_REQUIRED" },
    { body: { name: "TV", rootIds: ["root-1", "root-1"] }, code: "INVALID_ROOT_ASSIGNMENT" },
    { body: { name: "TV", rootIds: ["missing"] }, code: "INVALID_ROOT_ASSIGNMENT" }
  ])("rejects unsafe approval roots", async ({ body, code }) => {
    const { app, repository, householdId, origin } = await createTestApi();
    await repository.putRoot(makeRoot(householdId));
    const request = await createPendingRequest(app, repository, householdId);
    const admin = await login(app);

    const response = await app(
      jsonRequest(
        `/api/admin/requests/${request.id}/approve`,
        "POST",
        body,
        adminMutationHeaders(origin, admin)
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code });
    expect((await repository.getDeviceRequest(request.id))?.status).toBe("pending");
  });

  it("rejects disabled and cross-household roots", async () => {
    const { app, repository, householdId, origin } = await createTestApi();
    await repository.putRoot({ ...makeRoot(householdId), enabled: false });
    await repository.putRoot({ ...makeRoot("other"), id: "root-other" });
    const request = await createPendingRequest(app, repository, householdId);
    const admin = await login(app);

    for (const rootId of ["root-1", "root-other"]) {
      const response = await app(
        jsonRequest(
          `/api/admin/requests/${request.id}/approve`,
          "POST",
          { name: "TV", rootIds: [rootId] },
          adminMutationHeaders(origin, admin)
        )
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "INVALID_ROOT_ASSIGNMENT"
      });
    }
  });

  it("revalidates roots inside approval so a concurrently disabled root cannot be assigned", async () => {
    const { app, repository, householdId, origin } = await createTestApi();
    const root = makeRoot(householdId);
    await repository.putRoot(root);
    const request = await createPendingRequest(app, repository, householdId);
    const admin = await login(app);
    const original = repository.approveDeviceRequestWithRoots.bind(repository);
    repository.approveDeviceRequestWithRoots = async input => {
      await repository.putRoot({ ...root, enabled: false });
      return original(input);
    };

    const response = await app(
      jsonRequest(
        `/api/admin/requests/${request.id}/approve`,
        "POST",
        { name: "TV", rootIds: [root.id] },
        adminMutationHeaders(origin, admin)
      )
    );

    expect(response.status).toBe(409);
    expect((await repository.getDeviceRequest(request.id))?.status).toBe("pending");
    expect(await repository.listDevices(householdId)).toEqual([]);
  });

  it("denies a pending request atomically and clears its cookie on polling", async () => {
    const { app, repository, householdId, origin } = await createTestApi();
    const create = await app(
      jsonRequest("/api/device-requests", "POST", { name: "Bedroom" })
    );
    const raw = cookieValue(create, "device_request")!;
    const request = (await repository.listDeviceRequests(householdId))[0]!;
    const admin = await login(app);

    const denied = await app(
      jsonRequest(
        `/api/admin/requests/${request.id}/deny`,
        "POST",
        {},
        adminMutationHeaders(origin, admin)
      )
    );
    expect(denied.status).toBe(200);
    const status = await app(
      jsonRequest("/api/device-requests/status", "GET", undefined, {
        cookie: cookieHeader(["device_request", raw])
      })
    );
    await expect(status.json()).resolves.toMatchObject({
      ok: true,
      data: { enrollment: { state: "denied" } }
    });
    expect(setCookies(status).some(value => /device_request=;.*Max-Age=0/.test(value))).toBe(true);
  });

  it("distinguishes missing denial requests from unexpected repository failures", async () => {
    const missing = await createTestApi();
    const missingAdmin = await login(missing.app);
    const missingResponse = await missing.app(
      jsonRequest(
        "/api/admin/requests/missing/deny",
        "POST",
        {},
        adminMutationHeaders(missing.origin, missingAdmin)
      )
    );
    expect(missingResponse.status).toBe(404);

    const failed = await createTestApi();
    const failedAdmin = await login(failed.app);
    failed.repository.denyDeviceRequest = async () => {
      throw new Error("firestore unavailable");
    };
    const failedResponse = await failed.app(
      jsonRequest(
        "/api/admin/requests/request-1/deny",
        "POST",
        {},
        adminMutationHeaders(failed.origin, failedAdmin)
      )
    );
    expect(failedResponse.status).toBe(500);
    await expect(failedResponse.json()).resolves.toMatchObject({
      code: "INTERNAL_ERROR"
    });
  });

  it("does not disguise an unexpected approval repository failure as a conflict", async () => {
    const { app, repository, householdId, origin } = await createTestApi();
    const root = makeRoot(householdId);
    await repository.putRoot(root);
    const request = await createPendingRequest(app, repository, householdId);
    const admin = await login(app);
    repository.approveDeviceRequestWithRoots = async () => {
      throw new Error("firestore unavailable");
    };

    const response = await app(
      jsonRequest(
        `/api/admin/requests/${request.id}/approve`,
        "POST",
        { name: "TV", rootIds: [root.id] },
        adminMutationHeaders(origin, admin)
      )
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "INTERNAL_ERROR"
    });
  });

  it("expires pending requests at the 30-minute boundary", async () => {
    const base = new Date("2026-08-26T12:00:00.000Z");
    const first = await createTestApi({ now: base });
    const create = await first.app(
      jsonRequest("/api/device-requests", "POST", { name: "Bedroom" })
    );
    const raw = cookieValue(create, "device_request")!;
    const expired = await createTestApi({ now: new Date(base.getTime() + 30 * 60 * 1000) });
    const request = (await first.repository.listDeviceRequests(first.householdId))[0]!;
    await expired.repository.putHousehold((await first.repository.getHousehold(first.householdId))!);
    await expired.repository.createDeviceRequest(request);

    const status = await expired.app(
      jsonRequest("/api/device-requests/status", "GET", undefined, {
        cookie: cookieHeader(["device_request", raw])
      })
    );
    await expect(status.json()).resolves.toMatchObject({
      data: { enrollment: { state: "expired" } }
    });
    expect((await expired.repository.getDeviceRequest(request.id))?.status).toBe("expired");
  });

  it("updates a device with validated roots and revokes access on the next heartbeat", async () => {
    const { app, repository, householdId, origin, now } = await createTestApi();
    const root = makeRoot(householdId);
    await repository.putRoot(root);
    const raw = "d".repeat(43);
    const device = makeDevice(householdId, now, root.id);
    const session = makeDeviceSession(householdId, now, device.id, raw);
    await repository.putDevice(device);
    await repository.putDeviceSession(session);
    const admin = await login(app);

    const updated = await app(
      jsonRequest(
        `/api/admin/devices/${device.id}`,
        "PATCH",
        { name: "  Den TV  ", assignedRootIds: [root.id], slideshowSeconds: 12 },
        adminMutationHeaders(origin, admin)
      )
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: { device: { name: "Den TV", slideshowSeconds: 12 } }
    });

    const revoked = await app(
      jsonRequest(
        `/api/admin/devices/${device.id}`,
        "DELETE",
        {},
        adminMutationHeaders(origin, admin)
      )
    );
    expect(revoked.status).toBe(200);
    const heartbeat = await app(
      jsonRequest("/api/tv/heartbeat", "POST", {}, {
        cookie: cookieHeader(["device_session", raw])
      })
    );
    expect(heartbeat.status).toBe(401);
    await expect(heartbeat.json()).resolves.toMatchObject({
      code: "DEVICE_UNAUTHORIZED"
    });
    expect(setCookies(heartbeat).some(value => /device_session=;.*Max-Age=0/.test(value))).toBe(true);
  });

  it("maps only a known missing device to 404 during revocation", async () => {
    const missing = await createTestApi();
    const missingAdmin = await login(missing.app);
    const missingResponse = await missing.app(
      jsonRequest(
        "/api/admin/devices/missing",
        "DELETE",
        {},
        adminMutationHeaders(missing.origin, missingAdmin)
      )
    );
    expect(missingResponse.status).toBe(404);

    const failed = await createTestApi();
    const failedAdmin = await login(failed.app);
    failed.repository.revokeDevice = async () => {
      throw new Error("firestore unavailable");
    };
    const failedResponse = await failed.app(
      jsonRequest(
        "/api/admin/devices/device-1",
        "DELETE",
        {},
        adminMutationHeaders(failed.origin, failedAdmin)
      )
    );
    expect(failedResponse.status).toBe(500);
    await expect(failedResponse.json()).resolves.toMatchObject({
      code: "INTERNAL_ERROR"
    });
  });

  it("renews a valid device session only inside the final 30 days", async () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    const { app, repository, householdId } = await createTestApi({ now });
    const root = makeRoot(householdId);
    await repository.putRoot(root);
    const raw = "r".repeat(43);
    const device = makeDevice(householdId, now, root.id);
    await repository.putDevice(device);
    await repository.putDeviceSession({
      ...makeDeviceSession(householdId, now, device.id, raw),
      expiresAt: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000)
    });

    const heartbeat = await app(
      jsonRequest("/api/tv/heartbeat", "POST", {}, {
        cookie: cookieHeader(["device_session", raw])
      })
    );

    expect(heartbeat.status).toBe(200);
    expect(cookieValue(heartbeat, "device_session")).toBe(raw);
    expect(await repository.getDeviceSessionByHash(hashOpaqueToken(raw))).toMatchObject({
      expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
    });
  });

  it("rate-limits request creation and status polling with retry metadata", async () => {
    const { app } = await createTestApi({
      rateLimits: {
        "device-request-create": { limit: 1, windowSeconds: 60 },
        "device-request-status": { limit: 1, windowSeconds: 60 }
      }
    });
    const first = await app(
      jsonRequest("/api/device-requests", "POST", { name: "TV" }, { "x-forwarded-for": "203.0.113.8" })
    );
    const raw = cookieValue(first, "device_request")!;
    const second = await app(
      jsonRequest("/api/device-requests", "POST", { name: "TV 2" }, { "x-forwarded-for": "203.0.113.8" })
    );
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 60
    });
    const headers = { cookie: cookieHeader(["device_request", raw]) };
    expect((await app(jsonRequest("/api/device-requests/status", "GET", undefined, headers))).status).toBe(200);
    expect((await app(jsonRequest("/api/device-requests/status", "GET", undefined, headers))).status).toBe(429);
  });
});

interface AdminCredentials {
  raw: string;
  csrf: string;
}

async function login(app: (request: Request) => Promise<Response>): Promise<AdminCredentials> {
  const response = await app(
    jsonRequest("/api/admin/login", "POST", {
      passphrase: "correct horse battery staple"
    })
  );
  expect(response.status).toBe(200);
  return {
    raw: cookieValue(response, "admin_session")!,
    csrf: response.headers.get("x-csrf-token")!
  };
}

function adminMutationHeaders(origin: string, credentials: AdminCredentials): HeadersInit {
  return {
    origin,
    "x-csrf-token": credentials.csrf,
    cookie: cookieHeader(["admin_session", credentials.raw])
  };
}

async function createPendingRequest(
  app: (request: Request) => Promise<Response>,
  repository: { listDeviceRequests(householdId: string): Promise<DeviceRequest[]> },
  householdId: string
): Promise<DeviceRequest> {
  await app(jsonRequest("/api/device-requests", "POST", { name: "TV" }));
  return (await repository.listDeviceRequests(householdId))[0]!;
}

function makeRoot(householdId: string): AssignedRoot {
  return {
    id: "root-1",
    householdId,
    sourceId: "source-1",
    providerNodeId: "provider-root",
    displayName: "Family",
    ancestryProviderIds: [],
    enabled: true,
    createdAt: new Date("2026-08-26T12:00:00.000Z")
  };
}

function makeDevice(householdId: string, now: Date, rootId: string): Device {
  return {
    id: "device-1",
    householdId,
    name: "Living Room",
    enabled: true,
    assignedRootIds: [rootId],
    mediaOrder: null,
    slideshowSeconds: null,
    createdAt: now,
    approvedAt: now,
    lastSeenAt: now,
    revokedAt: null
  };
}

function makeDeviceSession(
  householdId: string,
  now: Date,
  deviceId: string,
  raw: string
): DeviceSession {
  return {
    id: "device-session-1",
    householdId,
    deviceId,
    tokenHash: hashOpaqueToken(raw),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
    revokedAt: null
  };
}
