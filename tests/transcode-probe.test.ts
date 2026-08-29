import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  TranscodeError,
  createMediaProbeService,
  createProcessRunner,
  type ProcessRunner,
  type ProcessResult,
} from "@cloudframe/server";

const fixture = "tests/fixtures/media/legacy-mpeg.mpg";

async function withFixture(operation: (url: string) => Promise<void>) {
  const metadata = await stat(fixture);
  const server = createServer((request, response) => {
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) { response.statusCode = 416; response.end(); return; }
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), metadata.size - 1) : metadata.size - 1;
      if (start > end || start >= metadata.size) { response.statusCode = 416; response.setHeader("content-range", `bytes */${metadata.size}`); response.end(); return; }
      response.statusCode = 206;
      response.setHeader("content-range", `bytes ${start}-${end}/${metadata.size}`);
      response.setHeader("content-length", String(end - start + 1));
      response.setHeader("accept-ranges", "bytes");
      response.setHeader("content-type", "video/mpeg");
      if (request.method === "HEAD") response.end(); else createReadStream(fixture, { start, end }).pipe(response);
      return;
    }
    response.setHeader("content-length", String(metadata.size));
    response.setHeader("accept-ranges", "bytes");
    response.setHeader("content-type", "video/mpeg");
    if (request.method === "HEAD") response.end(); else createReadStream(fixture).pipe(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  try { await operation(`http://127.0.0.1:${address.port}/legacy-mpeg.mpg`); }
  finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
}

function fakeResult(stdout: unknown, exitCode = 0): ProcessResult {
  return { exitCode, signal: null, stdout: Buffer.from(typeof stdout === "string" ? stdout : JSON.stringify(stdout)), stderrTail: "" };
}

function fakeRunner(result: ProcessResult | Error): ProcessRunner {
  return { async run() { if (result instanceof Error) throw result; return result; } };
}

describe("strict media probing", () => {
  it("probes the committed MPEG fixture through HTTP with real FFprobe", async () => {
    await withFixture(async (url) => {
      const probe = createMediaProbeService({ runner: createProcessRunner(), ffprobePath: "ffprobe" });
      await expect(probe.probe(url, AbortSignal.timeout(10_000))).resolves.toMatchObject({
        durationMs: expect.any(Number),
        container: expect.stringContaining("mpeg"),
        videoCodec: "mpeg2video",
        audioCodec: "mp2",
        width: 640,
        height: 360,
        pixelFormat: "yuv420p",
        frameRate: 25,
      });
    });
  });

  it.each([
    ["invalid JSON", fakeResult("not-json"), "TRANSCODER_FAILED"],
    ["non-zero exit", fakeResult({}, 1), "TRANSCODER_SOURCE_UNAVAILABLE"],
    ["missing video", fakeResult({ format: { duration: "2", format_name: "mpeg" }, streams: [{ codec_type: "audio", codec_name: "mp2" }] }), "TRANSCODER_UNSUPPORTED"],
    ["zero duration", fakeResult({ format: { duration: "0", format_name: "mpeg" }, streams: [{ codec_type: "video", codec_name: "mpeg2video", width: 640, height: 360 }] }), "TRANSCODER_UNSUPPORTED"],
    ["excessive duration", fakeResult({ format: { duration: String(25 * 60 * 60), format_name: "mpeg" }, streams: [{ codec_type: "video", codec_name: "mpeg2video", width: 640, height: 360 }] }), "TRANSCODER_UNSUPPORTED"],
    ["too many videos", fakeResult({ format: { duration: "2", format_name: "mpeg" }, streams: [{ codec_type: "video", codec_name: "mpeg2video", width: 640, height: 360 }, { codec_type: "video", codec_name: "h264", width: 640, height: 360 }] }), "TRANSCODER_UNSUPPORTED"],
    ["pathological rate", fakeResult({ format: { duration: "2", format_name: "mpeg" }, streams: [{ codec_type: "video", codec_name: "mpeg2video", width: 640, height: 360, avg_frame_rate: "1000/1" }] }), "TRANSCODER_UNSUPPORTED"],
  ] as const)("normalizes %s", async (_label, result, code) => {
    const probe = createMediaProbeService({ runner: fakeRunner(result) });
    await expect(probe.probe("http://127.0.0.1/source/capability", AbortSignal.timeout(1000)))
      .rejects.toEqual(new TranscodeError(code));
  });
});
