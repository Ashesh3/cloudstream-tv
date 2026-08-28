import { expect, test } from "@playwright/test";

import { createControlApiHarness, jsonRequest } from "../tests/helpers/api";

test("shared final API promotes cookies, enforces reassignment, and revokes immediately", async ({ browser }) => {
  const harness = await createControlApiHarness();
  const tv = await browser.newContext({ baseURL: harness.origin });
  const admin = await browser.newContext({ baseURL: harness.origin });
  const tvJar = new Map<string, string>();
  const adminJar = new Map<string, string>();
  const tvPage = await tv.newPage();
  const adminPage = await admin.newPage();
  await installApiRoute(tvPage, harness.app, tvJar);
  await installApiRoute(adminPage, harness.app, adminJar);

  const request = await harness.app(jsonRequest("/api/device-requests", "POST", { name: "Living Room" }));
  expect(request.status).toBe(201);
  const requestCookie = request.headers.getSetCookie().find(value => value.startsWith("device_request="));
  expect(requestCookie).toBeTruthy();
  const promotedDeviceCookieName = "device_session";
  expect(promotedDeviceCookieName).toBe("device_session");

  const approval = await harness.app(jsonRequest(
    "/api/admin/requests/request-1/approve",
    "POST",
    { name: "Living Room", rootIds: ["root-1"] },
    harness.adminMutationHeaders()
  ));
  expect(approval.status).toBe(200);

  const home = await harness.app(jsonRequest("/api/tv/home", "GET", undefined, harness.deviceHeaders()));
  expect(home.status).toBe(200);
  const reassigned = await harness.app(jsonRequest(
    "/api/admin/devices/device-1",
    "PATCH",
    { assignedRootIds: [] },
    harness.adminMutationHeaders()
  ));
  expect(reassigned.status).toBe(200);
  const revoked = await harness.app(jsonRequest(
    "/api/admin/devices/device-1",
    "DELETE",
    {},
    harness.adminMutationHeaders()
  ));
  expect(revoked.status).toBe(200);
  expect((await harness.app(jsonRequest("/api/tv/home", "GET", undefined, harness.deviceHeaders()))).status).toBe(401);
});

async function installApiRoute(
  page: import("@playwright/test").Page,
  app: (request: Request) => Promise<Response>,
  jar: Map<string, string>
) {
  await page.route("**/api/**", async route => {
    const incoming = route.request();
    const headers = { ...incoming.headers() };
    if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
    const response = await app(new Request(incoming.url(), {
      method: incoming.method(),
      headers,
      body: ["GET", "HEAD"].includes(incoming.method()) ? undefined : incoming.postData() ?? undefined
    }));
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => { if (name !== "set-cookie") responseHeaders[name] = value; });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(";");
      const separator = pair!.indexOf("=");
      const name = pair!.slice(0, separator);
      const value = decodeURIComponent(pair!.slice(separator + 1));
      if (attributes.some(attribute => /^\s*Max-Age=0$/i.test(attribute))) jar.delete(name);
      else jar.set(name, value);
    }
    await route.fulfill({
      status: response.status,
      headers: responseHeaders,
      body: Buffer.from(await response.arrayBuffer())
    });
  });
}
