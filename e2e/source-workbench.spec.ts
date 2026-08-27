import { expect, test } from "@playwright/test";
import { installAdminFixture } from "./fixtures";

test("live source folders are immediately available with explicit removal impact", async ({ page }, testInfo) => {
  await installAdminFixture(page, "source-workbench");
  await page.goto("/admin/");
  await page.getByLabel(/passphrase/i).fill("synthetic acceptance passphrase");
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("button", { name: "Browse & choose folders" }).click();
  const region = page.getByRole("region", { name: "Choose source folders" });
  await expect(region).toBeVisible();
  await expect(region).toContainText("Folders added to the household program are available to assigned televisions immediately.");
  await expect(page.getByRole("region", { name: "Source health" })).toContainText("Connected");

  await page.getByRole("button", { name: "Open Photos" }).click();
  await page.getByRole("button", { name: "Add Trips to household program" }).click();
  await expect(page.getByRole("button", { name: "Trips is in the household program" })).toBeDisabled();
  await expect(region.getByText("Trips", { exact: true }).last()).toBeVisible();

  if (testInfo.project.name === "admin-mobile") {
    const viewport = page.viewportSize(); const bounds = await region.boundingBox();
    expect(viewport).not.toBeNull(); expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeLessThanOrEqual(1); expect(bounds!.y).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds!.width - viewport!.width)).toBeLessThanOrEqual(1); expect(bounds!.height).toBeGreaterThanOrEqual(viewport!.height);
  }

  await page.getByRole("button", { name: "Review removal impact for Trips" }).click();
  const confirmation = page.getByRole("dialog", { name: "Remove folder from household program" });
  await expect(confirmation).toContainText("Access is removed immediately from every assigned television.");
  await expect(confirmation.getByText("Living Room")).toBeVisible();
  await confirmation.getByRole("button", { name: "Remove Trips" }).click();
  await expect(region.getByText("No folders in the household program")).toBeVisible();
});
