import { access, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("self-hosted deployment configuration", () => {
  it("documents only the portable local runtime contract", async () => {
    const content = await readFile(".env.example", "utf8");
    for (const name of ["APP_ORIGIN", "PORT", "DATA_DIR", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ONEDRIVE_CLIENT_ID", "ONEDRIVE_CLIENT_SECRET", "ONEDRIVE_TENANT", "TRANSCODE_CACHE_MAX_BYTES", "TRANSCODE_CACHE_MIN_FREE_BYTES", "TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS", "TRANSCODE_THREADS", "LOG_LEVEL"]) expect(content).toContain(`${name}=`);
    expect(content).not.toMatch(/FIRESTORE|VERCEL|BLOB_STORE|WORKLOAD_IDENTITY|ADMIN_INITIAL_PASSPHRASE|CONTROL_PLANE_KEY|SESSION_KEY|BROWSE_HANDLE_KEY|PROVIDER_TOKEN_KEY/);
  });

  it("provides one bundled self-hosted server and static public tree", async () => {
    const npmCli = process.platform === "win32" ? process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : "npm";
    await exec(process.platform === "win32" ? process.execPath : npmCli, process.platform === "win32" ? [npmCli, "run", "build:server"] : ["run", "build:server"], { cwd: process.cwd(), env: process.env, maxBuffer: 30 * 1024 * 1024 });
    await Promise.all([access("build/self-hosted/public/index.html"), access("build/self-hosted/public/admin/index.html"), access("build/self-hosted/server/index.js")]);
    const serverFiles = (await readdir("build/self-hosted/server", { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
    expect(serverFiles.map(entry => entry.name)).toEqual(["index.js"]);
    expect(await access("build/self-hosted/test-fixtures").then(() => true, () => false)).toBe(false);
    const server = await readFile("build/self-hosted/server/index.js", "utf8");
    expect(server).not.toContain("/api/admin/test-fixture");
    expect(server).not.toContain("__CLOUDFRAME_CONTAINER_TEST__");
    expect(server).not.toContain("fixture-legacy-mpeg");
  }, 120_000);

  it("declares Docker build and smoke commands", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(root.scripts["docker:build"]).toBe("docker build --platform linux/amd64 -t cloudframe:local .");
    expect(root.scripts["test:container"]).toBe("node scripts/container-smoke.mjs");
    await Promise.all([access("Dockerfile"), access("compose.example.yaml"), access("scripts/container-smoke.mjs")]);
  });
});
