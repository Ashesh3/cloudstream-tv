import { spawn as nodeSpawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export interface ProcessResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderrTail: string; }
export interface ProcessRunner { run(command: string, args: readonly string[], options: { signal: AbortSignal; timeoutMs: number; cwd?: string; stdoutLimitBytes?: number; onStdoutLine?: (line: string) => void; onStderrLine?: (line: string) => void; }): Promise<ProcessResult>; }
export type ProcessRunnerErrorCode = "PROCESS_ABORTED" | "PROCESS_OUTPUT_LIMIT" | "PROCESS_TIMEOUT" | "PROCESS_SPAWN_FAILED";
export class ProcessRunnerError extends Error { constructor(readonly code: ProcessRunnerErrorCode) { super(code); this.name = "ProcessRunnerError"; } }

type SpawnLike = (command: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcessByStdio<null, Readable, Readable>;

export function createProcessRunner(dependencies: { spawn?: SpawnLike; terminationGraceMs?: number } = {}): ProcessRunner {
  const spawn = dependencies.spawn ?? nodeSpawn;
  const grace = dependencies.terminationGraceMs ?? 2_000;
  return { run };

  async function run(command: string, args: readonly string[], options: Parameters<ProcessRunner["run"]>[2]): Promise<ProcessResult> {
    if (options.signal.aborted) throw new ProcessRunnerError("PROCESS_ABORTED");
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try { child = spawn(command, [...args], { cwd: options.cwd, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw new ProcessRunnerError("PROCESS_SPAWN_FAILED"); }
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutPending = "";
    let stderrPending = "";
    let stderrTail = "";
    let terminalError: ProcessRunnerError | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (error: ProcessRunnerError) => {
      if (terminalError) return;
      terminalError = error;
      try { child.kill("SIGTERM"); } catch { /* The close event remains authoritative. */ }
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* The child may already be gone. */ } }, grace);
    };
    const abort = () => terminate(new ProcessRunnerError("PROCESS_ABORTED"));
    options.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => terminate(new ProcessRunnerError("PROCESS_TIMEOUT")), Math.max(1, options.timeoutMs));
    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onStdoutLine) { stdoutPending = lines(stdoutPending + chunk.toString("utf8"), options.onStdoutLine); return; }
      const limit = options.stdoutLimitBytes ?? 0;
      if (limit === 0) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > limit) { terminate(new ProcessRunnerError("PROCESS_OUTPUT_LIMIT")); return; }
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrPending += chunk.toString("utf8");
      stderrPending = lines(stderrPending, (line) => {
        const safe = redact(line);
        options.onStderrLine?.(safe);
        stderrTail = boundedTail(`${stderrTail}${safe}\n`, 32 * 1024);
      });
    });
    const result = await new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", () => { terminalError = new ProcessRunnerError("PROCESS_SPAWN_FAILED"); });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); options.signal.removeEventListener("abort", abort);
        if (stdoutPending) options.onStdoutLine?.(stdoutPending);
        if (stderrPending) { const safe = redact(stderrPending); options.onStderrLine?.(safe); stderrTail = boundedTail(`${stderrTail}${safe}`, 32 * 1024); }
        if (terminalError) reject(terminalError); else resolve({ exitCode, signal, stdout: Buffer.concat(stdoutChunks), stderrTail });
      });
    });
    return result;
  }
}

function lines(value: string, emit: (line: string) => void) { let start = 0; while (true) { const end = value.indexOf("\n", start); if (end < 0) return value.slice(start); emit(value.slice(start, end).replace(/\r$/, "")); start = end + 1; } }
function boundedTail(value: string, bytes: number) { const encoded = Buffer.from(value); return encoded.length <= bytes ? value : encoded.subarray(encoded.length - bytes).toString("utf8"); }
function redact(value: string) { return value.replace(/https?:\/\/\S+/gi, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9_-]{22,}/g, "[redacted]").replace(/\?\S+/g, "?[redacted]"); }
