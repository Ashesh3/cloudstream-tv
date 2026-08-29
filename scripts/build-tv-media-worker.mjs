import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if ((name !== "--outfile" && name !== "--probe-origin") || value === undefined) {
    throw new Error("Expected --outfile or --probe-origin followed by a value");
  }
  args.set(name, value);
}
const outfile = args.get("--outfile") ??
  resolve(root, "apps/tv/dist/cloudframe-media-sw.js");
const probeOrigin = args.get("--probe-origin") ?? null;
if (probeOrigin !== null) {
  let url;
  try {
    url = new URL(probeOrigin);
  } catch {
    throw new Error("Probe origin must be one exact HTTP origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== probeOrigin || url.username !== "" || url.password !== ""
  ) {
    throw new Error("Probe origin must be one exact HTTP origin");
  }
}
await build({
  entryPoints: [resolve(root, "apps/tv/src/media/google-media-worker.ts")],
  outfile,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["chrome68"],
  minify: true,
  legalComments: "none",
  sourcemap: false,
  define: {
    __CLOUDFRAME_MEDIA_PROBE_ORIGIN__: JSON.stringify(probeOrigin),
    globalThis: "self",
  },
});
