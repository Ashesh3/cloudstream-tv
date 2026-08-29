import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { runContainerSmoke } from "../scripts/container-smoke.mjs";

describe("portable container contract", () => {
  it("uses a pinned, unprivileged single-port Node 24 image", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    expect(dockerfile).toContain("FROM node:24.5.0-bookworm-slim AS build");
    expect(dockerfile).toContain("FROM node:24.5.0-bookworm-slim AS runtime");
    expect(dockerfile.indexOf("RUN npm ci")).toBeLessThan(dockerfile.indexOf("COPY . ."));
    expect(dockerfile).toMatch(/RUN (?:CLOUDFRAME_CONTAINER_TEST=\$CLOUDFRAME_CONTAINER_TEST )?npm run build:server/);
    expect(dockerfile).toMatch(/apt-get install[^\n]*ffmpeg[^\n]*ca-certificates[^\n]*tini/);
    expect(dockerfile).toContain("WORKDIR /app");
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(dockerfile).toContain('CMD ["node", "server/index.js"]');
    expect(dockerfile).toMatch(/USER cloudframe/);
    expect(dockerfile).not.toMatch(/Horizon|\b\d{1,3}(?:\.\d{1,3}){3}\b|nginx|certbot|cloudflare|vercel token|client_secret|COPY .*\.env/i);
  });

  it("ignores local state and ships a hardened portable Compose example", async () => {
    const ignore = await readFile(".dockerignore", "utf8");
    for (const value of [".git", ".vercel", ".next", "node_modules", "build", "dist", ".env*", "/data", ".cache", "test-results", ".worktrees", ".agents", ".codex", ".impeccable"]) expect(ignore).toContain(value);
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

    expect(calls.some(call => call.args[0] === "build" && call.args.includes("--platform") && call.args.includes("linux/amd64") && call.args.includes("CLOUDFRAME_CONTAINER_TEST=1"))).toBe(true);
    expect(calls.some(call => call.args[0] === "run" && call.args.includes("127.0.0.1::8080"))).toBe(true);
    expect(calls.some(call => call.args[0] === "restart")).toBe(true);
    expect(calls.some(call => call.args[0] === "exec" && call.args.includes("ffprobe"))).toBe(true);
    expect(calls.some(call => call.args[0] === "stop")).toBe(true);
    expect(calls.some(call => call.args[0] === "rm" && call.args.includes("-f"))).toBe(true);
    expect(calls.some(call => call.args[0] === "image" && call.args[1] === "rm")).toBe(true);
    expect(http.mock.calls.map(([input]) => input.path)).toEqual(expect.arrayContaining(["/healthz", "/readyz", "/api/setup/claim", "/api/admin/login", "/api/admin/snapshot", "/api/admin/test-fixture", "/api/tv/media-url"]));
  });
});
