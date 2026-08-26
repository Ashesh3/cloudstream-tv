import type {
  AssignedRoot,
  Device,
  MediaNode,
  Source
} from "@cloudframe/shared";
import {
  assignedRootDocumentId,
  createApiApp,
  createProviderFolderService,
  hashOpaqueToken,
  ProviderError,
  verifyPassphrase
} from "@cloudframe/server";
import type {
  ProviderAdapter,
  ProviderCredentials,
  ProviderNode,
  ProviderRegistry
} from "@cloudframe/providers";
import { describe, expect, it, vi } from "vitest";
import {
  cookieHeader,
  cookieValue,
  createTestApi,
  jsonRequest,
  setCookies
} from "./helpers/api";

const PASSPHRASE = "correct horse battery staple";
const NEW_PASSPHRASE = "a much longer replacement passphrase";

describe("admin management HTTP API", () => {
  it("browses live provider folders before any metadata is indexed", async () => {
    const harness = await createTestApi();
    const source = makeSource(harness.householdId, harness.now, {
      providerRootId: "root",
      status: "healthy"
    });
    await harness.repository.putSource(source);
    const listFolder = vi.fn().mockResolvedValue({
      items: [
        providerFolder("photos", "Photos", "root"),
        providerImage("cover", "Cover.jpg", "root")
      ],
      nextCursor: "page-2"
    });
    const providerFolders = makeProviderFolderService(harness, { listFolder });
    const admin = await login(harness.app);
    const app = createApiApp({
      repository: harness.repository,
      providerFolders,
      config: apiConfig(harness),
      now: () => harness.now
    });

    const response = await app(jsonRequest(
      `/api/admin/sources/${source.id}/provider-folders?limit=100`,
      "GET",
      undefined,
      admin.headers
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        current: { providerNodeId: "root", name: "My Drive" },
        breadcrumbs: [{ providerNodeId: "root", name: "My Drive" }],
        folders: [{ providerNodeId: "photos", name: "Photos", assignedRootId: null }],
        nextCursor: "page-2"
      }
    });
    expect(listFolder).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "root",
      cursor: null,
      pageSize: 100
    }));
    expect(await harness.repository.listNodesForSource(source.id)).toEqual([]);
  });

  it("pages a nested live folder with server-resolved breadcrumbs", async () => {
    const harness = await createTestApi();
    const source = makeSource(harness.householdId, harness.now, { providerRootId: "root" });
    await harness.repository.putSource(source);
    await harness.repository.putRoot({
      ...makeRoot(harness.householdId, source.id, harness.now),
      id: "assigned-photos",
      providerNodeId: "photos"
    });
    const listFolder = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const getNode = vi.fn(async ({ providerNodeId }: { providerNodeId: string }) => {
      if (providerNodeId === "photos") return providerFolder("photos", "Photos", "root");
      return providerFolder("root", "My Drive", null);
    });
    const providerFolders = makeProviderFolderService(harness, { getNode, listFolder });
    const admin = await login(harness.app);
    const app = createApiApp({
      repository: harness.repository,
      providerFolders,
      config: apiConfig(harness),
      now: () => harness.now
    });

    const response = await app(jsonRequest(
      `/api/admin/sources/${source.id}/provider-folders?providerFolderId=photos&cursor=opaque-page&limit=25`,
      "GET",
      undefined,
      admin.headers
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        current: { providerNodeId: "photos", assignedRootId: "assigned-photos" },
        breadcrumbs: [
          { providerNodeId: "root", name: "My Drive" },
          { providerNodeId: "photos", name: "Photos", assignedRootId: "assigned-photos" }
        ],
        folders: [],
        nextCursor: null
      }
    });
    expect(listFolder).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "photos",
      cursor: "opaque-page",
      pageSize: 25
    }));
  });

  it.each([
    ["PROVIDER_REAUTH_REQUIRED", 409, undefined],
    ["PROVIDER_THROTTLED", 429, 37],
    ["PROVIDER_THROTTLED", 429, 999_999]
  ] as const)("maps %s live browsing failures safely", async (code, status, retryAfterSeconds) => {
    const harness = await createTestApi();
    const source = makeSource(harness.householdId, harness.now, { providerRootId: "root" });
    await harness.repository.putSource(source);
    const providerFolders = makeProviderFolderService(harness, {
      listFolder: vi.fn(async () => {
        throw new ProviderError(code, "secret provider payload", {
          retryable: code === "PROVIDER_THROTTLED",
          retryAfterSeconds
        });
      })
    });
    const admin = await login(harness.app);
    const app = createApiApp({
      repository: harness.repository,
      providerFolders,
      config: apiConfig(harness),
      now: () => harness.now
    });

    const response = await app(jsonRequest(
      `/api/admin/sources/${source.id}/provider-folders`,
      "GET",
      undefined,
      admin.headers
    ));

    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe(
      retryAfterSeconds ? String(Math.min(retryAfterSeconds, 86_400)) : null
    );
    const body = await response.text();
    expect(body).toContain(code);
    expect(body).not.toContain("secret provider payload");
  });

  it("rejects a folder that cannot be proven to descend from the connected provider root", async () => {
    const harness = await createTestApi();
    const source = makeSource(harness.householdId, harness.now, { providerRootId: "root" });
    await harness.repository.putSource(source);
    const providerFolders = makeProviderFolderService(harness, {
      getNode: vi.fn(async ({ providerNodeId }: { providerNodeId: string }) =>
        providerNodeId === "outside"
          ? providerFolder("outside", "Outside", "foreign-root")
          : providerFolder("foreign-root", "Foreign", null)
      )
    });

    await expect(providerFolders.resolveAncestry({
      householdId: harness.householdId,
      sourceId: source.id,
      providerNodeId: "outside"
    })).rejects.toMatchObject({ code: "PROVIDER_FOLDER_OUTSIDE_SOURCE" });
  });

  it("bounds ancestry walking and rejects invalid provider folder pages", async () => {
    const harness = await createTestApi();
    const source = makeSource(harness.householdId, harness.now, { providerRootId: "root" });
    await harness.repository.putSource(source);
    const getNode = vi.fn(async ({ providerNodeId }: { providerNodeId: string }) => {
      const depth = Number(providerNodeId.replace("folder-", ""));
      return providerFolder(
        providerNodeId,
        providerNodeId,
        depth >= 255 ? "root" : `folder-${depth + 1}`
      );
    });
    const providerFolders = makeProviderFolderService(harness, { getNode });
    await expect(providerFolders.resolveAncestry({
      householdId: harness.householdId,
      sourceId: source.id,
      providerNodeId: "folder-0"
    })).rejects.toMatchObject({ code: "PROVIDER_FOLDER_OUTSIDE_SOURCE" });
    expect(getNode).toHaveBeenCalledTimes(256);

    const admin = await login(harness.app);
    const app = createApiApp({
      repository: harness.repository,
      providerFolders,
      config: apiConfig(harness),
      now: () => harness.now
    });
    const response = await app(jsonRequest(
      `/api/admin/sources/${source.id}/provider-folders?limit=101`,
      "GET",
      undefined,
      admin.headers
    ));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_PAGE_SIZE" });
  });

  it("rejects provider ancestry cycles and non-folder browse targets", async () => {
    const harness = await createTestApi();
    const source = makeSource(harness.householdId, harness.now, { providerRootId: "root" });
    await harness.repository.putSource(source);
    const cycle = makeProviderFolderService(harness, {
      getNode: vi.fn(async ({ providerNodeId }: { providerNodeId: string }) =>
        providerNodeId === "a"
          ? providerFolder("a", "A", "b")
          : providerFolder("b", "B", "a")
      )
    });
    await expect(cycle.resolveAncestry({
      householdId: harness.householdId,
      sourceId: source.id,
      providerNodeId: "a"
    })).rejects.toMatchObject({ code: "PROVIDER_ANCESTRY_CYCLE" });

    const file = makeProviderFolderService(harness, {
      getNode: vi.fn(async () => providerImage("image", "Image.jpg", "root"))
    });
    await expect(file.resolveAncestry({
      householdId: harness.householdId,
      sourceId: source.id,
      providerNodeId: "image"
    })).rejects.toMatchObject({ code: "PROVIDER_FOLDER_REQUIRED" });
  });

  it("returns one safe overview with a refreshed CSRF token", async () => {
    const harness = await createTestApi();
    const source = makeSource(harness.householdId, harness.now);
    const root = makeRoot(harness.householdId, source.id, harness.now);
    await harness.repository.putSource(source);
    await harness.repository.putRoot(root);
    const admin = await login(harness.app);

    const response = await harness.app(
      jsonRequest("/api/admin/overview", "GET", undefined, admin.headers)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-csrf-token")).toMatch(/^[a-f0-9]{64}$/);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      data: {
        household: { id: harness.householdId },
        pendingRequests: [],
        devices: [],
        sources: [{ id: source.id, accountLabel: "Family drive" }],
        roots: [{ id: root.id, displayName: "Family drive" }]
      }
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("encryptedRefreshToken");
    expect(serialized).not.toContain("adminPassphraseHash");
  });

  it("reads and validates household settings, with mutation protection", async () => {
    const harness = await createTestApi();
    const admin = await login(harness.app);

    const read = await harness.app(
      jsonRequest("/api/admin/settings", "GET", undefined, admin.headers)
    );
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      data: {
        allowNewDeviceRequests: true,
        defaultMediaOrder: "captured-desc",
        defaultSlideshowSeconds: 8,
        indexHealth: {
          totalNodeCount: 0,
          availableNodeCount: 0,
          indexingSourceCount: 0,
          estimatedFirestoreDocumentCount: 1
        }
      }
    });

    const forbidden = await harness.app(
      jsonRequest("/api/admin/settings", "PATCH", {
        allowNewDeviceRequests: false
      }, admin.headers)
    );
    expect(forbidden.status).toBe(403);

    const invalid = await harness.app(
      jsonRequest(
        "/api/admin/settings",
        "PATCH",
        { defaultMediaOrder: "random", defaultSlideshowSeconds: 0 },
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      code: "INVALID_SETTINGS"
    });

    const updated = await harness.app(
      jsonRequest(
        "/api/admin/settings",
        "PATCH",
        {
          allowNewDeviceRequests: false,
          defaultMediaOrder: "name-asc",
          defaultSlideshowSeconds: 15
        },
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(updated.status).toBe(200);
    expect(await harness.repository.getHousehold(harness.householdId)).toMatchObject({
      allowNewDeviceRequests: false,
      defaultMediaOrder: "name-asc",
      defaultSlideshowSeconds: 15
    });
  });

  it("rotates a 16-1024 character passphrase atomically and signs every admin out", async () => {
    const harness = await createTestApi();
    const admin = await login(harness.app);
    const second = await login(harness.app);

    const wrong = await harness.app(
      jsonRequest(
        "/api/admin/settings/passphrase",
        "POST",
        { currentPassphrase: "wrong passphrase value", newPassphrase: NEW_PASSPHRASE },
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const invalidCurrent = await harness.app(
      jsonRequest(
        "/api/admin/settings/passphrase",
        "POST",
        { currentPassphrase: "short", newPassphrase: NEW_PASSPHRASE },
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(invalidCurrent.status).toBe(400);

    const short = await harness.app(
      jsonRequest(
        "/api/admin/settings/passphrase",
        "POST",
        { currentPassphrase: PASSPHRASE, newPassphrase: "too short" },
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(short.status).toBe(400);

    const rotated = await harness.app(
      jsonRequest(
        "/api/admin/settings/passphrase",
        "POST",
        { currentPassphrase: PASSPHRASE, newPassphrase: NEW_PASSPHRASE },
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(rotated.status).toBe(200);
    expect(setCookies(rotated).some(value => /admin_session=;.*Max-Age=0/.test(value))).toBe(true);
    const household = await harness.repository.getHousehold(harness.householdId);
    expect(household?.adminPassphraseVersion).toBe(2);
    await expect(
      verifyPassphrase(household!.adminPassphraseHash, NEW_PASSPHRASE, harness.pepper)
    ).resolves.toBe(true);

    const stale = await harness.app(
      jsonRequest("/api/admin/overview", "GET", undefined, second.headers)
    );
    expect(stale.status).toBe(401);
  });

  it("starts OAuth with a fixed callback and completes by safe 303 redirect", async () => {
    const harness = await createTestApi();
    const admin = await login(harness.app);
    const beginAuthorization = vi.fn(async (input: unknown) => {
      expect(input).toMatchObject({
        householdId: harness.householdId,
        provider: "google",
        redirectUri: `${harness.origin}/api/admin/oauth/google/callback`
      });
      return { authorizationUrl: "https://accounts.example/authorize?state=opaque-state" };
    });
    const completeAuthorization = vi.fn(async (input: unknown) => {
      expect(input).toMatchObject({
        householdId: harness.householdId,
        provider: "google",
        redirectUri: `${harness.origin}/api/admin/oauth/google/callback`,
        state: "opaque-state",
        code: "provider-code"
      });
      return { sourceId: "source-connected", status: "connected" as const };
    });
    const app = createApiApp({
      repository: harness.repository,
      config: {
        householdId: harness.householdId,
        passphrasePepper: harness.pepper,
        csrfSecret: harness.csrfSecret,
        allowedOrigin: harness.origin
      },
      now: () => harness.now,
      oauth: { beginAuthorization, completeAuthorization }
    });

    const start = await app(
      jsonRequest(
        "/api/admin/sources/google/authorize",
        "POST",
        {},
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(start.status).toBe(200);
    await expect(start.json()).resolves.toMatchObject({
      data: { authorizationUrl: "https://accounts.example/authorize?state=opaque-state" }
    });

    const callback = await app(new Request(
      `${harness.origin}/api/admin/oauth/google/callback?state=opaque-state&code=provider-code`,
      { headers: admin.headers, redirect: "manual" }
    ));
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/admin?section=sources&oauth=connected");
    expect(callback.headers.get("location")).not.toContain("provider-code");
    expect(callback.headers.get("location")).not.toContain("opaque-state");
  });

  it("preserves a rolling admin cookie on the OAuth 303 callback", async () => {
    const harness = await createTestApi();
    const admin = await login(harness.app);
    const session = await harness.repository.getAdminSessionByHash(hashOpaqueToken(admin.raw));
    await harness.repository.putAdminSession({
      ...session!,
      expiresAt: new Date(harness.now.getTime() + 29 * 24 * 60 * 60 * 1000)
    });
    const app = createApiApp({
      repository: harness.repository,
      config: {
        householdId: harness.householdId,
        passphrasePepper: harness.pepper,
        csrfSecret: harness.csrfSecret,
        allowedOrigin: harness.origin
      },
      now: () => harness.now,
      oauth: {
        beginAuthorization: vi.fn(),
        completeAuthorization: vi.fn(async () => ({ sourceId: "source-1", status: "connected" as const }))
      }
    });

    const response = await app(new Request(
      `${harness.origin}/api/admin/oauth/google/callback?state=opaque&code=provider-code`,
      { headers: admin.headers }
    ));

    expect(response.status).toBe(303);
    expect(cookieValue(response, "admin_session")).toBe(admin.raw);
  });

  it("lists safe sources and previews then atomically removes a confirmed source", async () => {
    const harness = await createTestApi();
    const source = makeSource(harness.householdId, harness.now);
    const root = makeRoot(harness.householdId, source.id, harness.now);
    const device = makeDevice(harness.householdId, harness.now, root.id);
    await harness.repository.putSource(source);
    await harness.repository.putRoot(root);
    await harness.repository.putDevice(device);
    const admin = await login(harness.app);

    const list = await harness.app(
      jsonRequest("/api/admin/sources", "GET", undefined, admin.headers)
    );
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).toContain("Family drive");
    expect(listText).not.toContain("encryptedRefreshToken");

    const impact = await harness.app(
      jsonRequest(`/api/admin/sources/${source.id}/impact`, "GET", undefined, admin.headers)
    );
    await expect(impact.json()).resolves.toMatchObject({
      data: {
        roots: [{ id: root.id }],
        devices: [{ id: device.id }]
      }
    });

    const unconfirmed = await harness.app(
      jsonRequest(
        `/api/admin/sources/${source.id}`,
        "DELETE",
        { confirm: false },
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(unconfirmed.status).toBe(400);

    const removed = await harness.app(
      jsonRequest(
        `/api/admin/sources/${source.id}`,
        "DELETE",
        { confirm: true },
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(removed.status).toBe(200);
    expect(await harness.repository.getSource(source.id)).toBeNull();
    expect(await harness.repository.getRoot(root.id)).toMatchObject({ enabled: false });
    expect(await harness.repository.getDevice(device.id)).toMatchObject({ assignedRootIds: [] });
  });

  it("browses indexed folders, creates and disables roots, and vends admin thumbnails", async () => {
    const harness = await createTestApi();
    const source = makeSource(harness.householdId, harness.now);
    const providerRoot = makeFolderNode(harness.householdId, source.id, "node-root", "provider-root", null);
    const folder = makeFolderNode(harness.householdId, source.id, "node-folder", "provider-folder", providerRoot.id);
    const cover = makeCoverNode(harness.householdId, source.id, "node-cover", folder.id);
    folder.folderCoverNodeIds = [cover.id];
    await harness.repository.putSource(source);
    await harness.repository.putNode(providerRoot);
    await harness.repository.putNode(folder);
    await harness.repository.putNode(cover);
    const admin = await login(harness.app);
    const adminThumbnails = vi.fn(async () => ({
      items: [{ nodeId: cover.id, status: "ready", url: "https://provider.example/thumb", expiresAt: new Date(harness.now.getTime() + 60_000) }],
      responseHeaders: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" }
    }));
    const app = createApiApp({
      repository: harness.repository,
      config: {
        householdId: harness.householdId,
        passphrasePepper: harness.pepper,
        csrfSecret: harness.csrfSecret,
        allowedOrigin: harness.origin
      },
      now: () => harness.now,
      createId: prefix => `${prefix}-created`,
      mediaUrls: {
        adminThumbnails,
        media: vi.fn(),
        thumbnails: vi.fn()
      }
    });

    const tree = await app(
      jsonRequest(`/api/admin/sources/${source.id}/tree?parentNodeId=${providerRoot.id}`, "GET", undefined, admin.headers)
    );
    expect(tree.status).toBe(200);
    await expect(tree.json()).resolves.toMatchObject({
      data: { folders: [{ id: folder.id, name: "Photos", folderCoverNodeIds: [cover.id], assignedRootId: null }] }
    });

    const created = await app(
      jsonRequest(
        `/api/admin/sources/${source.id}/roots`,
        "POST",
        { providerNodeId: folder.id, displayName: "Family photos" },
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(created.status).toBe(201);
    const rootId = (await created.json()).data.root.id as string;
    expect(await harness.repository.getRoot(rootId)).toMatchObject({
      providerNodeId: "provider-folder",
      enabled: true
    });
    const assignedTree = await app(
      jsonRequest(`/api/admin/sources/${source.id}/tree?parentNodeId=${providerRoot.id}`, "GET", undefined, admin.headers)
    );
    await expect(assignedTree.json()).resolves.toMatchObject({
      data: { folders: [{ id: folder.id, assignedRootId: rootId }] }
    });
    await harness.repository.putDevice(makeDevice(harness.householdId, harness.now, rootId));

    const impact = await app(
      jsonRequest(`/api/admin/roots/${rootId}/impact`, "GET", undefined, admin.headers)
    );
    expect(impact.status).toBe(200);
    await expect(impact.json()).resolves.toMatchObject({
      data: { roots: [{ id: rootId }], devices: [{ id: "device-1" }] }
    });

    const thumbnails = await app(
      jsonRequest(
        "/api/admin/thumbnail-urls",
        "POST",
        { nodeIds: [cover.id], maxDimension: 512 },
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(thumbnails.status).toBe(200);
    expect(thumbnails.headers.get("cache-control")).toBe("private, no-store");
    expect(thumbnails.headers.get("referrer-policy")).toBe("no-referrer");
    expect(adminThumbnails).toHaveBeenCalledWith(
      harness.householdId,
      [cover.id],
      512
    );

    const removed = await app(
      jsonRequest(
        `/api/admin/roots/${rootId}`,
        "DELETE",
        { confirm: true },
        mutationHeaders(harness.origin, admin)
      )
    );
    expect(removed.status).toBe(200);
    expect(await harness.repository.getRoot(rootId)).toMatchObject({ enabled: false });
    expect(await harness.repository.getDevice("device-1")).toMatchObject({ assignedRootIds: [] });
  });

  it("re-enables one unique root under concurrent creates and records current provider ancestry", async () => {
    const harness = await createTestApi();
    const source = makeSource(harness.householdId, harness.now);
    const providerRoot = makeFolderNode(harness.householdId, source.id, "node-root", "provider-root", null);
    const folder = makeFolderNode(harness.householdId, source.id, "node-folder", "provider-folder", providerRoot.id);
    await harness.repository.putSource(source);
    await harness.repository.putNode(providerRoot);
    await harness.repository.putNode(folder);
    const admin = await login(harness.app);
    let id = 0;
    const app = createApiApp({
      repository: harness.repository,
      config: {
        householdId: harness.householdId,
        passphrasePepper: harness.pepper,
        csrfSecret: harness.csrfSecret,
        allowedOrigin: harness.origin
      },
      now: () => harness.now,
      createId: prefix => `${prefix}-${++id}`
    });
    const request = () => app(jsonRequest(
      `/api/admin/sources/${source.id}/roots`,
      "POST",
      { providerNodeId: folder.id, displayName: "Photos" },
      mutationHeaders(harness.origin, admin)
    ));

    const [first, second] = await Promise.all([request(), request()]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const roots = await harness.repository.listRootsForSource(source.id);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      id: assignedRootDocumentId(harness.householdId, source.id, "provider-folder"),
      providerNodeId: "provider-folder",
      ancestryProviderIds: ["provider-root"],
      enabled: true
    });
  });

  it("maps only bounded OAuth failures while unexpected callback defects remain safe 500s", async () => {
    const harness = await createTestApi();
    const admin = await login(harness.app);
    const app = createApiApp({
      repository: harness.repository,
      config: {
        householdId: harness.householdId,
        passphrasePepper: harness.pepper,
        csrfSecret: harness.csrfSecret,
        allowedOrigin: harness.origin
      },
      now: () => harness.now,
      oauth: {
        beginAuthorization: vi.fn(),
        completeAuthorization: vi.fn(async () => {
          throw new Error("private backend detail");
        })
      }
    });

    const response = await app(new Request(
      `${harness.origin}/api/admin/oauth/google/callback?state=opaque&code=provider-code`,
      { headers: admin.headers }
    ));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred."
    });
  });

  it("keeps source removal atomic when the repository fails", async () => {
    const harness = await createTestApi();
    const source = makeSource(harness.householdId, harness.now);
    const root = makeRoot(harness.householdId, source.id, harness.now);
    const device = makeDevice(harness.householdId, harness.now, root.id);
    await harness.repository.putSource(source);
    await harness.repository.putRoot(root);
    await harness.repository.putDevice(device);
    const admin = await login(harness.app);
    harness.repository.removeSource = async () => {
      throw new Error("simulated transaction failure");
    };

    const response = await harness.app(jsonRequest(
      `/api/admin/sources/${source.id}`,
      "DELETE",
      { confirm: true },
      mutationHeaders(harness.origin, admin)
    ));

    expect(response.status).toBe(500);
    expect(await harness.repository.getSource(source.id)).toEqual(source);
    expect(await harness.repository.getRoot(root.id)).toEqual(root);
    expect(await harness.repository.getDevice(device.id)).toEqual(device);
  });
});

async function login(app: (request: Request) => Promise<Response>) {
  const response = await app(jsonRequest("/api/admin/login", "POST", { passphrase: PASSPHRASE }));
  const raw = cookieValue(response, "admin_session")!;
  return {
    raw,
    csrf: response.headers.get("x-csrf-token")!,
    headers: { cookie: cookieHeader(["admin_session", raw]) }
  };
}

function mutationHeaders(origin: string, admin: Awaited<ReturnType<typeof login>>) {
  return { ...admin.headers, origin, "x-csrf-token": admin.csrf };
}

function makeSource(householdId: string, now: Date, overrides: Partial<Source> = {}): Source {
  return {
    id: "source-1",
    householdId,
    provider: "google",
    providerAccountId: "account-1",
    providerRootId: null,
    accountLabel: "Family drive",
    encryptedRefreshToken: { keyVersion: "v1", iv: "iv", ciphertext: "refresh-secret", authTag: "tag" },
    encryptedAccessToken: null,
    accessTokenExpiresAt: null,
    status: "healthy",
    deltaCursor: null,
    crawlCheckpoint: null,
    activeWorkflowRunId: null,
    syncGeneration: null,
    nextSyncAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastSyncErrorCode: null,
    createdAt: now,
    ...overrides
  };
}

function apiConfig(harness: Awaited<ReturnType<typeof createTestApi>>) {
  return {
    householdId: harness.householdId,
    passphrasePepper: harness.pepper,
    csrfSecret: harness.csrfSecret,
    allowedOrigin: harness.origin
  };
}

function makeProviderFolderService(
  harness: Awaited<ReturnType<typeof createTestApi>>,
  overrides: Partial<Pick<ProviderAdapter, "getRoot" | "getNode" | "listFolder">> = {}
) {
  const credentials: ProviderCredentials = {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: new Date(harness.now.getTime() + 60_000)
  };
  const adapter = {
    getRoot: vi.fn(async () => providerFolder("root", "My Drive", null)),
    getNode: vi.fn(async ({ providerNodeId }: { providerNodeId: string }) =>
      providerNodeId === "root"
        ? providerFolder("root", "My Drive", null)
        : providerFolder(providerNodeId, providerNodeId, "root")
    ),
    listFolder: vi.fn(async () => ({ items: [], nextCursor: null })),
    ...overrides
  } as unknown as ProviderAdapter;
  const providers: ProviderRegistry = { get: () => adapter };
  return createProviderFolderService({
    repository: harness.repository,
    providers,
    sourceService: {
      getUsableCredentials: vi.fn(async () => credentials)
    } as never
  });
}

function providerFolder(providerNodeId: string, name: string, parentProviderId: string | null): ProviderNode {
  return providerNode({ providerNodeId, name, parentProviderId, kind: "folder" });
}

function providerImage(providerNodeId: string, name: string, parentProviderId: string | null): ProviderNode {
  return providerNode({ providerNodeId, name, parentProviderId, kind: "image" });
}

function providerNode(input: Pick<ProviderNode, "providerNodeId" | "name" | "parentProviderId" | "kind">): ProviderNode {
  return {
    ...input,
    mimeType: input.kind === "folder" ? null : "image/jpeg",
    size: null,
    width: null,
    height: null,
    capturedAt: null,
    createdAt: null,
    modifiedAt: null,
    thumbnailRevision: null,
    hasPreview: false
  };
}

function makeRoot(householdId: string, sourceId: string, now: Date): AssignedRoot {
  return {
    id: "root-1",
    householdId,
    sourceId,
    providerNodeId: "provider-root",
    displayName: "Family drive",
    ancestryProviderIds: [],
    enabled: true,
    createdAt: now
  };
}

function makeDevice(householdId: string, now: Date, rootId: string): Device {
  return {
    id: "device-1",
    householdId,
    name: "Living room",
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

function makeFolderNode(
  householdId: string,
  sourceId: string,
  id: string,
  providerNodeId: string,
  parentNodeId: string | null
): MediaNode {
  return {
    id,
    householdId,
    sourceId,
    provider: "google",
    providerNodeId,
    parentNodeId,
    ancestorNodeIds: parentNodeId ? [parentNodeId] : [],
    name: id === "node-folder" ? "Photos" : "Family drive",
    normalizedName: id === "node-folder" ? "photos" : "family drive",
    kind: "folder",
    mimeType: null,
    size: null,
    width: null,
    height: null,
    capturedAt: null,
    createdAtProvider: null,
    modifiedAtProvider: null,
    thumbnailRevision: null,
    hasPreview: false,
    folderCoverNodeIds: [],
    childFolderCount: 0,
    childMediaCount: 0,
    available: true,
    indexedAt: new Date("2026-08-26T12:00:00.000Z")
  };
}

function makeCoverNode(householdId: string, sourceId: string, id: string, parentNodeId: string): MediaNode {
  return {
    ...makeFolderNode(householdId, sourceId, id, "provider-cover", parentNodeId),
    kind: "image",
    name: "Cover.jpg",
    normalizedName: "cover.jpg",
    mimeType: "image/jpeg",
    hasPreview: true,
    thumbnailRevision: "rev-1"
  };
}
