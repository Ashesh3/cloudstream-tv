import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("browser acceptance harness", () => {
  it("keeps synthetic API injection out of ordinary production builds", async () => {
    const tv = await readFile("apps/tv/vite.config.ts", "utf8");
    const admin = await readFile("apps/admin/vite.config.ts", "utf8");
    expect(tv).toContain('CLOUDFRAME_E2E_BUILD === "1"');
    expect(admin).toContain('CLOUDFRAME_E2E_BUILD === "1"');
    expect(tv).toContain("__CLOUDFRAME_E2E__");
    expect(admin).toContain("__CLOUDFRAME_E2E__");
    const siteBuild = await readFile("scripts/build-site.mjs", "utf8");
    expect(siteBuild).toContain('process.env.CLOUDFRAME_E2E_BUILD === "1"');
  });

  it("defines TV and admin screenshot projects", async () => {
    const source = await readFile("playwright.config.ts", "utf8");
    expect(source).toContain('name: "tv-1920"');
    expect(source).toContain('name: "admin-mobile"');
    expect(source).toContain('name: "admin-wide"');
    expect(source).toContain('CLOUDFRAME_E2E_BUILD: "1"');
  });

  it("runs the source workbench journey in both responsive admin projects", async () => {
    const source = await readFile("playwright.config.ts", "utf8");
    const adminProjects = source.split('name: "admin-').slice(1);
    expect(adminProjects).toHaveLength(2);
    expect(adminProjects.every(project => /source-workbench/.test(project))).toBe(true);
  });

  it("covers enrollment, browse/viewer, reassign, revoke, and admin responsive acceptance", async () => {
    const enrollment = await readFile("e2e/enrollment.spec.ts", "utf8");
    const browse = await readFile("e2e/browse-viewer.spec.ts", "utf8");
    expect(enrollment).toMatch(/request.*approve.*cookie.*reassign.*revoke/is);
    expect(browse).toMatch(/folder.*image.*video.*viewer/is);
    const viewer = await readFile("apps/tv/src/components/viewer.tsx", "utf8");
    expect(viewer).toContain("history.save");
    expect(viewer).toContain("saveElementHistory(active.id");
    expect(`${enrollment}\n${browse}`).toContain("toHaveScreenshot");
  });

  it("includes a shared final control API acceptance journey", async () => {
    const source = await readFile("e2e/shared-api.spec.ts", "utf8");
    expect(source).toContain("createControlApiHarness");
    expect(source).toMatch(/device_request.*device_session/is);
    expect(source).toContain("/approve");
    expect(source).toContain("/api/tv/home");
    expect(source).toContain("assignedRootIds");
    expect(source).toMatch(/"DELETE"/);
  });

  it("covers live nested folders, responsive composition, and removal impact", async () => {
    const source = await readFile("e2e/source-workbench.spec.ts", "utf8");
    expect(source).toMatch(/My Drive[\s\S]*Photos[\s\S]*Trips/);
    expect(source).not.toMatch(/queued[\s\S]*indexing|quota-exhausted/i);
    expect(source).toMatch(/admin-mobile[\s\S]*boundingBox/);
    expect(source).toMatch(/removal impact[\s\S]*Remove Trips/i);
  });
});
