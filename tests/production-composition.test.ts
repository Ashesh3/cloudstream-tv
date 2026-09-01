import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelfHostedComposition, parseSelfHostedConfig, type ProcessRunner, type ProviderAdapter } from "@cloudframe/server";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("self-hosted production composition", () => {
  it("uses local keys, SQLite state, configured providers, setup-code emission, and orderly close", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cloudframe-production-composition-"));
    directories.push(dataDir);
    const publicRoot = join(dataDir, "public");
    await mkdir(join(publicRoot, "admin"), { recursive: true });
    await writeFile(join(publicRoot, "index.html"), "tv");
    await writeFile(join(publicRoot, "admin", "index.html"), "admin");
    const log = vi.fn();
    const adapter = {} as ProviderAdapter;
    const processRunner: ProcessRunner = { run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderrTail: "" })) };
    const composition = await createSelfHostedComposition(parseSelfHostedConfig({
      APP_ORIGIN: "https://cloudframe.example",
      DATA_DIR: dataDir,
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
    }), { publicRoot, providerAdapters: { google: adapter }, processRunner, log, now: () => new Date("2026-08-29T12:00:00.000Z") });
    expect(composition.readiness.snapshot()).toMatchObject({ ready: true });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^CLOUDFRAME_SETUP_CODE=/u));
    expect(processRunner.run).toHaveBeenCalledTimes(2);
    await Promise.all([access(join(dataDir, "secrets", "master.key")), access(join(dataDir, "cloudframe.sqlite"))]);
    await composition.close();
    await composition.close();
    expect(composition.readiness.snapshot().draining).toBe(true);
  });

  it("builds from the direct self-hosted entry without retired platform imports", async () => {
    const entry = await readFile("deploy/server-entry.ts", "utf8");
    expect(entry).toContain("createSelfHostedComposition");
    expect(entry).toContain("createNodeRequest");
    expect(entry).not.toMatch(/Firestore|GCP_|BLOB_STORE_ID|@google-cloud/i);
    expect(entry).toContain("process.exit(0)");
    expect(entry).toContain("process.exit(1)");
  });
});
