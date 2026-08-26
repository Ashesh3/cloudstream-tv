import { expect, test } from "@playwright/test";
import { installTvFixture } from "./fixtures";

test("folder browse opens a unified image and video viewer", async ({ page }) => {
  await installTvFixture(page, "ready");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Family Trips, program" })).toBeVisible();
  await page.getByRole("button", { name: "Family Trips, program" }).click();
  await expect(page.getByText("Sunset.jpg")).toBeVisible();
  await page.getByText("Sunset.jpg").click();
  await expect(page.getByRole("img", { name: "Sunset.jpg" })).toBeVisible();
  await expect(page.locator(".viewer-shell")).toHaveScreenshot("tv-viewer-image.png", { animations: "disabled" });
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Playing Lake.mp4")).toBeVisible();
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
    element.currentTime = 1.25;
    element.dispatchEvent(new Event("timeupdate"));
  });
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => window.__cloudframeHistoryList())).toEqual([
    expect.objectContaining({ nodeId: "video-1", positionSeconds: 1, durationSeconds: 10 })
  ]);
  await expect(page.getByText("Lake.mp4")).toBeVisible();
  await page.getByText("Lake.mp4").click();
  await expect(video).toBeVisible();
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, "duration", { configurable: true, value: 10 });
    element.dispatchEvent(new Event("loadedmetadata"));
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
});
