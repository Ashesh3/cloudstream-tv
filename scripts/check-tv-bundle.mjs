import { parse } from "acorn";
import postcss from "postcss";
import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Script } from "node:vm";

const target = "chrome108";
const directory = join(process.cwd(), "apps", "tv", "dist", "assets");
const workerPath = join(process.cwd(), "apps", "tv", "dist", "cloudframe-media-sw.js");
const files = await readdir(directory);
const entry = files.find(name => /^index-(?!legacy-).*\.js$/u.test(name));
if (!entry) throw new Error("TV Chromium 108 entry chunk is required");
const legacyArtifacts = files.filter(name => /(?:^|-)legacy-|^polyfills-/u.test(name));
if (legacyArtifacts.length > 0) {
  throw new Error(`TV build contains retired legacy/polyfill artifacts: ${legacyArtifacts.join(", ")}`);
}

const javascript = files.filter(name => name.endsWith(".js"));
let compressedJavaScript = 0;
let compressedLazyMediaJavaScript = 0;
let compressedLocaleJavaScript = 0;
for (const name of javascript) {
  const source = await readFile(join(directory, name), "utf8");
  parse(source, { ecmaVersion: 2022, sourceType: "module" });
  const compressed = gzipSync(source).byteLength;
  if (/^(?:skin|hls|player|volume)-/u.test(name)) compressedLazyMediaJavaScript += compressed;
  else if (name !== entry) compressedLocaleJavaScript += compressed;
  else compressedJavaScript += compressed;
}
if (compressedJavaScript > 180 * 1024) {
  throw new Error(`TV Chromium 108 JavaScript exceeds 180 KiB compressed: ${compressedJavaScript}`);
}
if (compressedLazyMediaJavaScript > 260 * 1024) {
  throw new Error(`Lazy Video.js and HLS chunks exceed 260 KiB compressed: ${compressedLazyMediaJavaScript}`);
}
if (compressedLocaleJavaScript > 80 * 1024) {
  throw new Error(`Lazy Video.js locale chunks exceed 80 KiB compressed: ${compressedLocaleJavaScript}`);
}

let compressedCss = 0;
for (const name of files.filter(name => name.endsWith(".css"))) {
  const source = await readFile(join(directory, name), "utf8");
  const root = postcss.parse(source, { from: name });
  let unsupported = null;
  root.walkAtRules(atRule => {
    if (atRule.name.toLowerCase() === "scope") unsupported ??= "@scope";
  });
  root.walkRules(rule => {
    if (/:popover-open\b|\[popover\]/iu.test(rule.selector)) unsupported ??= ":popover-open";
  });
  root.walkDecls(declaration => {
    const property = declaration.prop.toLowerCase();
    const value = declaration.value.toLowerCase();
    if (value.includes("light-dark(")) unsupported ??= "light-dark";
    if (value.includes("color-mix(")) unsupported ??= "color-mix";
    if (property === "anchor-name") unsupported ??= "anchor-name";
    if (property === "position-anchor" || /\banchor(?:-size)?\s*\(/iu.test(value)) unsupported ??= "position-anchor";
  });
  if (unsupported) {
    throw new Error(`${name} contains unresolved Chromium 108 CSS requirement: ${unsupported}`);
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
  `TV bundle compatibility and budget check passed for ${target} (${compressedJavaScript} B app JS, ${compressedLazyMediaJavaScript} B lazy media JS, ${compressedLocaleJavaScript} B lazy locale JS, ${compressedCss} B CSS, ${compressedWorker} B Chrome 68 media worker compressed).\n`
);
