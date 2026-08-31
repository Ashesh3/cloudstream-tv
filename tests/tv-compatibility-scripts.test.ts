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

describe("TV compatibility scripts", () => {
  it("TV bundle checker enforces Chromium 108 syntax and compressed budgets", async () => {
    const source = await readFile("scripts/check-tv-bundle.mjs", "utf8");
    expect(source).toContain("180 * 1024");
    expect(source).toContain("45 * 1024");
    expect(source).toContain('const target = "chrome108"');
    expect(source).toContain("index-");
    expect(source).not.toContain("polyfills-legacy");
    expect(source).not.toContain("index-legacy");
    expect(source).toContain("@scope");
    expect(source).toContain("light-dark");
    expect(source).toContain("anchor-name");
    expect(source).toContain("position-anchor");
    expect(source).toContain(":popover-open");
    expect(source).not.toContain("const unsupportedCss");
    expect(source).toContain("cloudframe-media-sw.js contains syntax newer than Chromium 68");
    const build = await runCommand("npm", ["run", "build", "-w", "@cloudframe/tv"], {});
    expect(build.code, build.stderr).toBe(0);
    const result = await runNode("scripts/check-tv-bundle.mjs", [], {});
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("TV bundle compatibility and budget check passed");
  }, 120_000);

  it("defines a pinned Chromium 108 execution lane and required API check", async () => {
    const source = await readFile("scripts/check-chromium108.mjs", "utf8");
    expect(source).toContain("Chrome/108.");
    expect(source).toMatch(/const revision = "\d+"/);
    expect(source).toMatch(/const archiveSha256 = "[a-f0-9]{64}"/);
    expect(source).toContain("AbortController");
    expect(source).toContain("remote-debugging-port");
    expect(source).toContain('toLocaleLowerCase().includes("cloudframe")');
    expect(source).not.toContain("latest");
  });

  it("keeps the Chromium probe profile in its temporary root and rejects every production probe marker", async () => {
    const harnessUrl = new URL("../scripts/chromium108-harness.mjs", import.meta.url);
    const { assertProductionWorker, createProbePaths, removeProbeRoot } = await import(harnessUrl.href);
    const root = await createProbePaths();

    expect(root.profile.startsWith(root.root)).toBe(true);
    expect(root.worker.startsWith(root.root)).toBe(true);
    expect(root.profile).not.toContain(join(".cache", "chromium-108"));
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
      .rejects.toThrow("Refusing to remove an invalid Chromium 108 temporary root");

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
    const harnessUrl = new URL("../scripts/chromium108-harness.mjs", import.meta.url);
    const { runCheckedProcess } = await import(harnessUrl.href);

    await expect(runCheckedProcess("cloudframe-command-that-does-not-exist", [], {
      stdio: "ignore",
      windowsHide: true,
    }, "archive extraction")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles a checked child process once when error and close both fire", async () => {
    const harnessUrl = new URL("../scripts/chromium108-harness.mjs", import.meta.url);
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
    const result = await runNode("scripts/check-chromium108.mjs", [], {
      CLOUDFRAME_CHROMIUM108_TEST_EXECUTABLE: join(isolatedTemp, "missing-chrome.exe"),
      CLOUDFRAME_CHROMIUM108_TEST_CACHE: join(isolatedTemp, "cache"),
      CLOUDFRAME_CHROMIUM108_TEST_SITE_PORT: String(sitePort),
      CLOUDFRAME_CHROMIUM108_TEST_MEDIA_PORT: String(mediaPort),
      CLOUDFRAME_CHROMIUM108_TEST_DEBUGGER_PORT: String(debuggerPort),
      NODE_ENV: "test",
      TEMP: isolatedTemp,
      TMP: isolatedTemp,
      TMPDIR: isolatedTemp,
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).not.toContain("Unhandled 'error' event");
    expect(result.stdout).not.toContain("started the TV app");
    expect((await readdir(isolatedTemp)).filter(name => name.startsWith("cloudframe-chromium108-")))
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
