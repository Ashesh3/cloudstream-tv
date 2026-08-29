import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStaticApp } from "@cloudframe/server";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function publicTree() {
  const root = await mkdtemp(join(tmpdir(), "cloudframe-public-"));
  directories.push(root);
  await mkdir(join(root, "admin"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "tv-spa");
  await writeFile(join(root, "admin", "index.html"), "admin-spa");
  await writeFile(join(root, "assets", "app-abc123.js"), "asset-body");
  return { app: createStaticApp({ publicRoot: root }), root };
}

describe("self-hosted static app", () => {
  it.each([
    ["/", "tv-spa"],
    ["/folder/deep-link", "tv-spa"],
    ["/admin/", "admin-spa"],
    ["/admin/settings", "admin-spa"],
  ])("serves the correct SPA fallback for %s", async (path, expected) => {
    const { app } = await publicTree();
    const response = await app(new Request("https://app.test/static-probe", {
      headers: { "x-cloudframe-request-target": path },
    }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-cache");
    await expect(response?.text()).resolves.toBe(expected);
  });

  it("streams a hashed asset with immutable caching", async () => {
    const { app } = await publicTree();
    const response = await app(new Request("https://app.test/assets/app-abc123.js"));
    expect(response?.headers.get("content-type")).toContain("text/javascript");
    expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    await expect(response?.text()).resolves.toBe("asset-body");
  });

  it.each([
    "/../secret",
    "/%2e%2e/secret",
    "/%252e%252e/secret",
    "/admin\\secret",
    "/a/./b",
  ])("rejects traversal-shaped path %s without serving outside the public root", async (path) => {
    const { app } = await publicTree();
    const response = await app(new Request("https://app.test/static-probe", {
      headers: { "x-cloudframe-request-target": path },
    }));
    expect([400, 404]).toContain(response?.status);
  });

  it("rejects unsupported methods", async () => {
    const { app } = await publicTree();
    const response = await app(new Request("https://app.test/", { method: "POST" }));
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("GET, HEAD");
  });
});
