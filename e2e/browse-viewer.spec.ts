import { expect, test } from "@playwright/test";
import { installTvFixture, media } from "./fixtures";

test("folder browse opens a unified image and video viewer", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", request => requests.push(request.url()));
  await installTvFixture(page, "ready");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Family Trips, program" })).toBeVisible();
  await page.getByRole("button", { name: "Family Trips, program" }).click();
  await expect(page.getByRole("heading", { name: "Family Trips" })).toBeVisible();
  await expect.poll(async () => (await tvApiCalls(page)).thumbnails.flat().length).toBe(3);
  const beforeScroll = await tvApiCalls(page);
  expect(beforeScroll.thumbnails.flat()).toEqual(expect.arrayContaining([
    "sealed-child-folder",
    "sealed-image",
    "sealed-video"
  ]));
  await expect(page.getByRole("button", { name: "Albums, folder" }).locator("img")).toHaveAttribute("src", media.folderThumbnail);
  await expect(page.getByText("Sunset.jpg")).toBeVisible();
  await page.getByText("Sunset.jpg").click();
  await expect(page.getByRole("img", { name: "Sunset.jpg" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Sunset.jpg" })).toHaveAttribute("src", media.image);
  expect(new URL(await page.getByRole("img", { name: "Sunset.jpg" }).getAttribute("src")!).pathname).not.toMatch(/^\/api\//);
  await expect(page.locator(".viewer-shell")).toHaveScreenshot("tv-viewer-image.png", { animations: "disabled" });
  await page.keyboard.press("ArrowRight");
  const video = page.getByLabel("Playing Lake.mp4");
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("src", media.video);
  await expect(page.locator("video-player > media-container > video")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => ({
    player: Boolean(customElements.get("video-player")),
    container: Boolean(customElements.get("media-container"))
  }))).toEqual({ player: true, container: true });
  expect(new URL(await video.getAttribute("src")!).pathname).not.toMatch(/^\/api\//);
  const calls = await tvApiCalls(page);
  expect(calls.folder).toEqual([{ handle: "sealed-folder", cursor: null }]);
  expect(calls.thumbnails.length).toBeGreaterThan(0);
  expect(calls.thumbnails.flat()).toEqual(expect.arrayContaining(["sealed-child-folder", "sealed-image", "sealed-video"]));
  expect(calls.thumbnails.flat()).not.toEqual(expect.arrayContaining(["item_image", "item_video"]));
  expect(calls.media.map(call => call.handle)).toEqual(expect.arrayContaining(["sealed-image", "sealed-video"]));
  expect(requests.some(url => url.includes("/api/tv/google-media/"))).toBe(false);
});

test("folder browse preloads thumbnails beyond the virtual window before scrolling", async ({ page }) => {
  await installTvFixture(page, "ready", { longFolder: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Family Trips, program" }).click();
  const grid = page.getByRole("grid", { name: "Family Trips" });
  await expect(grid).toBeVisible();
  await expect(page.getByRole("button", { name: "Extra 29.jpg, image" })).toHaveCount(0);

  await expect.poll(async () => (await tvApiCalls(page)).thumbnails.flat().length).toBe(33);
  expect((await tvApiCalls(page)).thumbnails.flat()).toEqual(expect.arrayContaining([
    "sealed-child-folder",
    "sealed-video",
    "sealed-extra-29"
  ]));

  await grid.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const lastCard = page.getByRole("button", { name: "Extra 29.jpg, image" });
  await expect(lastCard).toBeVisible();
  await expect(lastCard.locator("img")).toHaveAttribute("src", media.thumbnail);
});

test("viewer saves and restores a nonzero video position", async ({ page }) => {
  await installTvFixture(page, "ready");
  await page.goto("/");
  await page.getByRole("button", { name: "Family Trips, program" }).click();
  await page.getByText("Lake.mp4").click();
  const video = page.getByLabel("Playing Lake.mp4");
  await expect(video).toBeVisible();
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, "duration", { configurable: true, value: 10 });
    Object.defineProperty(element, "currentTime", { configurable: true, writable: true, value: 1.25 });
    element.dispatchEvent(new Event("timeupdate"));
  });
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cloudframe.tv.watch-history.v1:device-1"))).not.toBeNull();
  const serialized = await page.evaluate(() => localStorage.getItem("cloudframe.tv.watch-history.v1:device-1"));
  expect(serialized).not.toBeNull();
  expect(serialized).toContain("item_video");
  expect(serialized).not.toMatch(/sealed-|provider|https?:|token/i);
  expect(JSON.parse(serialized!)).toEqual({
    version: 1,
    entries: {
      item_video: expect.objectContaining({ positionSeconds: 1.25, durationSeconds: 10, completed: false })
    }
  });
  await expect(page.getByText("Lake.mp4")).toBeVisible();
  await page.getByText("Lake.mp4").click();
  await expect(video).toBeVisible();
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, "duration", { configurable: true, value: 10 });
    Object.defineProperty(element, "currentTime", { configurable: true, writable: true, value: 0 });
    element.dispatchEvent(new Event("loadedmetadata"));
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
});

test("TV fixture rejects public, duplicate, and unknown navigation handles", async ({ page }) => {
  await installTvFixture(page, "ready");
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const api = (window as Window & { __CLOUDFRAME_TEST_TV_API__: {
      folder(handle: string, cursor?: string | null): Promise<unknown>;
      thumbnailUrls(handles: string[]): Promise<unknown>;
      mediaUrl(handle: string): Promise<unknown>;
    } }).__CLOUDFRAME_TEST_TV_API__;
    const rejected: string[] = [];
    for (const [label, call] of [
      ["public-folder", () => api.folder("item_folder")],
      ["unknown-folder", () => api.folder("sealed-unknown")],
      ["bad-cursor", () => api.folder("sealed-folder", "cursor-unknown")],
      ["public-thumbnails", () => api.thumbnailUrls(["item_image"])],
      ["duplicate-thumbnails", () => api.thumbnailUrls(["sealed-image", "sealed-image"])],
      ["unknown-thumbnails", () => api.thumbnailUrls(["sealed-unknown"])],
      ["public-media", () => api.mediaUrl("item_video")],
      ["unknown-media", () => api.mediaUrl("sealed-unknown")]
    ] as Array<[string, () => Promise<unknown>]>) {
      try { await call(); } catch { rejected.push(label); }
    }
    return rejected;
  });
  expect(result).toEqual([
    "public-folder", "unknown-folder", "bad-cursor", "public-thumbnails",
    "duplicate-thumbnails", "unknown-thumbnails", "public-media", "unknown-media"
  ]);
});

test("explicit local resume seed restores without persisting navigation secrets", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cloudframe.tv.watch-history.v1:device-1", JSON.stringify({
    version: 1,
    entries: {
      item_video: {
        positionSeconds: 4.5,
        durationSeconds: 10,
        completed: false,
        updatedAt: "2026-08-27T12:00:00.000Z"
      }
    }
  })));
  await installTvFixture(page, "ready");
  await page.goto("/");
  await page.getByRole("button", { name: "Family Trips, program" }).click();
  await page.getByText("Lake.mp4").click();
  const video = page.getByLabel("Playing Lake.mp4");
  await expect(video).toBeVisible();
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, "duration", { configurable: true, value: 10 });
    Object.defineProperty(element, "currentTime", { configurable: true, writable: true, value: 0 });
    element.dispatchEvent(new Event("loadedmetadata"));
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(4.5);
  const serialized = await page.evaluate(() => localStorage.getItem("cloudframe.tv.watch-history.v1:device-1"));
  expect(serialized).toContain("item_video");
  expect(serialized).not.toMatch(/sealed-|provider|https?:|token/i);
});

async function tvApiCalls(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as Window & { __CLOUDFRAME_TEST_TV_CALLS__: {
    folder: Array<{ handle: string; cursor: string | null }>;
    thumbnails: string[][];
    media: Array<{ handle: string; fallback: string | null }>;
    heartbeat: string[];
    release: string[];
  } }).__CLOUDFRAME_TEST_TV_CALLS__);
}
