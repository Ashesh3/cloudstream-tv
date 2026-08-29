import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Script } from "node:vm";

const directory = join(process.cwd(), "apps", "tv", "dist", "assets");
const workerPath = join(process.cwd(), "apps", "tv", "dist", "cloudframe-media-sw.js");
const files = await readdir(directory);
const legacyEntry = files.find(name => /^index-legacy-.*\.js$/.test(name));
const legacyPolyfills = files.find(name => /^polyfills-legacy-.*\.js$/.test(name));
if (!legacyEntry || !legacyPolyfills) {
  throw new Error("TV legacy entry and polyfills-legacy chunks are required");
}
const legacyJavaScript = files.filter(name => /-legacy-.*\.js$/.test(name));
const optionalSyntax = /\?\?(?:[^=]|$)|\?\.(?!\d)/;

let compressedJavaScript = 0;
let compressedLazyMediaJavaScript = 0;
for (const name of legacyJavaScript) {
  const source = await readFile(join(directory, name), "utf8");
  new Script(source, { filename: name });
  if (optionalSyntax.test(source)) {
    throw new Error(`${name} contains syntax newer than Chromium 68`);
  }
  const compressed = gzipSync(source).byteLength;
  if (/^(?:skin|hls)-legacy-/u.test(name)) compressedLazyMediaJavaScript += compressed;
  else compressedJavaScript += compressed;
}
if (compressedJavaScript > 180 * 1024) {
  throw new Error(`TV legacy JavaScript exceeds 180 KiB compressed: ${compressedJavaScript}`);
}
if (compressedLazyMediaJavaScript > 260 * 1024) {
  throw new Error(`Lazy Video.js and HLS chunks exceed 260 KiB compressed: ${compressedLazyMediaJavaScript}`);
}

let compressedCss = 0;
const unsupportedCss = /\b(?:clamp|min|max)\s*\(|(?:^|[;{])\s*inset\s*:|\baspect-ratio\s*:|\bcolor-scheme\s*:|(?:^|[;{])\s*gap\s*:/i;
for (const name of files.filter(name => name.endsWith(".css"))) {
  const source = await readFile(join(directory, name), "utf8");
  if (unsupportedCss.test(source)) {
    throw new Error(`${name} contains CSS without a Chromium 68 fallback`);
  }
  compressedCss += gzipSync(source).byteLength;
}
if (compressedCss > 45 * 1024) {
  throw new Error(`TV CSS exceeds 45 KiB compressed: ${compressedCss}`);
}

const workerSource = await readFile(workerPath, "utf8");
new Script(workerSource, { filename: "cloudframe-media-sw.js" });
if (/\?\.|\?\?/.test(workerSource)) {
  throw new Error("cloudframe-media-sw.js contains syntax newer than Chromium 68");
}
if (/\bglobalThis\b/.test(workerSource)) {
  throw new Error("cloudframe-media-sw.js contains globalThis, which Chromium 68 does not support");
}
const compressedWorker = gzipSync(workerSource).byteLength;
if (compressedWorker > 24 * 1024) {
  throw new Error(`TV media worker exceeds 24 KiB compressed: ${compressedWorker}`);
}

process.stdout.write(
  `TV bundle compatibility and budget check passed (${compressedJavaScript} B app JS, ${compressedLazyMediaJavaScript} B lazy media JS, ${compressedCss} B CSS, ${compressedWorker} B media worker compressed).\n`
);
