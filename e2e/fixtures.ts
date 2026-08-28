import type { Page } from "@playwright/test";

export const media = {
  image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'%3E%3Crect width='1200' height='800' fill='%2315304f'/%3E%3Ccircle cx='350' cy='310' r='130' fill='%23ffd36e'/%3E%3Cpath d='M0 720 430 350 730 610 940 430 1200 690V800H0Z' fill='%2369b1d4'/%3E%3C/svg%3E",
  video: "/e2e-video.mp4"
};

export async function installTvFixture(page: Page, state: "unenrolled" | "ready" = "ready") {
  const persistedHistory = new Map<string, { nodeId: string; positionSeconds: number; durationSeconds: number; completed: boolean; updatedAt: string }>();
  await page.exposeFunction("__cloudframeHistoryList", () => [...persistedHistory.values()]);
  await page.exposeFunction("__cloudframeHistorySave", (nodeId: string, value: { positionSeconds: number; durationSeconds: number; completed: boolean }) => {
    const saved = { nodeId, ...value, updatedAt: new Date().toISOString() };
    persistedHistory.set(nodeId, saved);
    return saved;
  });
  await page.addInitScript(({ state, media }) => {
    const now = new Date().toISOString();
    let status = state;
    let historySaves = 0;
    const folder = {
      id: "folder-1", sourceId: "source-1", provider: "google", parentNodeId: null,
      name: "Family Trips", normalizedName: "family trips", kind: "folder", mimeType: null,
      size: null, width: null, height: null, capturedAt: null, createdAtProvider: now,
      modifiedAtProvider: now, thumbnailRevision: null, hasPreview: false,
      folderCoverNodeIds: ["image-1", "image-2"], childFolderCount: 0,
      childMediaCount: 2, available: true
    };
    const image = { ...folder, id: "image-1", parentNodeId: folder.id, name: "Sunset.jpg", normalizedName: "sunset.jpg", kind: "image", mimeType: "image/jpeg", width: 1200, height: 800, hasPreview: true, folderCoverNodeIds: [], childMediaCount: 0 };
    const video = { ...folder, id: "video-1", parentNodeId: folder.id, name: "Lake.mp4", normalizedName: "lake.mp4", kind: "video", mimeType: "video/mp4", width: 1280, height: 720, hasPreview: true, folderCoverNodeIds: [], childMediaCount: 0 };
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
      home: async () => ({ roots: [{ id: "root-1", sourceId: "source-1", displayName: "Family Trips", provider: "google", accountLabel: "Family Drive", nodeId: "folder-1", folderCoverNodeIds: ["image-1", "image-2"], childFolderCount: 0, childMediaCount: 2, readiness: "ready", readinessMessage: "Ready to screen" }] }),
      folder: async () => ({ parent: folder, breadcrumbs: [folder], children: [image, video], nextCursor: null }),
      thumbnailUrls: async ids => ({ items: ids.map(nodeId => ({ nodeId, status: "ready", url: media.image, expiresAt: new Date(Date.now()+3600000).toISOString(), revision: "1" })) }),
      mediaUrl: async nodeId => ({ nodeId, kind: nodeId === "video-1" ? "video" : "image", url: nodeId === "video-1" ? media.video : media.image, expiresAt: new Date(Date.now()+3600000).toISOString(), revision: "1" }),
      history: async () => ({ history: await window.__cloudframeHistoryList() }),
      saveHistory: async (nodeId, value) => { historySaves += 1; document.documentElement.dataset.historySaves = String(historySaves); return { history: await window.__cloudframeHistorySave(nodeId, value) }; }
    };
  }, { state, media });
}

declare global {
  interface Window {
    __cloudframeHistoryList(): Promise<Array<{ nodeId: string; positionSeconds: number; durationSeconds: number; completed: boolean; updatedAt: string }>>;
    __cloudframeHistorySave(nodeId: string, value: { positionSeconds: number; durationSeconds: number; completed: boolean }): Promise<{ nodeId: string; positionSeconds: number; durationSeconds: number; completed: boolean; updatedAt: string }>;
  }
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
    let revision = 1;
    const snapshot = () => ({ revision, household, pendingRequests: requests, devices, sources: [source], roots, recoveryCopy: { status: "current", revision } });
    document.cookie = "cf_device_request=e2e-request; path=/";
    window.__CLOUDFRAME_TEST_ADMIN_API__ = {
      login: async () => ({ authenticated: true }), logout: async () => ({ authenticated: false }), snapshot: async () => snapshot(),
      updateSettings: async body => { Object.assign(household, body); revision += 1; return { revision }; }, rotatePassphrase: async () => ({ authenticated: false, revision: ++revision }),
      authorizeSource: async provider => ({ authorizationUrl: provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth?client_id=test" : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=test" }), sourceImpact: async () => ({ roots, devices }), removeSource: async () => ({ removed: true, roots, devices }),
      providerFolders: async (_id, input) => {
        const assigned = folder => ({ ...folder, assignedRootId: document.documentElement.dataset[`root${folder.providerNodeId}`] ?? null });
        if (input.providerFolderId === photos.providerNodeId) return { source, current: assigned(photos), breadcrumbs: [assigned(providerRoot), assigned(photos)], folders: [assigned(trips)], nextCursor: null };
        if (input.providerFolderId === trips.providerNodeId) return { source, current: assigned(trips), breadcrumbs: [assigned(providerRoot), assigned(photos), assigned(trips)], folders: [], nextCursor: null };
        if (input.providerFolderId === movies.providerNodeId) return { source, current: assigned(movies), breadcrumbs: [assigned(providerRoot), assigned(movies)], folders: [], nextCursor: null };
        return { source, current: assigned(providerRoot), breadcrumbs: [assigned(providerRoot)], folders: [assigned(photos), assigned(movies)], nextCursor: null };
      },
      createRoot: async (_id, body) => {
        const folder = [providerRoot, photos, movies, trips].find(value => value.providerNodeId === body.providerNodeId);
        const root = roots.find(value => value.id === document.documentElement.dataset[`root${body.providerNodeId}`]) ?? { id: `root-${body.providerNodeId}`, sourceId, displayName: body.displayName ?? folder?.name ?? "Selected folder", enabled: true, createdAt: now };
        roots = [...roots.filter(value => value.id !== root.id), root];
        document.documentElement.dataset[`root${body.providerNodeId}`] = root.id;
        if (scenario === "source-workbench") devices = devices.map(device => ({ ...device, assignedRootIds: [...new Set([...device.assignedRootIds, root.id])] }));
        revision += 1;
        return { root };
      },
      rootImpact: async id => ({ roots: roots.filter(root => root.id === id), devices: devices.filter(device => device.assignedRootIds.includes(id)) }),
      removeRoot: async id => {
        const removedRoots = roots.filter(root => root.id === id);
        const affectedDevices = devices.filter(device => device.assignedRootIds.includes(id));
        roots = roots.filter(root => root.id !== id);
        devices = devices.map(device => ({ ...device, assignedRootIds: device.assignedRootIds.filter(rootId => rootId !== id) }));
        revision += 1;
        return { removed: true, roots: removedRoots, devices: affectedDevices };
      },
      approveRequest: async (_id, body) => { const device = { id: "device-1", name: body.name, enabled: true, assignedRootIds: body.rootIds, mediaOrder: body.mediaOrder ?? null, slideshowSeconds: body.slideshowSeconds ?? null, createdAt: now, approvedAt: now, revokedAt: null }; devices = [device]; requests = []; revision += 1; document.cookie = "cf_device=e2e-device; path=/; SameSite=Strict"; document.cookie = "cf_device_request=; Max-Age=0; path=/"; return { device }; },
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
