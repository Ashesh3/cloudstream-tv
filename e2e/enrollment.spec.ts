import { expect, test } from "@playwright/test";
import { installAdminFixture, installTvFixture } from "./fixtures";

test("TV request, admin approve, cookie promotion, reassign, and revoke", async ({ page }, testInfo) => {
  if (testInfo.project.name === "tv-1920") {
    await installTvFixture(page, "unenrolled");
    await page.goto("/");
    await page.getByRole("textbox").fill("Living Room");
    await page.getByRole("button", { name: /request access/i }).click();
    await expect(page.getByText(/waiting for approval/i)).toBeVisible();
    await page.locator(".state-detail").evaluate(element => {
      element.textContent = "Request expires soon";
    });
    await expect(page.locator("main")).toHaveScreenshot("tv-enrollment-waiting.png", { animations: "disabled" });
    return;
  }

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
  expect(cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: "cf_device", sameSite: "Strict" })]));
  expect(cookies.some(cookie => cookie.name === "cf_device_request")).toBe(false);
  await page.getByRole("button", { name: /devices/i }).click();
  await page.getByRole("button", { name: /edit/i }).click();
  await page.getByLabel(/device name/i).fill("Den TV");
  await page.getByRole("button", { name: /save device/i }).click();
  await expect(page.getByRole("dialog", { name: /edit device/i })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Den TV" })).toBeVisible();
  await page.getByRole("button", { name: /revoke den tv/i }).click();
  await page.getByRole("button", { name: /revoke permanently/i }).click();
  await expect(page.getByText(/was revoked/i)).toBeVisible();
  await expect(page).toHaveScreenshot(`admin-${testInfo.project.name}.png`, { animations: "disabled", fullPage: true });
});
