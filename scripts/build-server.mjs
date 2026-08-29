import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build as esbuild } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "build", "self-hosted");
const serverDirectory = join(output, "server");
const exec = promisify(execFile);
const linuxX64 = { name: "@node-rs/argon2-linux-x64-gnu", version: "2.1.0" };

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
});
await writeFile(join(output, "package.json"), JSON.stringify({ type: "module" }, null, 2));
await copyRuntimePackage("@node-rs/argon2");
await copyOrFetchRuntimePackage(linuxX64);

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
  const args = process.platform === "win32"
    ? [npmCli, "pack", `${pkg.name}@${pkg.version}`, "--silent"]
    : ["pack", `${pkg.name}@${pkg.version}`, "--silent"];
  const { stdout } = await exec(command, args, { cwd: cache, windowsHide: true, maxBuffer: 1024 * 1024 });
  const archive = stdout.trim().split(/\r?\n/).at(-1);
  if (!archive) throw new Error(`npm pack produced no archive for ${pkg.name}`);
  await exec("tar", ["-xzf", archive], { cwd: cache, windowsHide: true });
  await cp(join(cache, "package"), join(output, "node_modules", ...pkg.name.split("/")), { recursive: true });
}
