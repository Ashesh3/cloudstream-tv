import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function matchesVercelPath(source: string, path: string): boolean {
  if (!source.includes(":")) {
    return new RegExp(`^${source}$`).test(path);
  }

  const segments = source.split(":path*");
  const escaped = segments.map((segment) =>
    segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );

  return new RegExp(`^${escaped.join(".*")}$`).test(path);
}

describe("workspace", () => {
  it("declares separate TV and admin applications", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8"));
    expect(root.workspaces).toEqual(["apps/*", "packages/*"]);
    expect(root.scripts.build).toContain("build-site.mjs");
  });

  it("leaves API requests for Vercel functions instead of the TV SPA fallback", async () => {
    const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
    const apiPath = "/api/internal/sync-due-sources";
    const rewrite = vercel.rewrites.find((rule: { source: string }) =>
      matchesVercelPath(rule.source, apiPath)
    );

    expect(rewrite).toBeUndefined();
  });
});
