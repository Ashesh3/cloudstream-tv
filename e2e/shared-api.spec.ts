import { expect, test } from "@playwright/test";

import { cookieHeader, cookieValue, createControlApiHarness, jsonRequest } from "../tests/helpers/api";

test("shared final API promotes enrollment, enforces reassignment, clears revoked sessions, and removes obsolete routes", async () => {
  const harness = await createControlApiHarness();
  const requestHeaders = { cookie: cookieHeader(["device_request", harness.requestCookie]) };

  const pending = await harness.app(jsonRequest("/api/device-requests/status", "GET", undefined, requestHeaders));
  expect(pending.status).toBe(200);
  expect(await pending.json()).toMatchObject({ ok: true, data: { enrollment: { state: "pending" } } });

  const approval = await harness.app(jsonRequest(
    "/api/admin/requests/request-1/approve",
    "POST",
    { name: "Living Room", rootIds: ["root-1"] },
    harness.adminMutationHeaders()
  ));
  expect(approval.status).toBe(200);
  const approvalBody = await approval.json() as { data: { device: { id: string } } };
  const deviceId = approvalBody.data.device.id;

  const promotion = await harness.app(jsonRequest("/api/device-requests/status", "GET", undefined, requestHeaders));
  expect(promotion.status).toBe(200);
  expect(await promotion.json()).toMatchObject({ ok: true, data: { enrollment: { state: "ready", device: { id: deviceId } } } });
  const promotedDeviceCookie = cookieValue(promotion, "device_session");
  expect(promotedDeviceCookie).toBeTruthy();
  expect(promotion.headers.getSetCookie().join("\n")).toMatch(/device_request=;.*Max-Age=0/);

  const deviceHeaders = { cookie: cookieHeader(["device_session", promotedDeviceCookie!]) };
  const home = await harness.app(jsonRequest("/api/tv/home", "GET", undefined, deviceHeaders));
  expect(home.status).toBe(200);
  expect(await home.json()).toMatchObject({ ok: true, data: { roots: [{ id: expect.stringMatching(/^item_/) }] } });

  const reassigned = await harness.app(jsonRequest(
    `/api/admin/devices/${encodeURIComponent(deviceId)}`,
    "PATCH",
    { assignedRootIds: [] },
    harness.adminMutationHeaders()
  ));
  expect(reassigned.status).toBe(200);
  const emptyHome = await harness.app(jsonRequest("/api/tv/home", "GET", undefined, deviceHeaders));
  expect(emptyHome.status).toBe(200);
  expect(await emptyHome.json()).toEqual({ ok: true, data: { roots: [] } });

  const revoked = await harness.app(jsonRequest(
    `/api/admin/devices/${encodeURIComponent(deviceId)}`,
    "DELETE",
    {},
    harness.adminMutationHeaders()
  ));
  expect(revoked.status).toBe(200);
  expect((await harness.app(jsonRequest("/api/tv/home", "GET", undefined, deviceHeaders))).status).toBe(401);
  const revokedRefresh = await harness.app(jsonRequest("/api/bootstrap", "GET", undefined, deviceHeaders));
  expect(revokedRefresh.status).toBe(200);
  expect(await revokedRefresh.json()).toEqual({ ok: true, data: { enrollment: { state: "unenrolled" } } });
  expect(revokedRefresh.headers.getSetCookie().join("\n")).toMatch(/device_session=;.*Max-Age=0/);

  for (const path of ["/api/tv/watch-history", "/api/tv/watch-history/item_video", "/api/admin/sync", "/api/admin/sources/source-1/sync"]) {
    const response = await harness.app(jsonRequest(path, "GET"));
    expect(response.status, path).toBe(404);
  }
});

test("approved enrollment returns revoked and clears its sealed request cookie if admin revokes before TV claim", async () => {
  const harness = await createControlApiHarness();
  const approval = await harness.app(jsonRequest(
    "/api/admin/requests/request-1/approve",
    "POST",
    { name: "Living Room", rootIds: ["root-1"] },
    harness.adminMutationHeaders()
  ));
  const approvalBody = await approval.json() as { data: { device: { id: string } } };
  const revoked = await harness.app(jsonRequest(
    `/api/admin/devices/${encodeURIComponent(approvalBody.data.device.id)}`,
    "DELETE",
    {},
    harness.adminMutationHeaders()
  ));
  expect(revoked.status).toBe(200);

  const refresh = await harness.app(jsonRequest("/api/bootstrap", "GET", undefined, {
    cookie: cookieHeader(["device_request", harness.requestCookie])
  }));
  expect(refresh.status).toBe(200);
  expect(await refresh.json()).toEqual({ ok: true, data: { enrollment: { state: "revoked" } } });
  expect(refresh.headers.getSetCookie().join("\n")).toMatch(/device_request=;.*Max-Age=0/);
});
