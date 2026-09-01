import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace", () => {
  it("declares separate TV/admin apps and one self-hosted server entry", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8"));
    expect(root.workspaces).toEqual(["apps/*", "packages/*"]);
    expect(root.scripts.build).toContain("@cloudframe/tv");
    expect(root.scripts.build).toContain("@cloudframe/admin");
    expect(root.scripts["build:server"]).toContain("build-server.mjs");
    await expect(access("deploy/server-entry.ts")).resolves.toBeUndefined();
  });

  it("contains no dormant indexing or workflow package", async () => {
    for (const path of ["packages/indexer", "workflows", "src", "next.config.ts"]) {
      await expect(access(path), path).rejects.toMatchObject({ code: "ENOENT" });
    }
    const lock = await readFile("package-lock.json", "utf8");
    expect(lock).not.toMatch(/@cloudframe\/indexer|@workflow\/builders|@google-cloud\/firestore/);
  });

  it("keeps direct Google playback for compatible media and HLS for incompatible media", async () => {
    const direct = await readFile("packages/server/src/services/direct-media.ts", "utf8");
    const tv = await readFile("apps/tv/src/components/viewer.tsx", "utf8");
    expect(direct).toContain('transport: "google-bearer"');
    expect(direct).toContain('transport: "hls"');
    expect(direct).toContain("isLegacyMpeg");
    expect(tv).toContain('sourceKind === "hls"');
    expect(tv).toContain('fallback: "hls"');
  });
});
