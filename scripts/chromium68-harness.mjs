import { access, mkdtemp, rm } from "node:fs/promises";
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
