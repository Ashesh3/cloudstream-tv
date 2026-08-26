import { expect, test } from "@playwright/test";
import type { AssignedRoot, MediaNode } from "@cloudframe/shared";
import {
  MemoryRepository,
  createApiApp,
  createBrowseService,
  hashOpaqueToken,
  hashPassphrase
} from "@cloudframe/server";

test("shared API state promotes cookies, enforces reassignment, and revokes immediately", async ({ browser }) => {
  const now = new Date("2026-08-26T12:00:00.000Z");
  const origin = "http://127.0.0.1:4173";
  const repository = new MemoryRepository();
  const householdId = "household-e2e";
  await repository.putHousehold({
    id: householdId,
    createdAt: now,
    allowNewDeviceRequests: true,
    defaultMediaOrder: "captured-desc",
    defaultSlideshowSeconds: 8,
    adminPassphraseHash: await hashPassphrase("correct horse battery staple", "e2e-pepper"),
    adminPassphraseVersion: 1
  });
  const rootA = root("root-a", "source-a", "folder-a", householdId);
  const rootB = root("root-b", "source-b", "folder-b", householdId);
  await repository.putRoot(rootA);
  await repository.putRoot(rootB);
  await repository.putSource(source("source-a", householdId));
  await repository.putSource(source("source-b", householdId));
  for (const node of [folder("folder-a-node", "source-a", "folder-a", householdId), image("image-a", "source-a", "photo-a", "folder-a-node", householdId), folder("folder-b-node", "source-b", "folder-b", householdId)]) {
    await repository.putNode(node);
  }
  const browse = createBrowseService({ repository, cursorSecret: "e2e-cursor-secret-at-least-32-characters" });
  let id = 0;
  const app = createApiApp({
    repository,
    browse,
    mediaUrls: {
      media: async (device, household, nodeId) => {
        await browse.authorizeNode(device, household, nodeId);
        return { url: `https://provider.invalid/${nodeId}`, expiresAt: new Date(now.getTime() + 60000), revision: "1", responseHeaders: {} };
      },
      thumbnails: async () => ({ items: [], responseHeaders: {} }),
      adminThumbnails: async () => ({ items: [], responseHeaders: {} })
    },
    config: { householdId, adminInitialPassphrase: "correct horse battery staple", passphrasePepper: "e2e-pepper", csrfSecret: "e2e-csrf-secret-at-least-32-characters", allowedOrigin: origin, rateLimits: {} },
    now: () => new Date(now),
    createId: prefix => `${prefix}-${++id}`,
    issueToken: () => {
      const raw = Buffer.alloc(32, ++id).toString("base64url");
      return { raw, hash: hashOpaqueToken(raw) };
    }
  });

  const tv = await browser.newContext({ baseURL: origin });
  const admin = await browser.newContext({ baseURL: origin });
  const tvJar = new Map<string, string>();
  const adminJar = new Map<string, string>();
  const tvPage = await tv.newPage();
  const adminPage = await admin.newPage();
  await installApiRoute(tvPage, app, tvJar);
  await installApiRoute(adminPage, app, adminJar);
  const call = (target: import("@playwright/test").Page, path: string, init?: { method?: string; data?: unknown; headers?: Record<string, string> }) => target.evaluate(async ({ path, init }) => {
    const response = await fetch(path, { method: init?.method, headers: { ...(init?.data === undefined ? {} : { "content-type": "application/json" }), ...init?.headers }, body: init?.data === undefined ? undefined : JSON.stringify(init.data), credentials: "include" });
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.json() };
  }, { path, init });
  await tvPage.goto(origin);
  await adminPage.goto(origin);
  const tvRequest = await call(tvPage, "/api/device-requests", { method: "POST", data: { name: "Living Room" } });
  expect(tvRequest.status).toBe(201);
  expect(tvJar.has("device_request")).toBe(true);

  const login = await call(adminPage, "/api/admin/login", { method: "POST", data: { passphrase: "correct horse battery staple" } });
  const csrf = login.headers["x-csrf-token"]!;
  const adminSession = adminJar.get("admin_session");
  if (!adminSession) throw new Error(`Admin session cookie was not stored: ${JSON.stringify(login)}`);
  const request = (await repository.listDeviceRequests(householdId))[0]!;
  const approval = await call(adminPage, `/api/admin/requests/${request.id}/approve`, {
    method: "POST", headers: { origin, "x-csrf-token": csrf }, data: { name: "Living Room", rootIds: [rootA.id] }
  });
  expect(approval.status).toBe(200);

  const promotion = await call(tvPage, "/api/device-requests/status");
  expect(promotion.status).toBe(200);
  expect(tvJar.has("device_session")).toBe(true);
  expect(tvJar.has("device_request")).toBe(false);
  const home = await call(tvPage, "/api/tv/home");
  expect(home.body.data.roots).toHaveLength(1);
  const media = await call(tvPage, "/api/tv/media-url", { method: "POST", data: { nodeId: "image-a" } });
  expect(media.status).toBe(200);

  const device = (await repository.listDevices(householdId))[0]!;
  const reassigned = await call(adminPage, `/api/admin/devices/${device.id}`, {
    method: "PATCH", headers: { origin, "x-csrf-token": csrf }, data: { assignedRootIds: [rootB.id] }
  });
  expect(reassigned.status).toBe(200);
  expect((await call(tvPage, "/api/tv/media-url", { method: "POST", data: { nodeId: "image-a" } })).status).toBe(404);

  expect((await call(adminPage, `/api/admin/devices/${device.id}`, { method: "DELETE", headers: { origin, "x-csrf-token": csrf }, data: {} })).status).toBe(200);
  expect((await call(tvPage, "/api/tv/home")).status).toBe(401);
});

async function installApiRoute(page: import("@playwright/test").Page, app: (request: Request) => Promise<Response>, jar: Map<string, string>) {
  await page.route("**/api/**", async route => {
    const incoming = route.request();
    const headers = { ...incoming.headers() };
    if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
    const response = await app(new Request(incoming.url(), {
      method: incoming.method(), headers,
      body: ["GET", "HEAD"].includes(incoming.method()) ? undefined : incoming.postData() ?? undefined
    }));
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => { if (name !== "set-cookie") responseHeaders[name] = value; });
    const setCookies = response.headers.getSetCookie();
    for (const cookie of setCookies) {
      const [pair, ...attributes] = cookie.split(";");
      const separator = pair!.indexOf("=");
      const name = pair!.slice(0, separator);
      const value = decodeURIComponent(pair!.slice(separator + 1));
      if (attributes.some(attribute => /^\s*Max-Age=0$/i.test(attribute))) jar.delete(name);
      else jar.set(name, value);
    }
    if (setCookies.length) responseHeaders["set-cookie"] = setCookies.join("\n");
    await route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) });
  });
}

function root(id: string, sourceId: string, providerNodeId: string, householdId: string): AssignedRoot {
  return { id, householdId, sourceId, providerNodeId, displayName: id, ancestryProviderIds: [], enabled: true, createdAt: new Date("2026-08-26T12:00:00Z") };
}
function source(id: string, householdId: string): import("@cloudframe/shared").Source {
  return { id, householdId, provider: "google", providerAccountId: `${id}-account`, accountLabel: id, encryptedRefreshToken: { keyVersion: "1", iv: "iv", ciphertext: "cipher", authTag: "tag" }, encryptedAccessToken: null, accessTokenExpiresAt: null, status: "healthy", deltaCursor: null, crawlCheckpoint: null, activeWorkflowRunId: null, syncGeneration: null, nextSyncAt: null, leaseOwner: null, leaseExpiresAt: null, lastSyncStartedAt: null, lastSyncCompletedAt: null, lastSyncErrorCode: null, createdAt: new Date("2026-08-26T12:00:00Z") };
}
function folder(id: string, sourceId: string, providerNodeId: string, householdId: string): MediaNode { return node(id, sourceId, providerNodeId, null, "folder", householdId); }
function image(id: string, sourceId: string, providerNodeId: string, parentNodeId: string, householdId: string): MediaNode { return node(id, sourceId, providerNodeId, parentNodeId, "image", householdId); }
function node(id: string, sourceId: string, providerNodeId: string, parentNodeId: string | null, kind: "folder" | "image", householdId: string): MediaNode {
  return { id, householdId, sourceId, provider: "google", providerNodeId, parentNodeId, ancestorNodeIds: parentNodeId ? [parentNodeId] : [], name: id, normalizedName: id, kind, mimeType: kind === "image" ? "image/jpeg" : null, size: null, width: null, height: null, capturedAt: null, createdAtProvider: null, modifiedAtProvider: null, thumbnailRevision: null, hasPreview: kind === "image", folderCoverNodeIds: [], childFolderCount: 0, childMediaCount: kind === "folder" ? 1 : 0, available: true, indexedAt: new Date("2026-08-26T12:00:00Z") };
}
