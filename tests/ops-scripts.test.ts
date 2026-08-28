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
  it("documents dry-run-first migration, one-document recovery, and bounded legacy exchange", async () => {
    const operations = await readFile("docs/operations/firebase-vercel-setup.md", "utf8");
    const environment = await readFile(".env.example", "utf8");

    expect(operations).toContain("node --experimental-strip-types scripts/migrate-vercel-control-plane.ts");
    expect(operations).toContain("node --experimental-strip-types scripts/restore-vercel-control-plane.ts");
    expect(operations).toContain("controlPlaneBackups/{householdId}");
    expect(operations).toContain("reads exactly one recovery document");
    expect(operations).toContain("ENABLE_LEGACY_SESSION_EXCHANGE=1");
    expect(operations).toContain("zero steady-state Firestore reads");
    expect(operations.toLowerCase()).toContain("no legacy firestore document or google cloud/firebase project is deleted");

    for (const key of ["CONTROL_PLANE_KEY", "SESSION_KEY", "BROWSE_HANDLE_KEY", "PROVIDER_TOKEN_KEY"]) {
      expect(environment).toContain(`${key}_VERSION=v1`);
      expect(environment).toContain(`${key}_V1=`);
    }
    expect(environment).toContain("ROOT_ID_SECRET=");
    expect(environment).toContain("GCP_OPERATOR_SERVICE_ACCOUNT_EMAIL=");
    expect(environment).toContain("GCP_OPERATOR_CREDENTIALS_FILE=");
  });

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

  it("declares the live Vercel Blob reader used outside fixture mode", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8"));
    expect(root.dependencies["@vercel/blob"]).toBe("2.8.0");
    await expect(import("@vercel/blob")).resolves.toHaveProperty("list");
  });

  it("control-plane migration and restore scripts are dry-run first and secret-safe", async () => {
    for (const file of [
      "scripts/migrate-vercel-control-plane.ts",
      "scripts/restore-vercel-control-plane.ts"
    ]) {
      const source = await readFile(file, "utf8");
      expect(source).toContain('args.includes("--apply")');
      expect(source).toContain("--fixture");
      expect(source).toContain("JSON.stringify(result)");
      expect(source).not.toMatch(/console\.(log|dir)|JSON\.stringify\((document|envelope|recovery)/);
    }
  });

  it("runs control-plane fixture dry runs with exact redacted output", async () => {
    const directory = await temp();
    const migrationFixture = join(directory, "migration.json");
    const recoveryFixture = join(directory, "recovery.json");
    const secret = "fixture-request-secret-hash";
    await writeFile(migrationFixture, JSON.stringify({
      households: [{
        id: "h1",
        createdAt: "2026-08-27T08:00:00.000Z",
        allowNewDeviceRequests: true,
        defaultMediaOrder: "captured-desc",
        defaultSlideshowSeconds: 8,
        adminPassphraseHash: "argon2-test-hash",
        adminPassphraseVersion: 1
      }],
      deviceRequests: [{
        id: "request-1", householdId: "h1", requestSecretHash: secret,
        requestedName: "Bedroom", status: "pending",
        createdAt: "2026-08-27T08:00:00.000Z",
        expiresAt: "2099-08-27T08:00:00.000Z",
        resolvedAt: null, approvedDeviceId: null
      }],
      devices: [], sources: [], roots: []
    }));
    await writeFile(recoveryFixture, JSON.stringify({
      schemaVersion: 2,
      householdId: "h1",
      revision: 1,
      updatedAt: "2026-08-27T08:00:00.000Z",
      household: {
        adminPassphraseHash: "argon2-test-hash",
        adminPassphraseVersion: 1,
        allowNewDeviceRequests: true,
        defaultMediaOrder: "captured-desc",
        defaultSlideshowSeconds: 8
      },
      devices: {}, pendingDeviceRequests: {}, sources: {}, roots: {}
    }));
    const environment = {
      HOUSEHOLD_ID: "h1",
      CONTROL_PLANE_ENV: "preview",
      PROVIDER_TOKEN_KEY_VERSION: "v1",
      PROVIDER_TOKEN_KEY_V1: Buffer.alloc(32, 7).toString("base64url"),
      CONTROL_PLANE_KEY_VERSION: "",
      CONTROL_PLANE_KEY_V1: "",
      BLOB_STORE_ID: ""
    };

    const migration = await runNodeWithStripTypes(
      "scripts/migrate-vercel-control-plane.ts",
      ["--fixture", migrationFixture],
      environment
    );
    const restore = await runNodeWithStripTypes(
      "scripts/restore-vercel-control-plane.ts",
      ["--fixture", recoveryFixture],
      environment
    );

    for (const execution of [migration, restore]) {
      expect(execution.code, execution.stderr).toBe(0);
      const output = JSON.parse(execution.stdout) as Record<string, unknown>;
      expect(Object.keys(output)).toEqual(["apply", "householdId", "revision", "counts", "checksum"]);
      expect(execution.stdout).not.toContain(secret);
      expect(execution.stdout).not.toMatch(/token|hash|provider|ciphertext|secret/i);
    }
    expect(migration.stderr).toBe("");
    const restoreEvents = restore.stderr.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    expect(restoreEvents).toEqual([{
      level: "info",
      event: "control_plane_restore_read",
      requestId: "restore-cli",
      householdId: "h1",
      count: 1
    }]);
    expect(restore.stderr).not.toMatch(/ciphertext|token|hash|providerNodeId|secret/i);
  });

  it("normalizes every control-plane CLI failure without leaking its cause", async () => {
    const directory = await temp();
    const fixture = join(directory, "hostile-secret-path.json");
    const hostile = "tokenHash=abc providerNodeId=root ciphertext=xyz super-secret";
    await writeFile(fixture, `{${hostile}`);
    const result = await runNodeWithStripTypes(
      "scripts/migrate-vercel-control-plane.ts",
      ["--fixture", fixture],
      { HOUSEHOLD_ID: "h1", CONTROL_PLANE_ENV: "preview" }
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("CONTROL_PLANE_OPERATION_FAILED");
    expect(result.stderr).not.toContain(hostile);
    expect(result.stderr).not.toContain(fixture);
    expect(result.stderr).not.toContain("SyntaxError");
  });

  it("requires explicit operator identity/config and Blob store for non-fixture apply", async () => {
    for (const file of [
      "scripts/migrate-vercel-control-plane.ts",
      "scripts/restore-vercel-control-plane.ts"
    ]) {
      const source = await readFile(file, "utf8");
      expect(source).toContain("GCP_OPERATOR_SERVICE_ACCOUNT_EMAIL");
      expect(source).toContain("GCP_OPERATOR_CREDENTIALS_FILE");
      expect(source).toContain('required("BLOB_STORE_ID")');
      expect(source).toContain("loadOperatorCredentials");
    }
  });

  it("isolates the legacy reader to the temporary exchange boundary", async () => {
    const serverFiles = await listTypeScriptFiles("packages/server/src");
    const importers: string[] = [];
    for (const file of serverFiles) {
      const source = await readFile(file, "utf8");
      if (source.includes("legacy-session-exchange")) importers.push(file.replaceAll("\\", "/"));
    }
    expect(importers).toEqual([
      "packages/server/src/http/control-app.ts",
      "packages/server/src/index.ts"
    ]);
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
    expect(source).toContain('toLocaleLowerCase().includes("cloudframe")');
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

async function runNodeWithStripTypes(file: string, args: string[], env: Record<string, string>) {
  try {
    const result = await exec(process.execPath, ["--experimental-strip-types", file, ...args], {
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

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? listTypeScriptFiles(path)
      : Promise.resolve(path.endsWith(".ts") ? [path] : []);
  }));
  return nested.flat().sort();
}
