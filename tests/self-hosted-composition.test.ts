import { access, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSelfHostedComposition,
  parseSelfHostedConfig,
  type ProcessRunner,
} from "@cloudframe/server";
import {
  ProviderError,
  createProviderRegistry,
  type ProviderAdapter,
} from "@cloudframe/providers";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

const adapter = {} as ProviderAdapter;
const healthyRunner: ProcessRunner = {
  run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderrTail: "" })),
};

describe("self-hosted composition", () => {
  it("allows optional providers and fails safely for an omitted provider", () => {
    const registry = createProviderRegistry({ google: adapter });
    expect(registry.get("google")).toBe(adapter);
    expect(() => registry.get("onedrive")).toThrowError(expect.objectContaining({
      code: "PROVIDER_NOT_CONFIGURED",
      retryable: false,
    } satisfies Partial<ProviderError>));
  });

  it("boots against an empty local data directory without reading retired cloud variables", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cloudframe-composition-"));
    directories.push(dataDir);
    const publicRoot = join(dataDir, "public");
    await mkdir(join(publicRoot, "admin"), { recursive: true });
    await writeFile(join(publicRoot, "index.html"), "tv");
    await writeFile(join(publicRoot, "admin", "index.html"), "admin");
    const logger = vi.fn();
    const environment = new Proxy({
      APP_ORIGIN: "https://tv.example.com",
      DATA_DIR: dataDir,
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
    } as NodeJS.ProcessEnv, {
      get(target, property) {
        if (typeof property === "string" && /GCP|FIRESTORE|BLOB/.test(property)) {
          throw new Error(`retired environment read: ${property}`);
        }
        return Reflect.get(target, property);
      },
    });
    const config = parseSelfHostedConfig(environment);
    const composition = await createSelfHostedComposition(config, {
      publicRoot,
      providerAdapters: { google: adapter },
      log: logger,
      now: () => new Date("2026-08-29T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 4),
      processRunner: healthyRunner,
    });
    try {
      const response = await composition.app(new Request("https://tv.example.com/api/setup/status"));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, data: { state: "unconfigured" } });
      expect(logger).toHaveBeenCalledWith(expect.stringMatching(/^CLOUDFRAME_SETUP_CODE=/));
      expect(composition.readiness.snapshot()).toMatchObject({ ready: true });
    } finally {
      await composition.close();
    }
  });

  it("does not become ready when FFmpeg or FFprobe is unavailable", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cloudframe-composition-tools-"));
    directories.push(dataDir);
    const publicRoot = join(dataDir, "public");
    await mkdir(join(publicRoot, "admin"), { recursive: true });
    await writeFile(join(publicRoot, "index.html"), "tv");
    await writeFile(join(publicRoot, "admin", "index.html"), "admin");
    const runner: ProcessRunner = {
      run: vi.fn(async command => ({ exitCode: command === "ffprobe" ? 1 : 0, signal: null, stdout: Buffer.alloc(0), stderrTail: "" })),
    };

    await expect(createSelfHostedComposition(parseSelfHostedConfig({
      APP_ORIGIN: "https://tv.example.com",
      DATA_DIR: dataDir,
    }), { publicRoot, providerAdapters: {}, processRunner: runner, log: vi.fn() }))
      .rejects.toThrow("FFPROBE_UNAVAILABLE");
  });

  it("declares the production server build and start commands", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts["build:server"]).toBe("npm run build && node scripts/build-server.mjs");
    expect(root.scripts.start).toBe("node build/self-hosted/server/index.js");
    await expect(access("scripts/build-server.mjs")).resolves.toBeUndefined();
  });
});
