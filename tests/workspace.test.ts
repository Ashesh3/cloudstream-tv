import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace", () => {
  it("declares separate TV and admin applications", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8"));
    expect(root.workspaces).toEqual(["apps/*", "packages/*"]);
    expect(root.scripts.build).toContain("build-site.mjs");
  });

  it("leaves API requests for Vercel functions instead of the TV SPA fallback", async () => {
    const contract = JSON.parse(await readFile("deploy/vercel-build-contract.json", "utf8"));
    expect(contract.routes[0]).toEqual({ handle: "filesystem" });
    expect(contract.routes).toContainEqual({ src: "^/api(?:/.*)?$", dest: "/api" });
    const spa = contract.routes.find((route: { dest?: string }) => route.dest === "/index.html");
    expect(spa.src).toContain("?!api");
  });
});
