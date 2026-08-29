import { spawn as nodeSpawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  ProcessRunnerError,
  createProcessRunner,
} from "@cloudframe/server";

describe("bounded child process runner", () => {
  it("drains ignored stdout and reports a normal exit", async () => {
    const runner = createProcessRunner();
    const result = await runner.run(process.execPath, [
      "-e",
      "process.stdout.write(Buffer.alloc(2 * 1024 * 1024));",
    ], {
      signal: AbortSignal.timeout(10_000),
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(result.stdout).toHaveLength(0);
  });

  it("captures requested stdout and aborts on the configured output bound", async () => {
    const runner = createProcessRunner();
    await expect(runner.run(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(1024));",
    ], {
      signal: AbortSignal.timeout(10_000),
      timeoutMs: 10_000,
      stdoutLimitBytes: 64,
    })).rejects.toEqual(new ProcessRunnerError("PROCESS_OUTPUT_LIMIT"));

    const result = await runner.run(process.execPath, ["-e", "process.stdout.write('hello')"], {
      signal: AbortSignal.timeout(10_000),
      timeoutMs: 10_000,
      stdoutLimitBytes: 64,
    });
    expect(result.stdout.toString()).toBe("hello");
  });

  it("retains only a redacted 32 KiB stderr tail and reports non-zero exit", async () => {
    const runner = createProcessRunner();
    const result = await runner.run(process.execPath, [
      "-e",
      `process.stderr.write('https://provider.example/video?token=secret Bearer abcdefghijklmnopqrstuvwxyz capability_abcdefghijklmnopqrstuvwxyz\\n'); process.stderr.write('z'.repeat(40 * 1024)); process.exit(7);`,
    ], {
      signal: AbortSignal.timeout(10_000),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(7);
    expect(Buffer.byteLength(result.stderrTail, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(result.stderrTail).not.toMatch(/provider\.example|token=secret|Bearer abcdef|capability_abcdef/);
  });

  it("delivers bounded stdout and redacted stderr lines incrementally", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runner = createProcessRunner();
    await runner.run(process.execPath, [
      "-e",
      "console.log('segment.csv,4.0'); console.error('Bearer private-token-abcdefghijklmnop');",
    ], {
      signal: AbortSignal.timeout(10_000),
      timeoutMs: 10_000,
      onStdoutLine: (line) => stdout.push(line),
      onStderrLine: (line) => stderr.push(line),
    });

    expect(stdout).toEqual(["segment.csv,4.0"]);
    expect(stderr).toEqual([expect.stringContaining("[redacted]")]);
  });

  it("does not spawn when already aborted and terminates a live child on abort", async () => {
    const spawn = vi.fn((command: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => nodeSpawn(command, [...args], options as never) as never);
    const runner = createProcessRunner({ spawn, terminationGraceMs: 20 });
    const already = new AbortController();
    already.abort();
    await expect(runner.run(process.execPath, ["-e", "setTimeout(()=>{},1000)"], {
      signal: already.signal,
      timeoutMs: 10_000,
    })).rejects.toEqual(new ProcessRunnerError("PROCESS_ABORTED"));
    expect(spawn).not.toHaveBeenCalled();

    const controller = new AbortController();
    const pending = runner.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    while (spawn.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await expect(pending).rejects.toEqual(new ProcessRunnerError("PROCESS_ABORTED"));
  });

  it("uses direct, hidden, shell-free child process options", async () => {
    const spawn = vi.fn((command: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => nodeSpawn(command, [...args], options as never) as never);
    const runner = createProcessRunner({ spawn });
    await runner.run(process.execPath, ["-e", ""], {
      signal: AbortSignal.timeout(10_000),
      timeoutMs: 10_000,
    });
    expect(spawn).toHaveBeenCalledWith(process.execPath, ["-e", ""], expect.objectContaining({
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    }));
  });
});
