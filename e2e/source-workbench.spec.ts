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

  for (const control of [
    page.getByRole("button", { name: "Back to sources" }),
    page.getByRole("button", { name: "Close folder workbench" }),
    page.getByRole("button", { name: "Back", exact: true }),
    page.getByRole("button", { name: "My Drive", exact: true }),
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
  await page.getByRole("button", { name: "Browse & choose folders" }).click();
  await expect(page.getByRole("region", { name: "Choose source folders" }).getByText("Trips", { exact: true }).last()).toBeVisible();

  await page.getByRole("button", { name: "Review removal impact for Trips" }).click();
  let confirmation = page.getByRole("dialog", { name: "Remove folder from household program" });
  await expect(confirmation).toContainText("No televisions currently use this folder.");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Close folder workbench" }).click();
  await page.getByRole("button", { name: "Devices", exact: true }).click();
  await page.getByRole("button", { name: "Edit Living Room" }).click();
  await page.getByRole("checkbox", { name: "Trips" }).check();
  await page.getByRole("button", { name: "Save device" }).click();
  await expect(page.getByRole("dialog", { name: "Edit device" })).toBeHidden();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("button", { name: "Browse & choose folders" }).click();
  await expect(page.getByRole("region", { name: "Choose source folders" }).getByText("Trips", { exact: true }).last()).toBeVisible();

  if (testInfo.project.name === "admin-mobile") {
    const viewport = page.viewportSize(); const bounds = await region.boundingBox();
    expect(viewport).not.toBeNull(); expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeLessThanOrEqual(1); expect(bounds!.y).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds!.width - viewport!.width)).toBeLessThanOrEqual(1); expect(bounds!.height).toBeGreaterThanOrEqual(viewport!.height);
  }

  await page.getByRole("button", { name: "Review removal impact for Trips" }).click();
  confirmation = page.getByRole("dialog", { name: "Remove folder from household program" });
  await expect(confirmation).toContainText("Access is removed immediately from every assigned television.");
  await expect(confirmation.getByText("Living Room")).toBeVisible();
  const removeControl = confirmation.getByRole("button", { name: "Remove Trips" });
  const removeBox = await removeControl.boundingBox();
  expect(removeBox).not.toBeNull();
  expect(removeBox!.width).toBeGreaterThanOrEqual(44);
  expect(removeBox!.height).toBeGreaterThanOrEqual(44);
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Review removal impact for Trips" })).toBeFocused();
  await page.getByRole("button", { name: "Review removal impact for Trips" }).click();
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(page.getByRole("button", { name: "Review removal impact for Trips" })).toBeFocused();
  await page.getByRole("button", { name: "Review removal impact for Trips" }).click();
  await confirmation.getByRole("button", { name: "Remove Trips" }).click();
  await expect(region.getByText("No folders in the household program")).toBeVisible();

  await page.getByRole("button", { name: "Close folder workbench" }).click();
  await expect(page.getByRole("button", { name: "Browse & choose folders" })).toBeFocused();
});
