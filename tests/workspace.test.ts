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
    expect(contract.routes[1]).toEqual({ handle: "filesystem" });
    expect(contract.routes).toContainEqual({ src: "^/api(?:/.*)?$", dest: "/api" });
    const spa = contract.routes.find((route: { dest?: string }) => route.dest === "/index.html");
    expect(spa.src).toContain("?!api");
    expect(spa.src).not.toContain("workflow");
  });

  it("removes the Vercel Google media relay composition", async () => {
    const readme = await readFile("README.md", "utf8");
    const product = await readFile("PRODUCT.md", "utf8");
    const server = await readFile("packages/server/src/http/control-app.ts", "utf8");
    const composition = await readFile("deploy/api-entry.ts", "utf8");

    expect(server).not.toContain("/api/tv/google-media/:handle");
    expect(server).not.toContain('"media-stream"');
    expect(composition).not.toContain("createMediaHandleCodec");
    await expect(access("packages/server/src/auth/media-handles.ts"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(`${readme}\n${product}`).toContain("server-only");
    expect(`${readme}\n${product}`).toContain("media bytes go directly from Google and Microsoft");
    expect(`${readme}\n${product}`).toContain("short-lived Google access token");
    expect(`${readme}\n${product}`).not.toContain("Google media is streamed through");
    expect(`${readme}\n${product}`).not.toMatch(/access token in the (?:media )?URL|access token in the query string/i);
  });

  it("keeps the approved direct Google TV media design in the repository", async () => {
    const spec = await readFile(
      "docs/superpowers/specs/2026-08-29-direct-google-tv-media-design.md",
      "utf8",
    );

    expect(spec).toContain("directly from Google to the LG webOS television");
    expect(spec).toContain("service worker");
    expect(spec).toContain("MOV00516.MPG");
    expect(spec).toContain("alt=media&access_token=...");
    expect(spec).toContain("not a viable fallback");
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
