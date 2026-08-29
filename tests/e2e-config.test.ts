import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const TEST_HOOKS = /__CLOUDFRAME_TEST_(?:TV|ADMIN)_API__/;

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

  it("omits test hooks and public sourcemaps from the ordinary self-hosted public output", async () => {
    const npmCli = process.platform === "win32"
      ? process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
      : "npm";
    await exec(process.platform === "win32" ? process.execPath : npmCli, process.platform === "win32"
      ? [npmCli, "run", "build:e2e"]
      : ["run", "build:e2e"], { cwd: process.cwd(), env: process.env, maxBuffer: 20 * 1024 * 1024 });
    expect((await filesUnder("apps/tv/dist")).some(path => path.endsWith(".map"))).toBe(true);

    await exec(process.platform === "win32" ? process.execPath : npmCli, process.platform === "win32"
      ? [npmCli, "run", "build:server"]
      : ["run", "build:server"], {
      cwd: process.cwd(), env: process.env, maxBuffer: 30 * 1024 * 1024
    });

    for (const root of ["apps/tv/dist", "apps/admin/dist", "build/self-hosted/public"]) {
      const files = await filesUnder(root);
      expect(files.some(path => path.endsWith(".map")), root).toBe(false);
      for (const path of files) {
        const content = await readFile(path);
        expect(content.toString("utf8"), path).not.toMatch(TEST_HOOKS);
      }
    }
  }, 120_000);

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

  it("covers enrollment, browse/viewer, reassignment, revocation, and admin responsive acceptance", async () => {
    const enrollment = await readFile("e2e/enrollment.spec.ts", "utf8");
    const browse = await readFile("e2e/browse-viewer.spec.ts", "utf8");
    expect(enrollment).toMatch(/request.*approve.*ready.*revoke/is);
    const shared = await readFile("e2e/shared-api.spec.ts", "utf8");
    expect(shared).toMatch(/device_request.*device_session.*assignedRootIds.*revok/is);
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

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter(entry => entry.isFile()).map(entry => `${entry.parentPath}/${entry.name}`);
}
