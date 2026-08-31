import { expect, test, type Page } from "@playwright/test";
import { installAdminFixture, installTvFixture } from "./fixtures";

test("TV request enters the pending approval state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "tv-1920", "TV-only enrollment state");
  await installTvFixture(page, "unenrolled");
  await page.goto("/");
  await page.getByRole("textbox").fill("Living Room");
  await page.getByRole("button", { name: /request access/i }).click();
  await expect(page.getByText(/waiting for approval/i)).toBeVisible();
  await page.locator(".state-detail").evaluate(element => { element.textContent = "Request expires soon"; });
  await expect(page.locator("main")).toHaveScreenshot("tv-enrollment-waiting.png", { animations: "disabled" });
});

test("admin approves, edits, and revokes a TV without mutating TV cookies", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "tv-1920", "Admin-only responsive journey");
  await installAdminFixture(page);
  await page.goto("/admin/");
  await page.getByLabel(/passphrase/i).fill("synthetic acceptance passphrase");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByText("Living Room")).toBeVisible();
  await page.getByRole("button", { name: /approve/i }).click();
  await page.getByRole("checkbox", { name: /family trips/i }).check();
  await page.getByRole("button", { name: /approve device/i }).click();
  await expect(page.getByText(/was approved/i)).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.some(cookie => ["device_session", "device_request", "cf_device", "cf_device_request"].includes(cookie.name))).toBe(false);
  await page.getByRole("button", { name: /devices/i }).click();
  await page.getByRole("button", { name: /edit/i }).click();
  await page.getByLabel(/device name/i).fill("Den TV");
  await page.getByRole("button", { name: /save device/i }).click();
  await expect(page.getByRole("dialog", { name: /edit device/i })).toBeHidden();
  await expect(page.getByTestId("device-row")).toContainText("Den TV");
  await page.getByRole("button", { name: /revoke den tv/i }).click();
  await page.getByRole("button", { name: /revoke permanently/i }).click();
  await expect(page.getByText(/was revoked/i)).toBeVisible();
  await expect(page).toHaveScreenshot(`admin-${testInfo.project.name}.png`, { animations: "disabled", fullPage: true });
});

test("coordinated TV request becomes ready after approval and revoked after admin removal", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "tv-1920", "Coordinated TV/admin journey runs once");
  const bridge = createEnrollmentBridge();
  await installCoordinatedTvFixture(page, bridge);
  const admin = await context.newPage();
  await installCoordinatedAdminFixture(admin, bridge);

  await page.goto("/");
  await page.getByRole("textbox").fill("Living Room");
  await page.getByRole("button", { name: /request access/i }).click();
  await expect(page.getByText(/waiting for approval/i)).toBeVisible();

  await admin.goto("/admin/");
  await admin.getByLabel(/passphrase/i).fill("synthetic acceptance passphrase");
  await admin.getByRole("button", { name: /sign in/i }).click();
  await expect(admin.getByText("Living Room")).toBeVisible();
  await admin.getByRole("button", { name: /approve/i }).click();
  await admin.getByRole("checkbox", { name: /family trips/i }).check();
  await admin.getByRole("button", { name: /approve device/i }).click();
  await expect(admin.getByText(/was approved/i)).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Family Trips, collection" })).toBeVisible();

  await admin.getByRole("button", { name: /devices/i }).click();
  await admin.getByRole("button", { name: /revoke living room/i }).click();
  await admin.getByRole("button", { name: /revoke permanently/i }).click();
  await expect(admin.getByText(/was revoked/i)).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "TV access removed" })).toBeVisible();
});

type EnrollmentBridge = { state: "unenrolled" | "pending" | "ready" | "revoked"; name: string };
function createEnrollmentBridge(): EnrollmentBridge { return { state: "unenrolled", name: "Living Room" }; }

async function installCoordinatedTvFixture(page: Page, bridge: EnrollmentBridge) {
  await page.exposeFunction("__cloudframeEnrollmentGet", () => ({ ...bridge }));
  await page.exposeFunction("__cloudframeEnrollmentRequest", (name: string) => { bridge.name = name; bridge.state = "pending"; });
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const request = () => ({ id: "request-bridge", requestedName: "Living Room", status: "pending", createdAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), resolvedAt: null, approvedDeviceId: null });
    const household = { allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 8 };
    const device = { id: "device-bridge", name: "Living Room", enabled: true, assignedRootIds: ["root-1"], mediaOrder: null, slideshowSeconds: null, createdAt: now, approvedAt: now, revokedAt: null };
    const enrollment = async () => { const state = await window.__cloudframeEnrollmentGet(); return state.state === "ready" ? { state: "ready", household, device } : state.state === "pending" ? { state: "pending", request: { ...request(), requestedName: state.name } } : { state: state.state }; };
    window.__CLOUDFRAME_TEST_TV_API__ = {
      bootstrap: async () => ({ enrollment: await enrollment() }),
      createDeviceRequest: async name => { await window.__cloudframeEnrollmentRequest(name); return { request: { ...request(), requestedName: name } }; },
      requestStatus: async () => ({ enrollment: await enrollment() }),
      home: async () => ({ roots: [{ id: "item_folder", handle: "sealed-folder", displayName: "Family Trips", provider: "google", accountLabel: "Family Drive" }] }),
      folder: async () => { throw new Error("unused"); }, thumbnailUrls: async () => ({ items: [] }), mediaUrl: async () => { throw new Error("unused"); }
    };
  });
}

async function installCoordinatedAdminFixture(page: Page, bridge: EnrollmentBridge) {
  await page.exposeFunction("__cloudframeEnrollmentGet", () => ({ ...bridge }));
  await page.exposeFunction("__cloudframeEnrollmentApprove", () => { bridge.state = "ready"; });
  await page.exposeFunction("__cloudframeEnrollmentRevoke", () => { bridge.state = "revoked"; });
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const root = { id: "root-1", sourceId: "source-1", displayName: "Family Trips", enabled: true, createdAt: now };
    const source = { id: "source-1", provider: "google", accountLabel: "family@example.test", status: "healthy", createdAt: now };
    const device = { id: "device-bridge", name: "Living Room", enabled: true, assignedRootIds: [root.id], mediaOrder: null, slideshowSeconds: null, createdAt: now, approvedAt: now, revokedAt: null };
    const request = { id: "request-bridge", requestedName: "Living Room", status: "pending", createdAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), resolvedAt: null, approvedDeviceId: null };
    window.__CLOUDFRAME_TEST_ADMIN_API__ = {
      login: async () => ({ authenticated: true }), logout: async () => ({ authenticated: false }),
      snapshot: async () => { const state = await window.__cloudframeEnrollmentGet(); return { revision: 1, household: { allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 8 }, pendingRequests: state.state === "pending" ? [{ ...request, requestedName: state.name }] : [], devices: state.state === "ready" ? [device] : [], sources: [source], roots: [root], recoveryCopy: { status: "current", revision: 1 } }; },
      approveRequest: async (_id, body) => { await window.__cloudframeEnrollmentApprove(); return { device: { ...device, name: body.name, assignedRootIds: body.rootIds } }; },
      denyRequest: async () => ({ request: { ...request, status: "denied" } }), updateDevice: async () => ({ device }),
      revokeDevice: async () => { await window.__cloudframeEnrollmentRevoke(); return { revoked: true }; }, updateSettings: async () => ({ revision: 2 }), rotatePassphrase: async () => ({ authenticated: false, revision: 2 }),
      authorizeSource: async () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test" }), sourceImpact: async () => ({ roots: [root], devices: [device] }), removeSource: async () => ({ removed: true, roots: [root], devices: [device] }),
      providerFolders: async () => { throw new Error("unused"); }, createRoot: async () => ({ root }), rootImpact: async () => ({ roots: [root], devices: [device] }), removeRoot: async () => ({ removed: true, roots: [root], devices: [device] })
    };
  });
}

declare global {
  interface Window {
    __cloudframeEnrollmentGet(): Promise<EnrollmentBridge>;
    __cloudframeEnrollmentRequest(name: string): Promise<void>;
    __cloudframeEnrollmentApprove(): Promise<void>;
    __cloudframeEnrollmentRevoke(): Promise<void>;
  }
}
