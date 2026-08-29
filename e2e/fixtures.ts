import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

export const media = {
  thumbnail: "https://provider-assets.example/sunset-preview.svg",
  folderThumbnail: "https://provider-assets.example/folder-preview.svg",
  image: "https://provider-assets.example/sunset-original.svg",
  video: "https://provider-assets.example/lake.mp4"
};

export async function installTvFixture(
  page: Page,
  state: "unenrolled" | "ready" = "ready",
  options: { longFolder?: boolean } = {},
) {
  const imageBody = "<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'><rect width='1200' height='800' fill='#15304f'/><circle cx='350' cy='310' r='130' fill='#ffd36e'/><path d='M0 720 430 350 730 610 940 430 1200 690V800H0Z' fill='#69b1d4'/></svg>";
  await page.route(media.thumbnail, route => route.fulfill({
    contentType: "image/svg+xml",
    body: imageBody
  }));
  await page.route(media.folderThumbnail, route => route.fulfill({
    contentType: "image/svg+xml",
    body: imageBody
  }));
  await page.route(media.image, route => route.fulfill({
    contentType: "image/svg+xml",
    body: imageBody
  }));
  await page.route(media.video, async route => route.fulfill({
    contentType: "video/mp4",
    path: fileURLToPath(new URL("./fixtures/video.mp4", import.meta.url))
  }));
  await page.addInitScript(({ state, media, longFolder }) => {
    const now = new Date().toISOString();
    let status = state;
    const folder = {
      id: "item_folder", handle: "sealed-folder",
      name: "Family Trips", normalizedName: "family trips", kind: "folder", mimeType: null,
      size: null, width: null, height: null, capturedAt: null, createdAtProvider: now,
      modifiedAtProvider: now, thumbnailRevision: null, contentRevision: null, hasPreview: false
    };
    const childFolder = {
      ...folder,
      id: "item_child_folder",
      handle: "sealed-child-folder",
      name: "Albums",
      normalizedName: "albums",
      hasPreview: true
    };
    const image = { ...folder, id: "item_image", handle: "sealed-image", name: "Sunset.jpg", normalizedName: "sunset.jpg", kind: "image", mimeType: "image/jpeg", width: 1200, height: 800, hasPreview: true };
    const video = { ...folder, id: "item_video", handle: "sealed-video", name: "Lake.mp4", normalizedName: "lake.mp4", kind: "video", mimeType: "video/mp4", width: 1280, height: 720, hasPreview: true };
    const extras = Array.from({ length: longFolder ? 30 : 0 }, (_, index) => ({
      ...image,
      id: `item_extra_${index}`,
      handle: `sealed-extra-${index}`,
      name: `Extra ${String(index).padStart(2, "0")}.jpg`,
      normalizedName: `extra ${String(index).padStart(2, "0")}.jpg`
    }));
    const children = [childFolder, image, video, ...extras];
    const itemByHandle = new Map(children.map(item => [item.handle, item]));
    const household = { id: "household-test", allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 8 };
    const device = { id: "device-1", name: "Living Room", enabled: true, assignedRootIds: ["root-1"], mediaOrder: null, slideshowSeconds: null, createdAt: now, approvedAt: now, lastSeenAt: now, revokedAt: null };
    const enrollment = () => status === "ready"
      ? { state: "ready", household, device }
      : status === "pending"
        ? { state: "pending", request: { id: "request-1", requestedName: "Living Room", status: "pending", createdAt: now, expiresAt: new Date(Date.now()+3600000).toISOString(), resolvedAt: null, approvedDeviceId: null } }
        : { state: "unenrolled" };
    const calls = { folder: [] as Array<{ handle: string; cursor: string | null }>, thumbnails: [] as string[][], media: [] as string[] };
    window.__CLOUDFRAME_TEST_TV_CALLS__ = calls;
    const reject = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
    window.__CLOUDFRAME_TEST_TV_API__ = {
      bootstrap: async () => ({ enrollment: enrollment() }),
      createDeviceRequest: async name => { status = "pending"; document.cookie = "cf_device_request=e2e; path=/"; return { request: { id: "request-1", requestedName: name, status: "pending", createdAt: now, expiresAt: new Date(Date.now() + 3600000).toISOString(), resolvedAt: null, approvedDeviceId: null } }; },
      requestStatus: async () => ({ enrollment: enrollment() }),
      home: async () => ({ roots: [{ id: "item_folder", handle: "sealed-folder", displayName: "Family Trips", provider: "google", accountLabel: "Family Drive" }] }),
      folder: async (handle, cursor) => {
        calls.folder.push({ handle, cursor: cursor ?? null });
        if (handle !== "sealed-folder" || (cursor !== undefined && cursor !== null)) return reject("NAVIGATION_EXPIRED");
        return { parent: folder, breadcrumbs: [folder], children, nextCursor: null };
      },
      thumbnailUrls: async handles => {
        calls.thumbnails.push([...handles]);
        const unique = new Set(handles);
        if (handles.length < 1 || unique.size !== handles.length || handles.some(handle => !itemByHandle.has(handle))) return reject("ITEM_NOT_FOUND");
        return { items: handles.map(handle => {
          const item = itemByHandle.get(handle)!;
          return { itemId: item.id, status: "ready", url: item.kind === "folder" ? media.folderThumbnail : media.thumbnail, expiresAt: new Date(Date.now()+3600000).toISOString(), revision: "1" };
        }) };
      },
      mediaUrl: async handle => {
        calls.media.push(handle);
        const item = itemByHandle.get(handle);
        if (!item || item.kind === "folder") return reject("ITEM_NOT_FOUND");
        return { itemId: item.id, kind: item.kind, transport: "direct", url: item.kind === "video" ? media.video : media.image, expiresAt: new Date(Date.now()+3600000).toISOString(), revision: "1" };
      }
    };
  }, { state, media, longFolder: options.longFolder === true });
}

export type AdminFixtureScenario = "enrollment" | "source-workbench";

export async function installAdminFixture(page: Page, scenario: AdminFixtureScenario = "enrollment") {
  await page.addInitScript(({ scenario }) => {
    const now = new Date().toISOString();
    const sourceId = "source-1";
    const providerRoot = { providerNodeId: "drive-root", parentProviderId: null, name: "My Drive", assignedRootId: null };
    const photos = { providerNodeId: "photos", parentProviderId: providerRoot.providerNodeId, name: "Photos", assignedRootId: null };
    const movies = { providerNodeId: "movies", parentProviderId: providerRoot.providerNodeId, name: "Movies", assignedRootId: null };
    const trips = { providerNodeId: "trips", parentProviderId: photos.providerNodeId, name: "Trips", assignedRootId: null };
    let roots = scenario === "source-workbench" ? [] : [{ id: "root-1", sourceId, displayName: "Family Trips", enabled: true, createdAt: now }];
    let devices = scenario === "source-workbench"
      ? [{ id: "device-1", name: "Living Room", enabled: true, assignedRootIds: [], mediaOrder: null, slideshowSeconds: null, createdAt: now, approvedAt: now, revokedAt: null }]
      : [];
    let requests = scenario === "source-workbench" ? [] : [{ id: "request-1", requestedName: "Living Room", status: "pending", createdAt: now, expiresAt: new Date(Date.now()+3600000).toISOString(), resolvedAt: null, approvedDeviceId: null }];
    const household = { allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 8 };
    const source = { id: sourceId, provider: "google", accountLabel: "family@example.test", status: "healthy", createdAt: now };
    const rootByProviderNode = new Map<string, string>();
    let revision = 1;
    const snapshot = () => ({ revision, household, pendingRequests: requests, devices, sources: [source], roots, recoveryCopy: { status: "current", revision } });
    window.__CLOUDFRAME_TEST_ADMIN_API__ = {
      login: async () => ({ authenticated: true }), logout: async () => ({ authenticated: false }), snapshot: async () => snapshot(),
      updateSettings: async body => { Object.assign(household, body); revision += 1; return { revision }; }, rotatePassphrase: async () => ({ authenticated: false, revision: ++revision }),
      authorizeSource: async provider => ({ authorizationUrl: provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth?client_id=test" : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=test" }), sourceImpact: async () => ({ roots, devices }), removeSource: async () => ({ removed: true, roots, devices }),
      providerFolders: async (_id, input) => {
        const assigned = folder => ({ ...folder, assignedRootId: rootByProviderNode.get(folder.providerNodeId) ?? null });
        if (input.providerFolderId === photos.providerNodeId) return { source, current: assigned(photos), breadcrumbs: [assigned(providerRoot), assigned(photos)], folders: [assigned(trips)], nextCursor: null };
        if (input.providerFolderId === trips.providerNodeId) return { source, current: assigned(trips), breadcrumbs: [assigned(providerRoot), assigned(photos), assigned(trips)], folders: [], nextCursor: null };
        if (input.providerFolderId === movies.providerNodeId) return { source, current: assigned(movies), breadcrumbs: [assigned(providerRoot), assigned(movies)], folders: [], nextCursor: null };
        return { source, current: assigned(providerRoot), breadcrumbs: [assigned(providerRoot)], folders: [assigned(photos), assigned(movies)], nextCursor: null };
      },
      createRoot: async (_id, body) => {
        const folder = [providerRoot, photos, movies, trips].find(value => value.providerNodeId === body.providerNodeId);
        const existingId = rootByProviderNode.get(body.providerNodeId);
        const root = roots.find(value => value.id === existingId) ?? { id: `root-${body.providerNodeId}`, sourceId, displayName: body.displayName ?? folder?.name ?? "Selected folder", enabled: true, createdAt: now };
        roots = [...roots.filter(value => value.id !== root.id), root];
        rootByProviderNode.set(body.providerNodeId, root.id);
        revision += 1;
        return { root };
      },
      rootImpact: async id => ({ roots: roots.filter(root => root.id === id), devices: devices.filter(device => device.assignedRootIds.includes(id)) }),
      removeRoot: async id => {
        const removedRoots = roots.filter(root => root.id === id);
        const affectedDevices = devices.filter(device => device.assignedRootIds.includes(id));
        roots = roots.filter(root => root.id !== id);
        for (const [providerNodeId, rootId] of rootByProviderNode) if (rootId === id) rootByProviderNode.delete(providerNodeId);
        devices = devices.map(device => ({ ...device, assignedRootIds: device.assignedRootIds.filter(rootId => rootId !== id) }));
        revision += 1;
        return { removed: true, roots: removedRoots, devices: affectedDevices };
      },
      approveRequest: async (_id, body) => { const device = { id: "device-1", name: body.name, enabled: true, assignedRootIds: body.rootIds, mediaOrder: body.mediaOrder ?? null, slideshowSeconds: body.slideshowSeconds ?? null, createdAt: now, approvedAt: now, revokedAt: null }; devices = [device]; requests = []; revision += 1; return { device }; },
      denyRequest: async id => ({ request: { ...requests.find(value => value.id === id), status: "denied" } }),
      updateDevice: async (id, body) => {
        devices = devices.map(device => device.id === id ? {
          ...device,
          name: body.name ?? device.name,
          enabled: body.enabled ?? device.enabled,
          assignedRootIds: body.assignedRootIds ?? device.assignedRootIds,
          mediaOrder: body.mediaOrder === undefined ? device.mediaOrder : body.mediaOrder,
          slideshowSeconds: body.slideshowSeconds === undefined ? device.slideshowSeconds : body.slideshowSeconds
        } : device);
        return { device: devices[0] };
      },
      revokeDevice: async id => { devices = devices.filter(device => device.id !== id); revision += 1; return { revoked: true }; }
    };
  }, { scenario });
}
