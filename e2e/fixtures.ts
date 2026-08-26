import type { Page } from "@playwright/test";

export const media = {
  image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'%3E%3Crect width='1200' height='800' fill='%2315304f'/%3E%3Ccircle cx='350' cy='310' r='130' fill='%23ffd36e'/%3E%3Cpath d='M0 720 430 350 730 610 940 430 1200 690V800H0Z' fill='%2369b1d4'/%3E%3C/svg%3E",
  video: "/e2e-video.mp4"
};

export async function installTvFixture(page: Page, state: "unenrolled" | "ready" = "ready") {
  await page.addInitScript(({ state, media }) => {
    const now = new Date().toISOString();
    let status = state;
    let historySaves = 0;
    const folder = {
      id: "folder-1", name: "Family Trips", kind: "folder", mimeType: null,
      size: null, width: null, height: null, capturedAt: null, createdAtProvider: now,
      modifiedAtProvider: now, thumbnailRevision: null, hasPreview: false,
      folderCoverNodeIds: ["image-1", "image-2"], childFolderCount: 0,
      childMediaCount: 2, available: true
    };
    const image = { ...folder, id: "image-1", name: "Sunset.jpg", kind: "image", mimeType: "image/jpeg", width: 1200, height: 800, hasPreview: true, folderCoverNodeIds: [], childMediaCount: 0 };
    const video = { ...folder, id: "video-1", name: "Lake.mp4", kind: "video", mimeType: "video/mp4", width: 1280, height: 720, hasPreview: true, folderCoverNodeIds: [], childMediaCount: 0 };
    const household = { id: "household-test", allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 8 };
    const device = { id: "device-1", name: "Living Room", enabled: true, assignedRootIds: ["root-1"], mediaOrder: null, slideshowSeconds: null, createdAt: now, approvedAt: now, lastSeenAt: now, revokedAt: null };
    const enrollment = () => status === "ready"
      ? { state: "ready", household, device }
      : status === "pending"
        ? { state: "pending", request: { id: "request-1", requestedName: "Living Room", status: "pending", createdAt: now, expiresAt: new Date(Date.now()+3600000).toISOString(), resolvedAt: null, approvedDeviceId: null } }
        : { state: "unenrolled" };
    window.__CLOUDFRAME_TEST_TV_API__ = {
      bootstrap: async () => ({ enrollment: enrollment() }),
      createDeviceRequest: async name => { status = "pending"; document.cookie = "cf_device_request=e2e; path=/"; return { request: { id: "request-1", requestedName: name, status: "pending", createdAt: now, expiresAt: new Date(Date.now() + 3600000).toISOString(), resolvedAt: null, approvedDeviceId: null } }; },
      requestStatus: async () => ({ enrollment: enrollment() }),
      home: async () => ({ roots: [{ id: "root-1", nodeId: "folder-1", sourceId: "source-1", sourceLabel: "Family Drive", displayName: "Family Trips", coverNodeIds: ["image-1", "image-2"] }] }),
      folder: async () => ({ parent: folder, breadcrumbs: [folder], children: [image, video], nextCursor: null }),
      thumbnailUrls: async ids => ({ items: ids.map(nodeId => ({ nodeId, url: media.image, expiresAt: new Date(Date.now()+3600000).toISOString(), revision: "1" })) }),
      mediaUrl: async nodeId => ({ nodeId, kind: nodeId === "video-1" ? "video" : "image", url: nodeId === "video-1" ? media.video : media.image, expiresAt: new Date(Date.now()+3600000).toISOString(), revision: "1" }),
      history: async () => ({ history: [] }),
      saveHistory: async (nodeId, value) => { historySaves += 1; document.documentElement.dataset.historySaves = String(historySaves); return { history: { id: `device-1_${nodeId}`, deviceId: "device-1", nodeId, ...value, updatedAt: new Date().toISOString() } }; }
    };
  }, { state, media });
}

export async function installAdminFixture(page: Page) {
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const roots = [{ id: "root-1", sourceId: "source-1", providerNodeId: "folder-1", displayName: "Family Trips", ancestryProviderIds: [], enabled: true, createdAt: now }];
    let devices = [];
    let requests = [{ id: "request-1", requestedName: "Living Room", status: "pending", createdAt: now, expiresAt: new Date(Date.now()+3600000).toISOString(), resolvedAt: null, approvedDeviceId: null }];
    const household = { id: "household-test", allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 8 };
    const source = { id: "source-1", provider: "google", accountLabel: "family@example.test", status: "healthy", lastSyncStartedAt: now, lastSyncCompletedAt: now, lastSyncErrorCode: null, nextSyncAt: now, crawlCheckpoint: null };
    const overview = () => ({ household, pendingRequests: requests, devices, sources: [source], roots });
    document.cookie = "cf_device_request=e2e-request; path=/";
    window.__CLOUDFRAME_TEST_ADMIN_API__ = {
      login: async () => ({ authenticated: true }), logout: async () => ({ authenticated: false }), overview: async () => overview(), settings: async () => ({ allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 8 }),
      updateSettings: async body => body, rotatePassphrase: async () => ({ authenticated: false }),
      sources: async () => ({ sources: [{ ...source, roots }] }), authorizeSource: async () => ({ authorizationUrl: "https://example.test/oauth" }), syncSource: async () => ({}), sourceImpact: async () => ({ roots, devices }), removeSource: async () => ({ removed: true, roots, devices }),
      sourceTree: async () => ({ parent: null, breadcrumbs: [], folders: [{ id: "folder-2", name: "Archive", kind: "folder", mimeType: null, size: null, width: null, height: null, capturedAt: null, createdAtProvider: now, modifiedAtProvider: now, thumbnailRevision: null, hasPreview: false, folderCoverNodeIds: [], childFolderCount: 0, childMediaCount: 0, available: true }] }),
      createRoot: async (_id, body) => ({ root: roots[0] ?? { id: "root-2", sourceId: "source-1", providerNodeId: body.providerNodeId, displayName: body.displayName, ancestryProviderIds: [], enabled: true, createdAt: now } }), rootImpact: async () => ({ roots, devices }), removeRoot: async () => ({ removed: true, roots, devices }), thumbnailUrls: async () => ({ items: [] }),
      approveRequest: async (_id, body) => { const device = { id: "device-1", name: body.name, enabled: true, assignedRootIds: body.rootIds, mediaOrder: body.mediaOrder ?? null, slideshowSeconds: body.slideshowSeconds ?? null, createdAt: now, approvedAt: now, lastSeenAt: now, revokedAt: null }; devices = [device]; requests = []; document.cookie = "cf_device=e2e-device; path=/; SameSite=Strict"; document.cookie = "cf_device_request=; Max-Age=0; path=/"; return { device }; },
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
      revokeDevice: async id => { devices = devices.filter(device => device.id !== id); return { revoked: true }; }
    };
  });
}
