import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Script } from "node:vm";

const directory = join(process.cwd(), "apps", "tv", "dist", "assets");
const files = await readdir(directory);
const legacyEntry = files.find(name => /^index-legacy-.*\.js$/.test(name));
const legacyPolyfills = files.find(name => /^polyfills-legacy-.*\.js$/.test(name));
if (!legacyEntry || !legacyPolyfills) {
  throw new Error("TV legacy entry and polyfills-legacy chunks are required");
}

let compressedJavaScript = 0;
for (const name of [legacyEntry, legacyPolyfills]) {
  const source = await readFile(join(directory, name), "utf8");
  new Script(source, { filename: name });
  if (/\?\.|\?\?/.test(source)) {
    throw new Error(`${name} contains syntax newer than Chromium 68`);
  }
  compressedJavaScript += gzipSync(source).byteLength;
}
if (compressedJavaScript > 180 * 1024) {
  throw new Error(`TV legacy JavaScript exceeds 180 KiB compressed: ${compressedJavaScript}`);
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

process.stdout.write(
  `TV bundle compatibility and budget check passed (${compressedJavaScript} B JS, ${compressedCss} B CSS compressed).\n`
);
