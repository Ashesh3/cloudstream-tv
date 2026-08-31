import { expect, test } from "@playwright/test";
import { installAdminFixture } from "./fixtures";

test("live source folders are immediately available with explicit removal impact", async ({ page }, testInfo) => {
  await installAdminFixture(page, "source-workbench");
  await page.goto("/admin/");
  await page.getByLabel(/passphrase/i).fill("synthetic acceptance passphrase");
  await page.getByRole("button", { name: /sign in/i }).click();

  if (testInfo.project.name === "admin-mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const diagnostics = page.getByRole("region", { name: "Transcoder status" });
  await expect(diagnostics).toContainText("MOV00516.MPG");
  await expect(diagnostics).toContainText("Encoding window 3");
  await expect(diagnostics.locator("button, a, input, select, textarea, [tabindex]:not([tabindex='-1'])")).toHaveCount(0);

  if (testInfo.project.name === "admin-mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("button", { name: "Browse & choose folders" }).click();
  const region = page.getByRole("region", { name: "Choose source folders" });
  await expect(region).toBeVisible();
  await expect(region).toContainText("Folders added to the household program are available to assigned televisions immediately.");
  await expect(page.getByRole("region", { name: "Source health" })).toContainText("Connected");
  await expect(page.getByRole("navigation", { name: "Provider folder path" })).toContainText("My Drive");

  for (const control of [
    page.getByRole("button", { name: "Back to sources" }),
    page.getByRole("button", { name: "Close folder workbench" }),
    page.getByRole("button", { name: "Back", exact: true }),
    page.getByRole("button", { name: "Open Photos" }),
    page.getByRole("button", { name: "Add Photos to household program" })
  ]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  await page.getByRole("button", { name: "Open Photos" }).click();
  await page.getByRole("button", { name: "Add Trips to household program" }).click();
  await expect(region).toContainText("Trips was added to the household program.");
  await expect(region).toContainText("available to assigned televisions immediately");
  await expect(page.getByRole("button", { name: "Trips is in the household program" })).toBeDisabled();
  await expect(region.getByText("Trips", { exact: true }).last()).toBeVisible();

  await page.getByRole("button", { name: "Close folder workbench" }).click();
  await expect(page.getByRole("button", { name: "Browse & choose folders" })).toBeFocused();
  if (testInfo.project.name === "admin-mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Devices", exact: true }).click();
  await page.getByRole("button", { name: "Edit Living Room" }).click();
  await page.getByRole("checkbox", { name: "Trips" }).check();
  await page.getByRole("button", { name: "Save device" }).click();
  await expect(page.getByRole("dialog", { name: "Edit device" })).toBeHidden();
  if (testInfo.project.name === "admin-mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("button", { name: "Browse & choose folders" }).click();
  await page.getByRole("button", { name: "Open Photos" }).click();
  await expect(page.getByRole("button", { name: "Trips is in the household program" })).toBeDisabled();

  if (testInfo.project.name === "admin-mobile") {
    const viewport = page.viewportSize(); const bounds = await region.boundingBox();
    expect(viewport).not.toBeNull(); expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.width).toBeLessThanOrEqual(viewport!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport!.width);
  }

  await page.getByRole("button", { name: "Review removal impact for Trips" }).click();
  const confirmation = page.getByRole("dialog", { name: "Remove folder from household program" });
  await expect(confirmation).toContainText("Access is removed immediately from every assigned television.");
  await expect(confirmation.getByText("Living Room")).toBeVisible();
  const removeControl = confirmation.getByRole("button", { name: "Remove Trips" });
  await expect.poll(async () => (await removeControl.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
  await expect.poll(async () => (await removeControl.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Review removal impact for Trips" })).toBeFocused();
  await page.getByRole("button", { name: "Review removal impact for Trips" }).click();
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(page.getByRole("button", { name: "Review removal impact for Trips" })).toBeFocused();
  await page.getByRole("button", { name: "Review removal impact for Trips" }).click();
  await confirmation.getByRole("button", { name: "Remove Trips" }).click();
  await expect(page.getByText("No folders in the household program")).toBeVisible();

  await page.getByRole("button", { name: "Close folder workbench" }).click();
  await expect(page.getByRole("button", { name: "Browse & choose folders" })).toBeFocused();
});
