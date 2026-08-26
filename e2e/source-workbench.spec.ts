import { expect, test } from "@playwright/test";
import { installAdminFixture, setAdminIndexState } from "./fixtures";

test("live source folders stay browsable through indexing and quota recovery", async ({ page }, testInfo) => {
  await installAdminFixture(page, "source-workbench");
  await page.goto("/admin/");
  await page.getByLabel(/passphrase/i).fill("synthetic acceptance passphrase");
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("button", { name: "Browse & choose folders" }).click();
  await expect(page.getByRole("dialog", { name: "Choose source folders" })).toBeVisible();

  await page.getByRole("button", { name: "Open Photos" }).click();
  await expect(page.getByRole("navigation", { name: "Provider folder path" })).toContainText("My Drive");
  await page.getByRole("button", { name: "Add Trips to household program" }).click();
  await expect(workbench(page).getByText("Indexing queued", { exact: true })).toBeVisible();

  await closeWorkbench(page);
  await setAdminIndexState(page, "indexing");
  await refreshAndOpenWorkbench(page);
  await expect(workbench(page).getByText("Indexing selected folders", { exact: true })).toBeVisible();

  await closeWorkbench(page);
  await setAdminIndexState(page, "quota-exhausted");
  await refreshAndOpenWorkbench(page);
  await expect(workbench(page).getByText("Cloudframe indexing is paused by Firestore quota", { exact: true })).toBeVisible();
  await expect(workbench(page).getByText(/choose a smaller program or enable billing, then retry/i)).toBeVisible();

  await page.getByRole("button", { name: "Open Photos" }).click();
  await expect(page.getByRole("button", { name: "Trips is in the household program" })).toBeDisabled();

  const dialog = workbench(page);
  if (testInfo.project.name === "admin-mobile") {
    const viewport = page.viewportSize();
    const bounds = await dialog.boundingBox();
    expect(viewport).not.toBeNull();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeLessThanOrEqual(1);
    expect(bounds!.y).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds!.width - viewport!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds!.height - viewport!.height)).toBeLessThanOrEqual(1);
  }
  await expect(page).toHaveScreenshot("source-workbench-quota.png", { animations: "disabled" });

  await page.getByRole("button", { name: "Review removal impact for Trips" }).click();
  const confirmation = page.getByRole("dialog", { name: "Remove folder from household program" });
  await expect(confirmation.getByText("Living Room")).toBeVisible();
  await confirmation.getByRole("button", { name: "Remove Trips" }).click();
  await expect(workbench(page).getByText("No folders in the household program")).toBeVisible();
  await expect(workbench(page).getByText("Choose folders", { exact: true })).toBeVisible();
});

function workbench(page: import("@playwright/test").Page) {
  return page.getByRole("dialog", { name: "Choose source folders" });
}

async function closeWorkbench(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Close folder workbench" }).click();
  await expect(page.getByRole("dialog", { name: "Choose source folders" })).toBeHidden();
}

async function refreshAndOpenWorkbench(page: import("@playwright/test").Page) {
  await page.locator(".admin-topbar").getByRole("button").last().click();
  await expect(page.locator(".truth-reel").first()).toHaveAttribute("data-index-state", /indexing|quota-exhausted/);
  await page.getByRole("button", { name: "Browse & choose folders" }).click();
  await expect(page.getByRole("dialog", { name: "Choose source folders" })).toBeVisible();
}
