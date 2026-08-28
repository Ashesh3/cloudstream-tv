import { expect, test } from "@playwright/test";
import { installTvFixture, media } from "./fixtures";

test("folder browse opens a unified image and video viewer", async ({ page }) => {
  await installTvFixture(page, "ready");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Family Trips, program" })).toBeVisible();
  await page.getByRole("button", { name: "Family Trips, program" }).click();
  await expect(page.getByRole("heading", { name: "Family Trips" })).toBeVisible();
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
  expect(new URL(await video.getAttribute("src")!).pathname).not.toMatch(/^\/api\//);
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
