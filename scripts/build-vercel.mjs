import { cp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build as esbuild } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = join(root, ".vercel", "output");
const contract = JSON.parse(
  await readFile(join(root, "deploy", "vercel-build-contract.json"), "utf8")
);
const exec = promisify(execFile);
const nativePackages = [
  { name: "@node-rs/argon2-linux-x64-gnu", version: "2.1.0" },
  { name: "@node-rs/argon2-linux-arm64-gnu", version: "2.1.0" }
];

await ensureStaticBuild();
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, "dist"), join(output, "static"), { recursive: true });
await buildApiFunction();
await writeFile(
  join(output, "config.json"),
  JSON.stringify({ version: 3, routes: contract.routes }, null, 2)
);

async function ensureStaticBuild() {
  try {
    await Promise.all([
      access(join(root, "dist", "index.html")),
      access(join(root, "dist", "admin", "index.html"))
    ]);
  } catch {
    const npmCli = process.platform === "win32"
      ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
      : "npm";
    const command = process.platform === "win32" ? process.execPath : npmCli;
    const args = process.platform === "win32"
      ? [npmCli, "run", "build"]
      : ["run", "build"];
    await exec(command, args, { cwd: root, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  }
}

async function buildApiFunction() {
  const directory = join(output, "functions", "api.func");
  await mkdir(directory, { recursive: true });
  await esbuild({
    entryPoints: [join(root, "deploy", "api-entry.ts")],
    outfile: join(directory, "index.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: true,
    external: ["@node-rs/argon2", "@node-rs/argon2/*", "@node-rs/argon2-linux-*"]
  });
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2));
  await copyRuntimePackage("@node-rs/argon2", directory);
  for (const pkg of nativePackages) await copyOrFetchRuntimePackage(pkg, directory);
  await writeFile(
    join(directory, ".vc-config.json"),
    JSON.stringify({
      runtime: contract.api.runtime,
      handler: "index.js",
      launcherType: "Nodejs",
      architecture: "x86_64",
      useWebApi: true,
      shouldAddHelpers: true,
      maxDuration: contract.api.maxDuration,
      memory: contract.api.memory,
      regions: contract.api.regions
    }, null, 2)
  );
}

async function copyRuntimePackage(name, functionDirectory, optional = false) {
  const source = join(root, "node_modules", ...name.split("/"));
  try {
    await cp(source, join(functionDirectory, "node_modules", ...name.split("/")), { recursive: true });
  } catch (error) {
    if (!optional || error?.code !== "ENOENT") throw error;
  }
}

async function copyOrFetchRuntimePackage(pkg, functionDirectory) {
  const source = join(root, "node_modules", ...pkg.name.split("/"));
  const destination = join(functionDirectory, "node_modules", ...pkg.name.split("/"));
  try {
    await cp(source, destination, { recursive: true });
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const cache = join(root, ".vercel", "native-cache", pkg.name.replace("/", "-"));
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
  await cp(join(cache, "package"), destination, { recursive: true });
}
