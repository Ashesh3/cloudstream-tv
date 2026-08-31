import { expect, test } from "@playwright/test";
import { installAdminFixture } from "./fixtures";

test("admin settings remain ordered, responsive, and truthful", async ({ page }, testInfo) => {
  await installAdminFixture(page, "source-workbench");
  await page.goto("/admin/");
  await page.getByLabel(/passphrase/i).fill("synthetic acceptance passphrase");
  await page.getByRole("button", { name: /sign in/i }).click();
  if (testInfo.project.name === "admin-mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  const settings = page.getByRole("heading", { level: 1, name: "Settings" }).locator("xpath=ancestor::section[1]");
  const sectionHeadings = await settings.getByRole("heading", { level: 2 }).allTextContents();
  expect(sectionHeadings).toEqual(["Household defaults", "Current household status", "Transcoder status", "Change passphrase", "Admin session"]);

  await page.getByLabel("Allow new device requests").uncheck();
  await page.getByLabel("Oldest captured first").check();
  await page.getByLabel("Default slideshow seconds").fill("24");
  await page.getByRole("button", { name: "Save defaults" }).click();
  await expect(page.getByText("Household defaults saved.")).toBeVisible();
  await expect(page.getByLabel("Allow new device requests")).not.toBeChecked();
  await expect(page.getByLabel("Oldest captured first")).toBeChecked();
  await expect(page.getByLabel("Default slideshow seconds")).toHaveValue("24");

  const diagnostics = page.getByRole("region", { name: "Transcoder status" });
  await expect(diagnostics).toContainText("MOV00516.MPG");
  await expect(diagnostics.getByRole("progressbar", { name: "Encoding progress" })).toHaveAttribute("aria-valuenow", "61");
  await expect(diagnostics).not.toContainText(/providerNodeId|token|credential|https?:/i);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  if (testInfo.project.name === "admin-mobile") {
    for (const control of [page.getByRole("button", { name: "Save defaults" }), page.getByRole("button", { name: "Change passphrase" }), page.getByRole("button", { name: "Sign out" })]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  }
});
