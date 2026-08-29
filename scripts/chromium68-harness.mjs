import { access, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const PROBE_DIRECTORY_PREFIX = "cloudframe-chromium68-";
const PROBE_SYMBOL = "__CLOUDFRAME_MEDIA_PROBE_ORIGIN__";

export async function createProbePaths() {
  const root = await mkdtemp(join(tmpdir(), PROBE_DIRECTORY_PREFIX));
  return {
    root,
    worker: join(root, "cloudframe-media-sw.js"),
    profile: join(root, "profile"),
  };
}

export function assertProductionWorker(source) {
  if (
    /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/iu.test(source) ||
    source.includes("/sample.wav") ||
    source.includes(PROBE_SYMBOL)
  ) {
    throw new Error("Production media worker contains probe configuration");
  }
}

export async function removeProbeRoot(root) {
  const resolvedRoot = resolve(root);
  const resolvedTemp = resolve(tmpdir());
  if (
    dirname(resolvedRoot) !== resolvedTemp ||
    !basename(resolvedRoot).startsWith(PROBE_DIRECTORY_PREFIX)
  ) {
    throw new Error("Refusing to remove an invalid Chromium 68 temporary root");
  }
  await rm(resolvedRoot, { recursive: true, force: true });
  try {
    await access(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Chromium 68 temporary root cleanup failed");
}

export function spawnChecked(command, args, options) {
  const child = spawn(command, args, options);
  return observeCheckedChild(child, command);
}

export function observeCheckedChild(child, command) {
  let startSettled = false;
  let completionSettled = false;
  let resolveStart;
  let rejectStart;
  let resolveCompletion;
  let rejectCompletion;
  const started = new Promise((resolvePromise, reject) => {
    resolveStart = resolvePromise;
    rejectStart = reject;
  });
  const completed = new Promise((resolvePromise, reject) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = reject;
  });
  void completed.catch(() => undefined);

  const settleStart = (action, value) => {
    if (startSettled) return;
    startSettled = true;
    action(value);
  };
  const settleCompletion = (action, value) => {
    if (completionSettled) return;
    completionSettled = true;
    child.removeListener("spawn", onSpawn);
    child.removeListener("error", onError);
    child.removeListener("close", onClose);
    action(value);
  };
  const onSpawn = () => settleStart(resolveStart, child);
  const onError = error => {
    settleStart(rejectStart, error);
    settleCompletion(rejectCompletion, error);
  };
  const onClose = (code, signal) => {
    if (!startSettled) {
      settleStart(rejectStart, new Error(`${command} closed before spawning`));
    }
    settleCompletion(resolveCompletion, { code, signal });
  };
  child.once("spawn", onSpawn);
  child.once("error", onError);
  child.once("close", onClose);
  return { child, started, completed };
}

export async function runCheckedProcess(command, args, options, label) {
  const { started, completed } = spawnChecked(command, args, options);
  await started;
  const result = await completed;
  if (result.code === 0) return;
  const outcome = result.signal === null ? String(result.code) : `from ${result.signal}`;
  throw new Error(`${label} exited ${outcome}`);
}
