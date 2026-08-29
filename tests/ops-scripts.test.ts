import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
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
  it("documents dry-run-first migration and one-document recovery after cutover", async () => {
    const operations = await readFile("docs/operations/firebase-vercel-setup.md", "utf8");
    const environment = await readFile(".env.example", "utf8");

    expect(operations).toContain("node --experimental-strip-types scripts/migrate-vercel-control-plane.ts");
    expect(operations).toContain("node --experimental-strip-types scripts/restore-vercel-control-plane.ts");
    expect(operations).toContain("controlPlaneBackups/{householdId}");
    expect(operations).toContain("reads exactly one recovery document");
    expect(operations).not.toMatch(/ENABLE_LEGACY_SESSION_EXCHANGE|GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL/);
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

  it("TV bundle checker enforces legacy syntax and compressed budgets", async () => {
    const source = await readFile("scripts/check-tv-bundle.mjs", "utf8");
    expect(source).toContain("180 * 1024");
    expect(source).toContain("45 * 1024");
    expect(source).toContain("polyfills-legacy");
    expect(source).toContain("index-legacy");
    expect(source).toContain("files.filter(name => /-legacy-.*\\.js$/.test(name))");
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

  it("keeps the Chromium probe profile in its temporary root and rejects every production probe marker", async () => {
    const harnessUrl = new URL("../scripts/chromium68-harness.mjs", import.meta.url);
    const { assertProductionWorker, createProbePaths, removeProbeRoot } = await import(harnessUrl.href);
    const root = await createProbePaths();

    expect(root.profile.startsWith(root.root)).toBe(true);
    expect(root.worker.startsWith(root.root)).toBe(true);
    expect(root.profile).not.toContain(join(".cache", "chromium-68"));
    await mkdir(root.profile, { recursive: true });
    await writeFile(join(root.profile, "worker-origin.txt"), "http://127.0.0.1:4173/sample.wav");
    await removeProbeRoot(root.root);
    await expect(access(root.root)).rejects.toMatchObject({ code: "ENOENT" });

    const failed = await createProbePaths();
    let failure: Error | null = null;
    try {
      await mkdir(failed.profile, { recursive: true });
      throw new Error("simulated Chromium failure");
    } catch (error) {
      failure = error as Error;
    } finally {
      await removeProbeRoot(failed.root);
    }
    expect(failure?.message).toBe("simulated Chromium failure");
    await expect(access(failed.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(removeProbeRoot(tmpdir()))
      .rejects.toThrow("Refusing to remove an invalid Chromium 68 temporary root");

    expect(() => assertProductionWorker("self.addEventListener('fetch',()=>{});"))
      .not.toThrow();
    for (const marker of [
      "http://127.0.0.1:4173",
      "http://localhost:4173",
      "/sample.wav",
      "__CLOUDFRAME_MEDIA_PROBE_ORIGIN__",
    ]) {
      expect(() => assertProductionWorker(marker), marker)
        .toThrow("Production media worker contains probe configuration");
    }
  });

  it("rejects child-process spawn errors without an unhandled EventEmitter crash", async () => {
    const harnessUrl = new URL("../scripts/chromium68-harness.mjs", import.meta.url);
    const { runCheckedProcess } = await import(harnessUrl.href);

    await expect(runCheckedProcess("cloudframe-command-that-does-not-exist", [], {
      stdio: "ignore",
      windowsHide: true,
    }, "archive extraction")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles a checked child process once when error and close both fire", async () => {
    const harnessUrl = new URL("../scripts/chromium68-harness.mjs", import.meta.url);
    const { observeCheckedChild } = await import(harnessUrl.href);
    const child = new EventTargetChild();
    const checked = observeCheckedChild(child, "synthetic-process");
    const failure = Object.assign(new Error("spawn blocked"), { code: "EACCES" });

    child.emit("error", failure);
    child.emit("close", null, null);

    await expect(checked.started).rejects.toBe(failure);
    await expect(checked.completed).rejects.toBe(failure);
  });

  it("cleans the actual Chromium harness after a controlled launch failure", async () => {
    const isolatedTemp = await temp();
    const [sitePort, mediaPort, debuggerPort] = await reservePorts(3);
    const result = await runNode("scripts/check-chromium68.mjs", [], {
      CLOUDFRAME_CHROMIUM68_TEST_EXECUTABLE: join(isolatedTemp, "missing-chrome.exe"),
      CLOUDFRAME_CHROMIUM68_TEST_CACHE: join(isolatedTemp, "cache"),
      CLOUDFRAME_CHROMIUM68_TEST_SITE_PORT: String(sitePort),
      CLOUDFRAME_CHROMIUM68_TEST_MEDIA_PORT: String(mediaPort),
      CLOUDFRAME_CHROMIUM68_TEST_DEBUGGER_PORT: String(debuggerPort),
      NODE_ENV: "test",
      TEMP: isolatedTemp,
      TMP: isolatedTemp,
      TMPDIR: isolatedTemp,
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).not.toContain("Unhandled 'error' event");
    expect(result.stdout).not.toContain("loaded authenticated Range media");
    expect((await readdir(isolatedTemp)).filter(name => name.startsWith("cloudframe-chromium68-")))
      .toEqual([]);
    for (const port of [sitePort, mediaPort, debuggerPort]) {
      await expect(canListen(port)).resolves.toBeUndefined();
    }
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

async function reservePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    await Promise.all(servers.map(server => new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    })));
    return servers.map(server => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test port allocation failed");
      return address.port;
    });
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolvePromise => {
      if (!server.listening) resolvePromise();
      else server.close(() => resolvePromise());
    })));
  }
}

async function canListen(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.close(error => error ? reject(error) : resolvePromise());
  });
}

class EventTargetChild {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  once(name: string, listener: (...args: unknown[]) => void): this {
    const onceListener = (...args: unknown[]) => {
      this.removeListener(name, onceListener);
      listener(...args);
    };
    const entries = this.listeners.get(name) ?? new Set();
    entries.add(onceListener);
    this.listeners.set(name, entries);
    return this;
  }

  removeListener(name: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(name)?.delete(listener);
    return this;
  }

  emit(name: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(...args);
  }
}
