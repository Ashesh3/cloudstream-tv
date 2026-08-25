import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";

/* global console, process */

const assets = join(process.cwd(), "apps", "tv", "dist", "assets");
const files = readdirSync(assets).filter(name => /(?:index|polyfills)-legacy-.*\.js$/.test(name));
if (files.length < 2) throw new Error("TV legacy entry and polyfill chunks were not emitted.");
for (const name of files) {
  const source = readFileSync(join(assets, name), "utf8");
  new Script(source, { filename: name });
  if (/\?\.|\?\?/.test(source)) throw new Error(`${name} contains syntax newer than Chromium 68.`);
}
console.log(`TV legacy syntax check passed for ${files.length} chunks.`);
