import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("operations scripts", () => {
  it("seed-dev refuses missing or weak passphrases before writing", async () => {
    const missing = await runNode("scripts/seed-dev.mjs", [], { ADMIN_INITIAL_PASSPHRASE: "" });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("at least 16 characters");

    const weak = await runNode("scripts/seed-dev.mjs", ["--dry-run"], {
      ADMIN_INITIAL_PASSPHRASE: "passwordpassword"
    });
    expect(weak.code).not.toBe(0);
    expect(weak.stderr).toContain("common or repeated");
  });

  it("seed-dev dry run is secret-safe and produces an idempotent household plan", async () => {
    const passphrase = "test-only long household passphrase";
    const result = await runNode("scripts/seed-dev.mjs", ["--dry-run"], {
      ADMIN_INITIAL_PASSPHRASE: passphrase,
      ADMIN_PASSPHRASE_PEPPER: "test-only-pepper",
      HOUSEHOLD_ID: "household-test"
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"operation":"create-if-absent"');
    expect(result.stdout).not.toContain(passphrase);
    expect(result.stdout).not.toContain("test-only-pepper");
  });

  it("migration is dry-run by default, honors tombstones and split-token precedence", async () => {
    const directory = await temp();
    const fixture = join(directory, "legacy.json");
    const secret = "split-refresh-secret";
    await writeFile(fixture, JSON.stringify({
      sessions: {
        "session-a": {
          aggregate: [{
            id: "google-1", provider: "google", email: "family@example.test",
            refreshToken: "aggregate-refresh", accessToken: "aggregate-access",
            tokenExpiry: 0, folders: [{ id: "root", name: "Photos" }]
          }, {
            id: "deleted", provider: "onedrive", email: "deleted@example.test",
            refreshToken: "deleted-secret", accessToken: "deleted-access",
            tokenExpiry: 0, folders: []
          }],
          split: {
            "google-1": {
              metadata: { id: "google-1", provider: "google", email: "family@example.test", folders: [{ id: "root", name: "Photos" }], createdAt: 1 },
              tokens: { refreshToken: secret, accessToken: "split-access", tokenExpiry: 2 }
            }
          },
          tombstones: { deleted: { deletedAt: 3 } }
        }
      }
    }));

    const result = await runNode("scripts/migrate-vercel-blob.mjs", ["--fixture", fixture], {
      PROVIDER_TOKEN_KEY_VERSION: "v1",
      PROVIDER_TOKEN_KEY_V1: Buffer.alloc(32, 7).toString("base64url"),
      HOUSEHOLD_ID: "household-test"
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"apply":false');
    expect(result.stdout).toContain('"sourceCount":1');
    expect(result.stdout).toContain('"status":"reauth-required"');
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain("aggregate-refresh");
    expect(result.stdout).not.toContain("deleted-secret");
  });

  it("migration requires explicit --apply and refuses to invent provider account ids", async () => {
    const source = await readFile("scripts/migrate-vercel-blob.mjs", "utf8");
    expect(source).toContain("--apply");
    expect(source).toContain("providerAccountId: null");
    expect(source).not.toMatch(/providerAccountId:\s*(connection\.)?email/);
    expect(source).not.toMatch(/localStorage|sessionStorage/);
  });

  it("declares the live Vercel Blob reader used outside fixture mode", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8"));
    expect(root.dependencies["@vercel/blob"]).toBe("2.8.0");
    await expect(import("@vercel/blob")).resolves.toHaveProperty("list");
  });

  it("TV bundle checker enforces legacy syntax and compressed budgets", async () => {
    const source = await readFile("scripts/check-tv-bundle.mjs", "utf8");
    expect(source).toContain("180 * 1024");
    expect(source).toContain("45 * 1024");
    expect(source).toContain("polyfills-legacy");
    expect(source).toContain("index-legacy");
    const { access } = await import("node:fs/promises");
    try {
      await access("apps/tv/dist/assets");
    } catch {
      const build = await runCommand("npm", ["run", "build", "-w", "@cloudframe/tv"], {});
      expect(build.code, build.stderr).toBe(0);
    }
    const result = await runNode("scripts/check-tv-bundle.mjs", [], {});
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("TV bundle compatibility and budget check passed");
  });

  it("defines a pinned Chromium 68 execution lane and required API check", async () => {
    const source = await readFile("scripts/check-chromium68.mjs", "utf8");
    expect(source).toContain("555668");
    expect(source).toContain("Chrome/68.");
    expect(source).toContain("AbortController");
    expect(source).toContain("remote-debugging-port");
    expect(source).not.toContain("latest");
  });
});

async function temp() {
  const directory = await mkdtemp(join(tmpdir(), "cloudframe-ops-"));
  directories.push(directory);
  return directory;
}

async function runNode(file: string, args: string[], env: Record<string, string>) {
  try {
    const result = await exec(process.execPath, [file, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024
    });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function runCommand(command: string, args: string[], env: Record<string, string>) {
  const executable = process.platform === "win32"
    ? process.execPath
    : command;
  const npmCli = process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : null;
  const actualArgs = npmCli ? [npmCli, ...args] : args;
  try {
    const result = await exec(executable, actualArgs, { cwd: process.cwd(), env: { ...process.env, ...env }, maxBuffer: 20 * 1024 * 1024 });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}
