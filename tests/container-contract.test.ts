import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { runContainerSmoke } from "../scripts/container-smoke.mjs";
import { dockerBuildArguments } from "../scripts/docker-build.mjs";

describe("portable container contract", () => {
  it("builds for the native host by default and supports an explicit platform override", () => {
    expect(dockerBuildArguments({ image: "cloudframe:local", platform: "" })).toEqual([
      "build", "-t", "cloudframe:local", ".",
    ]);
    expect(dockerBuildArguments({ image: "cloudframe:local", platform: "linux/amd64" })).toEqual([
      "build", "--platform", "linux/amd64", "-t", "cloudframe:local", ".",
    ]);
  });

  it("uses a pinned, unprivileged single-port Node 24 image", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    expect(dockerfile).toContain("FROM node:24.5.0-bookworm-slim AS build");
    expect(dockerfile).toContain("FROM node:24.5.0-bookworm-slim AS runtime");
    expect(dockerfile).toContain("COPY packages/theme/package.json packages/theme/package.json");
    expect(dockerfile).toContain("COPY package.json package-lock.json .npmrc ./");
    expect(dockerfile).toContain("https://packagefeedproxy.microsoft.io/npm/");
    expect(dockerfile.indexOf("RUN npm ci")).toBeLessThan(dockerfile.indexOf("COPY . ."));
    expect(dockerfile).toMatch(/RUN (?:CLOUDFRAME_CONTAINER_TEST=\$CLOUDFRAME_CONTAINER_TEST )?npm run build:server/);
    expect(dockerfile).toMatch(/apt-get install[^\n]*ffmpeg[^\n]*ca-certificates[^\n]*tini/);
    expect(dockerfile).toContain("WORKDIR /app");
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(dockerfile).toContain('CMD ["node", "server/index.js"]');
    expect(dockerfile).toMatch(/USER cloudframe/);
    expect(dockerfile).not.toMatch(/Horizon|\b\d{1,3}(?:\.\d{1,3}){3}\b|nginx|certbot|cloudflare|client_secret|COPY .*\.env/i);
  });

  it("pins build dependencies to versions available from the approved registry", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8"));
    const admin = JSON.parse(await readFile("apps/admin/package.json", "utf8"));
    const tv = JSON.parse(await readFile("apps/tv/package.json", "utf8"));
    const theme = JSON.parse(await readFile("packages/theme/package.json", "utf8"));
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));

    expect(root.devDependencies["@astryxdesign/cli"]).toBe("0.5.0");
    expect(root.overrides["@csstools/css-syntax-patches-for-csstree"]).toBe("1.1.8");
    expect(root.overrides["shaka-player"]).toBe("5.2.7");
    expect(admin.dependencies["@astryxdesign/core"]).toBe("0.5.0");
    expect(admin.dependencies["@astryxdesign/theme-neutral"]).toBe("0.5.0");
    expect(tv.dependencies["@astryxdesign/core"]).toBe("0.5.0");
    expect(tv.dependencies["@astryxdesign/theme-neutral"]).toBe("0.5.0");
    expect(tv.dependencies["@videojs/html"]).toBe("10.0.0-beta.31");
    expect(theme.dependencies["@astryxdesign/core"]).toBe("0.5.0");
    expect(theme.dependencies["@astryxdesign/theme-neutral"]).toBe("0.5.0");
    const packages = lock.packages as Record<string, { resolved?: unknown; version?: string }>;
    const lockedPackageVersions = (suffix: string) => Object.entries(packages)
      .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
      .map(([, entry]) => entry.version);
    expect(lockedPackageVersions("node_modules/@csstools/css-syntax-patches-for-csstree")).toEqual(["1.1.8"]);
    expect(lockedPackageVersions("node_modules/@videojs/html")).toEqual(["10.0.0-beta.31"]);
    expect(lockedPackageVersions("node_modules/shaka-player")).toEqual(["5.2.7"]);

    const resolved = Object.values(packages)
      .map(entry => typeof entry.resolved === "string" ? entry.resolved : "")
      .filter(Boolean);
    expect(resolved).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/registry\.npmjs\.org|mirrors\.cloud\.tencent\.com/i),
    ]));
    expect(resolved.filter(value => /^https?:\/\//.test(value))).toEqual([]);

    const buildServer = await readFile("scripts/build-server.mjs", "utf8");
    expect(buildServer).toContain('`@node-rs/argon2-linux-${linuxTargetArch}-gnu`');
    expect(buildServer).toContain("process.platform === \"linux\"");
    expect(buildServer).toContain("--registry=https://packagefeedproxy.microsoft.io/npm/");
    expect(await readFile(".npmrc", "utf8")).toBe("registry=https://packagefeedproxy.microsoft.io/npm/\nomit-lockfile-registry-resolved=true\n");
  });

  it("ignores local state and ships a hardened portable Compose example", async () => {
    const ignore = await readFile(".dockerignore", "utf8");
    for (const value of [".git", ".next", "node_modules", "**/node_modules", "build", "dist", ".env*", "*.pem", "**/*.pem", "*service-account*.json", "**/*service-account*.json", "firebase-adminsdk-*.json", "**/firebase-adminsdk-*.json", "/data", ".cache", "test-results", ".worktrees", ".agents", ".codex", ".impeccable"]) expect(ignore).toContain(value);
    expect(ignore).toContain(".docker-tls");
    expect(ignore).toContain("**/.docker-tls");
    expect(ignore).toContain("!.env.example");
    const compose = await readFile("compose.example.yaml", "utf8");
    expect(compose).toContain('${CLOUDFRAME_IMAGE:-cloudframe:local}');
    expect(compose).toContain('127.0.0.1:8080:8080');
    expect(compose).toContain('./cloudframe-data:/data');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('cap_drop:'); expect(compose).toContain('- ALL');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).not.toMatch(/ghcr\.io|docker\.io|https?:\/\/|nginx|certbot|cloudflare/i);
  });

  it("orchestrates exact Docker resources and always cleans them", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === "logs") return { stdout: "CLOUDFRAME_SETUP_CODE=AQEBAQEBAQEBAQEBAQEBAQ\n", stderr: "", code: 0 };
      if (args[0] === "inspect" && args.includes("{{.State.ExitCode}}")) return { stdout: "0\n", stderr: "", code: 0 };
      if (args[0] === "port") return { stdout: calls.filter(call => call.args[0] === "port").length === 1 ? "127.0.0.1:32001\n" : "127.0.0.1:32002\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });
    const http = vi.fn(async (input: { baseUrl: string; path: string; method?: string; headers?: Record<string, string>; json?: unknown }) => ({
      status: 200,
      headers: new Headers(input.path === "/api/admin/login" ? { "set-cookie": "admin_session=admin-token; Path=/", "x-csrf-token": "csrf" } : {}),
      json: { ok: true, data: input.path === "/api/setup/status" ? { state: "configured" } : input.path === "/api/admin/test-fixture" ? { deviceCookie: "device-token", handle: "sealed-handle" } : input.path === "/api/tv/media-url" ? { playlistUrl: "/api/tv/transcodes/session/master.m3u8" } : {} },
      bytes: new Uint8Array([1]),
      text: input.path.endsWith("master.m3u8") ? "#EXTM3U\nstream.m3u8\n" : input.path.endsWith("stream.m3u8") ? "#EXTM3U\nsegments/0.ts\n" : "",
    }));

    await runContainerSmoke({ run, http, randomSuffix: () => "contract", tempDirectory: async () => "test-results/cloudframe-contract", wait: async () => undefined, keep: false });

    const build = calls.find(call => call.args[0] === "build");
    expect(build?.args).toContain("CLOUDFRAME_CONTAINER_TEST=1");
    expect(build?.args).not.toContain("--platform");
    expect(calls.some(call => call.args[0] === "run" && call.args.includes("127.0.0.1::8080"))).toBe(true);
    expect(calls.some(call => call.args[0] === "start")).toBe(true);
    expect(calls.filter(call => call.args[0] === "port")).toHaveLength(2);
    expect(calls.some(call => call.args[0] === "exec" && call.args.includes("ffprobe"))).toBe(true);
    expect(calls.some(call => call.args[0] === "stop")).toBe(true);
    expect(calls.some(call => call.args[0] === "rm" && call.args.includes("-f"))).toBe(true);
    expect(calls.some(call => call.args[0] === "image" && call.args[1] === "rm")).toBe(true);
    expect(http.mock.calls.map(([input]) => input.path)).toEqual(expect.arrayContaining(["/healthz", "/readyz", "/api/setup/claim", "/api/admin/login", "/api/admin/snapshot", "/api/admin/test-fixture", "/api/tv/media-url"]));
  });
});
