import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProcessRunnerError,
  createProcessRunner,
  createTranscodeCache,
  createTranscodeCatalog,
  createWindowEncoder,
  openLocalDatabase,
  transcodeProfile,
  type MediaProbe,
  type ProcessRunner,
  type TranscodeSourceBinding,
  type TranscodeSourceGateway,
} from "@cloudframe/server";

const exec = promisify(execFile);
const directories: string[] = [];
const cacheKey = "a".repeat(64);
const jobId = "job_" + "x".repeat(32);
const binding: TranscodeSourceBinding = {
  householdId: "h1", deviceId: "device-1", deviceSessionVersion: 1,
  sourceId: "source-1", rootId: "root-1", rootProviderNodeId: "provider-root",
  providerNodeId: "video-1", provider: "google", itemId: "item-1",
  name: "MOV00516.MPG", mimeType: "video/mpeg", size: 614_400,
  contentRevision: "revision-7", credentialVersion: 1,
};
const probe: MediaProbe = {
  durationMs: 2_080, container: "mpeg", videoCodec: "mpeg2video", audioCodec: "mp2",
  width: 640, height: 360, pixelFormat: "yuv420p", frameRate: 25,
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function storage() {
  const dataDir = await mkdtemp(join(tmpdir(), "cloudframe-window-"));
  directories.push(dataDir);
  const local = await openLocalDatabase({ dataDir });
  const catalog = createTranscodeCatalog(local.connection);
  catalog.upsertProbe(cacheKey, "h264-aac-1080p-v1", probe, 1, Date.now());
  const cache = createTranscodeCache({
    catalog,
    transcodeDir: local.transcodeDir,
    stagingDir: local.stagingDir,
    cacheMaxBytes: 100 * 1024 * 1024,
    cacheMinFreeBytes: 0,
    statfs: async () => ({ freeBytes: 1024 * 1024 * 1024 }),
  });
  return { local, catalog, cache };
}

describe("HLS window encoder", () => {
  it("builds the exact safe middle-window FFmpeg argument shape", async () => {
    const { local, catalog, cache } = await storage();
    const gateway: TranscodeSourceGateway = {
      start: async () => ({ origin: "http://127.0.0.1:4321" }),
      grant: () => ({ capability: "c".repeat(43), inputUrl: `http://127.0.0.1:4321/source/${"c".repeat(43)}`, expiresAt: Date.now() + 60_000, revoke: vi.fn() }),
      close: async () => undefined,
    };
    let captured: readonly string[] = [];
    const runner: ProcessRunner = {
      async run(_command, args, options) {
        captured = args;
        const output = args.at(-1)!;
        const file = output.replace("%d", "5");
        await mkdir(options.cwd!, { recursive: true });
        await writeFile(file, Buffer.alloc(188 * 4, 7));
        options.onStdoutLine?.("5.ts.part,20.000000,22.000000");
        return { exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderrTail: "" };
      },
    };
    const middleProbe = { ...probe, durationMs: 22_000 };
    catalog.upsertProbe(cacheKey, "h264-aac-1080p-v1", middleProbe, 6, Date.now());
    const encoder = createWindowEncoder({ runner, gateway, cache, catalog, profile: transcodeProfile(4), ffmpegPath: "ffmpeg", firstSegmentTimeoutMs: 5_000 });
    try {
      await encoder.encode({ jobId, cacheKey, binding, probe: middleProbe, windowIndex: 1, signal: AbortSignal.timeout(10_000) });
      expect(captured).toEqual(expect.arrayContaining([
        "-hide_banner", "-nostdin", "-loglevel", "warning", "-ss", "20.000",
        "-i", expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/source\/[A-Za-z0-9_-]+$/),
        "-t", "2.000", "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264",
        "-preset", "veryfast", "-crf", "22", "-profile:v", "high", "-level:v", "4.1",
        "-pix_fmt", "yuv420p", "-vf", "fps=fps='min(source_fps,30)',scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-threads", "4",
        "-force_key_frames", "expr:gte(t,n_forced*4)", "-f", "segment", "-segment_format", "mpegts",
        "-segment_time", "4", "-reset_timestamps", "1", "-segment_start_number", "5",
        "-segment_list", "pipe:1", "-segment_list_type", "csv", "-segment_list_size", "0",
      ]));
      expect(captured.join(" ")).not.toContain(binding.name);
      expect(captured.join(" ")).not.toMatch(/Bearer|access_token|tempauth/);
      expect(captured.at(-1)).toBe(join(cache.stagingJobDirectory(jobId), "%d.ts.part"));
    } finally { local.close(); }
  });

  it("publishes the first real segment before the encode promise resolves", async () => {
    const { local, catalog, cache } = await storage();
    const fixture = "tests/fixtures/media/legacy-mpeg.mpg";
    const gateway = fixtureGateway(fixture);
    await gateway.start();
    const realRunner = createProcessRunner();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner: ProcessRunner = {
      async run(command, args, options) {
        const result = await realRunner.run(command, args, options);
        await gate;
        return result;
      },
    };
    const encoder = createWindowEncoder({ runner, gateway, cache, catalog, profile: transcodeProfile("auto"), ffmpegPath: "ffmpeg", firstSegmentTimeoutMs: 10_000 });
    let promoted!: (index: number) => void;
    const firstPromoted = new Promise<number>((resolve) => { promoted = resolve; });
    const pending = encoder.encode({ jobId, cacheKey, binding, probe, windowIndex: 0, signal: AbortSignal.timeout(20_000), onSegmentPromoted: promoted });
    try {
      expect(await firstPromoted).toBe(0);
      expect((await stat(cache.segmentPath(cacheKey, 0))).size).toBeGreaterThan(0);
      let settled = false; void pending.finally(() => { settled = true; });
      await Promise.resolve(); expect(settled).toBe(false);
      release();
      await expect(pending).resolves.toEqual({ cacheKey, windowIndex: 0, completedSegmentIndices: [0], complete: true });
      expect(catalog.window(cacheKey, 0)?.state).toBe("complete");
      const inspected = JSON.parse((await exec("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt", "-of", "json", cache.segmentPath(cacheKey, 0)])).stdout);
      expect(inspected.streams).toEqual(expect.arrayContaining([
        expect.objectContaining({ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" }),
        expect.objectContaining({ codec_type: "audio", codec_name: "aac" }),
      ]));
    } finally { release(); await gateway.close(); local.close(); }
  }, 30_000);

  it("keeps promoted segments and partial state after cancellation, then completes deterministically", async () => {
    const { local, catalog, cache } = await storage();
    const gateway = fixtureGateway("tests/fixtures/media/legacy-mpeg.mpg");
    await gateway.start();
    let attempt = 0;
    const runner: ProcessRunner = {
      async run(_command, args, options) {
        attempt += 1;
        await mkdir(options.cwd!, { recursive: true });
        const output = args.at(-1)!;
        await writeFile(output.replace("%d", "0"), Buffer.alloc(188 * 4, attempt));
        options.onStdoutLine?.("0.ts.part,0.000000,2.080000");
        if (attempt === 1) throw new ProcessRunnerError("PROCESS_ABORTED");
        return { exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderrTail: "" };
      },
    };
    const encoder = createWindowEncoder({ runner, gateway, cache, catalog, profile: transcodeProfile("auto"), firstSegmentTimeoutMs: 5_000 });
    try {
      await expect(encoder.encode({ jobId, cacheKey, binding, probe, windowIndex: 0, signal: AbortSignal.timeout(10_000) }))
        .rejects.toMatchObject({ code: "TRANSCODER_FAILED" });
      expect(catalog.segment(cacheKey, 0)).not.toBeNull();
      expect(catalog.window(cacheKey, 0)?.state).toBe("partial");
      expect(cache.isPinned(cacheKey)).toBe(false);

      await expect(encoder.encode({ jobId, cacheKey, binding, probe, windowIndex: 0, signal: AbortSignal.timeout(10_000) }))
        .resolves.toMatchObject({ complete: true, completedSegmentIndices: [0] });
      expect(catalog.window(cacheKey, 0)?.state).toBe("complete");
      expect(cache.isPinned(cacheKey)).toBe(false);
    } finally { await gateway.close(); local.close(); }
  });

  it("maps missing first-segment progress to a stable timeout", async () => {
    const { local, catalog, cache } = await storage();
    const gateway = fixtureGateway("tests/fixtures/media/legacy-mpeg.mpg");
    await gateway.start();
    const runner: ProcessRunner = { async run(_command, _args, options) { await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new ProcessRunnerError("PROCESS_ABORTED")), { once: true })); throw new Error("unreachable"); } };
    const encoder = createWindowEncoder({ runner, gateway, cache, catalog, profile: transcodeProfile("auto"), firstSegmentTimeoutMs: 20 });
    try {
      await expect(encoder.encode({ jobId, cacheKey, binding, probe, windowIndex: 0, signal: AbortSignal.timeout(10_000) }))
        .rejects.toMatchObject({ code: "TRANSCODER_WINDOW_TIMEOUT" });
      expect(catalog.window(cacheKey, 0)?.state).toBe("partial");
      expect(cache.isPinned(cacheKey)).toBe(false);
    } finally { await gateway.close(); local.close(); }
  });
});

function fixtureGateway(path: string): TranscodeSourceGateway {
  let origin = "";
  let revoked = false;
  let server: import("node:http").Server | null = null;
  return {
    async start() {
      const { createServer } = await import("node:http");
      const { once } = await import("node:events").then((module) => module.default);
      const metadata = await stat(path);
      server = createServer((request, response) => {
        if (revoked) { response.statusCode = 404; response.end(); return; }
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        if (match) {
          const start = Number(match[1]); const end = match[2] ? Math.min(Number(match[2]), metadata.size - 1) : metadata.size - 1;
          response.statusCode = 206; response.setHeader("content-range", `bytes ${start}-${end}/${metadata.size}`); response.setHeader("content-length", String(end - start + 1)); response.setHeader("accept-ranges", "bytes"); createReadStream(path, { start, end }).pipe(response); return;
        }
        response.setHeader("content-length", String(metadata.size)); response.setHeader("accept-ranges", "bytes"); createReadStream(path).pipe(response);
      });
      server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("address"); origin = `http://127.0.0.1:${address.port}`; return { origin };
    },
    grant() { revoked = false; return { capability: "fixture", inputUrl: `${origin}/source/fixture`, expiresAt: Date.now() + 60_000, revoke() { revoked = true; } }; },
    async close() { if (!server) return; server.closeAllConnections(); server.close(); const { once } = await import("node:events").then((module) => module.default); await once(server, "close"); },
  };
}
