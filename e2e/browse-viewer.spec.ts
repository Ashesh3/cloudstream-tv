import { expect, test } from "@playwright/test";
import { installTvFixture } from "./fixtures";

test("folder browse opens a unified image and video viewer", async ({ page }) => {
  await installTvFixture(page, "ready");
  await page.goto("/");
  await expect(page.getByText("Family Trips")).toBeVisible();
  await page.getByText("Family Trips").click();
  await expect(page.getByText("Sunset.jpg")).toBeVisible();
  await page.getByText("Sunset.jpg").click();
  await expect(page.locator("img")).toBeVisible();
  await page.locator(".viewer-shell").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("video")).toBeVisible();
  await expect(page.locator(".viewer-shell")).toHaveScreenshot("tv-viewer-video.png", { animations: "disabled" });
});

test("viewer persists video history on page lifecycle", async ({ page }) => {
  await installTvFixture(page, "ready");
  await page.goto("/");
  await page.getByText("Family Trips").click();
  await page.getByText("Lake.mp4").click();
  await expect(page.locator("video")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(page.locator("html")).toHaveAttribute("data-history-saves", "1");
});
