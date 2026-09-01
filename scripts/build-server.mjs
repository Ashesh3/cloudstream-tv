import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build as esbuild } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "build", "self-hosted");
const serverDirectory = join(output, "server");
const exec = promisify(execFile);
const linuxTargetArch = process.platform === "linux" ? process.arch : "x64";
const linuxGlibcRuntimePackage = { name: `@node-rs/argon2-linux-${linuxTargetArch}-gnu`, version: "2.1.0" };
const containerTest = process.env.CLOUDFRAME_CONTAINER_TEST === "1";

if (!["arm64", "x64"].includes(linuxTargetArch)) {
  throw new Error("build:server supports Linux arm64 or x64 images");
}

await rm(output, { recursive: true, force: true });
await mkdir(serverDirectory, { recursive: true });
await cp(join(root, "dist"), join(output, "public"), { recursive: true });
await esbuild({
  entryPoints: [join(root, "deploy", "server-entry.ts")],
  outfile: join(serverDirectory, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  external: ["@node-rs/argon2", "@node-rs/argon2/*", "@node-rs/argon2-linux-*"],
  define: { __CLOUDFRAME_CONTAINER_TEST__: JSON.stringify(containerTest) },
});
await writeFile(join(output, "package.json"), JSON.stringify({ type: "module" }, null, 2));
await copyRuntimePackage("@node-rs/argon2");
await copyOrFetchRuntimePackage(linuxGlibcRuntimePackage);
if (containerTest) {
  const fixtures = join(output, "test-fixtures");
  await mkdir(fixtures, { recursive: true });
  await cp(join(root, "tests", "fixtures", "media", "legacy-mpeg.mpg"), join(fixtures, "legacy-mpeg.mpg"));
}

async function copyRuntimePackage(name) {
  await cp(
    join(root, "node_modules", ...name.split("/")),
    join(output, "node_modules", ...name.split("/")),
    { recursive: true },
  );
}

async function copyOrFetchRuntimePackage(pkg) {
  try {
    await copyRuntimePackage(pkg.name);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const cache = join(root, "build", "native-cache", pkg.name.replace("/", "-"));
  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  const npmCli = process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : "npm";
  const command = process.platform === "win32" ? process.execPath : npmCli;
  const registry = "--registry=https://packagefeedproxy.microsoft.io/npm/";
  const args = process.platform === "win32"
    ? [npmCli, "pack", `${pkg.name}@${pkg.version}`, "--silent", registry]
    : ["pack", `${pkg.name}@${pkg.version}`, "--silent", registry];
  const { stdout } = await exec(command, args, { cwd: cache, windowsHide: true, maxBuffer: 1024 * 1024 });
  const archive = stdout.trim().split(/\r?\n/).at(-1);
  if (!archive) throw new Error(`npm pack produced no archive for ${pkg.name}`);
  await exec("tar", ["-xzf", archive], { cwd: cache, windowsHide: true });
  await cp(join(cache, "package"), join(output, "node_modules", ...pkg.name.split("/")), { recursive: true });
}
