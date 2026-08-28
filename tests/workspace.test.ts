import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace", () => {
  it("declares separate TV and admin applications", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8"));
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    expect(root.workspaces).toEqual(["apps/*", "packages/*"]);
    expect(root.scripts.build).toContain("build-site.mjs");
    for (const name of ["@cloudframe/indexer", "workflow", "@workflow/builders"]) {
      expect(root.dependencies).not.toHaveProperty(name);
      expect(root.devDependencies).not.toHaveProperty(name);
      expect(JSON.stringify(lock)).not.toContain(`"${name}"`);
    }
    expect(lock.packages).not.toHaveProperty("packages/indexer");
  });

  it("leaves API requests for Vercel functions instead of the TV SPA fallback", async () => {
    const contract = JSON.parse(await readFile("deploy/vercel-build-contract.json", "utf8"));
    expect(contract.routes[0]).toEqual({ handle: "filesystem" });
    expect(contract.routes).toContainEqual({ src: "^/api(?:/.*)?$", dest: "/api" });
    const spa = contract.routes.find((route: { dest?: string }) => route.dest === "/index.html");
    expect(spa.src).toContain("?!api");
    expect(spa.src).not.toContain("workflow");
  });

  it("has no dormant root application or indexing and workflow packages", async () => {
    await expect(access("src")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access("next.config.ts")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access("packages/indexer")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access("workflows")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps indexing, server history, Firestore limiting, and Workflow out of active runtime source", async () => {
    const { stdout } = await import("node:child_process").then(({ execFileSync }) => ({
      stdout: execFileSync("git", ["ls-files", "deploy", "apps", "packages"], { encoding: "utf8" })
    }));
    const files = stdout.split(/\r?\n/).filter(Boolean).filter(path =>
      /\.(?:ts|tsx|js|mjs|json)$/.test(path) &&
      !path.startsWith("apps/tv/src/state/local-watch-history.ts") &&
      !path.startsWith("packages/server/src/control-plane/legacy-session-exchange.ts")
    );
    const forbidden = /@cloudframe\/indexer|@workflow\/builders|from\s+["']workflow(?:\/|["'])|crawlCheckpoint|sync-due-sources|collection\(["'](?:watchHistory|rateLimits|nodes)["']\)/;
    for (const file of files) {
      expect(await readFile(file, "utf8"), file).not.toMatch(forbidden);
    }
  });
});
