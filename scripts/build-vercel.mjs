import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

await rm(output, { recursive: true, force: true });

const inheritedWorkflowNamespace = process.env.WORKFLOW_QUEUE_NAMESPACE;
delete process.env.WORKFLOW_QUEUE_NAMESPACE;
const { VercelBuildOutputAPIBuilder } = await import("@workflow/builders");
const builder = new VercelBuildOutputAPIBuilder({
    buildTarget: "vercel-build-output-api",
    dirs: ["./workflows"],
    workingDir: root,
    projectRoot: root,
    moduleSpecifierRoot: root,
    stepsBundlePath: "",
    workflowsBundlePath: "",
    webhookBundlePath: "",
    externalPackages: [
      "@node-rs/argon2",
      "@node-rs/argon2-linux-x64-gnu",
      "@node-rs/argon2-linux-arm64-gnu"
    ],
    runtime: contract.workflows.runtime
});
try {
  await builder.build();
} finally {
  if (inheritedWorkflowNamespace !== undefined) {
    process.env.WORKFLOW_QUEUE_NAMESPACE = inheritedWorkflowNamespace;
  }
}

await cp(join(root, "dist"), join(output, "static"), { recursive: true });
const syncWorkflowId = await readSyncWorkflowId();
await buildApiFunction(syncWorkflowId);
await applyFunctionContract();
await mergeRoutes();

async function buildApiFunction(syncWorkflowId) {
  const directory = join(output, "functions", "api.func");
  await mkdir(directory, { recursive: true });
  await esbuild({
    entryPoints: [join(root, "api", "[...route].ts")],
    outfile: join(directory, "index.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: true,
    define: {
      __SYNC_SOURCE_WORKFLOW_ID__: JSON.stringify(syncWorkflowId)
    },
    external: ["@node-rs/argon2", "@node-rs/argon2/*", "@node-rs/argon2-linux-*"]
  });
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2));
  await copyRuntimePackage("@node-rs/argon2", directory);
  for (const pkg of nativePackages) {
    await copyOrFetchRuntimePackage(pkg, directory);
  }
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

async function readSyncWorkflowId() {
  const manifest = JSON.parse(await readFile(
    join(output, "functions", ".well-known", "workflow", "v1", "manifest.json"),
    "utf8"
  ));
  const workflows = Object.values(manifest.workflows ?? {})
    .flatMap(value => Object.values(value));
  const match = workflows.find(workflow =>
    typeof workflow?.workflowId === "string" &&
    workflow.workflowId.includes("syncSourceWorkflow")
  );
  if (!match) throw new Error("Transformed syncSourceWorkflow metadata is missing");
  return match.workflowId;
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
  const npmCommand = process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : "npm";
  const command = process.platform === "win32" ? process.execPath : npmCommand;
  const args = process.platform === "win32"
    ? [npmCommand, "pack", `${pkg.name}@${pkg.version}`, "--silent"]
    : ["pack", `${pkg.name}@${pkg.version}`, "--silent"];
  const { stdout } = await exec(command, args, {
    cwd: cache,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  const archive = stdout.trim().split(/\r?\n/).at(-1);
  if (!archive) throw new Error(`npm pack produced no archive for ${pkg.name}`);
  await exec("tar", ["-xzf", archive], { cwd: cache, windowsHide: true });
  await cp(join(cache, "package"), destination, { recursive: true });
}

async function applyFunctionContract() {
  const workflowRoot = join(output, "functions", ".well-known", "workflow", "v1");
  for (const relative of ["flow.func", "step.func", "webhook/[token].func"]) {
    const file = join(workflowRoot, relative, ".vc-config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.architecture = "x86_64";
    config.regions = contract.workflows.regions;
    await writeFile(file, JSON.stringify(config, null, 2));
  }
  const stepDirectory = join(workflowRoot, "step.func");
  await copyRuntimePackage("@node-rs/argon2", stepDirectory);
  for (const pkg of nativePackages) {
    await copyOrFetchRuntimePackage(pkg, stepDirectory);
  }
}

async function mergeRoutes() {
  const file = join(output, "config.json");
  const generated = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({
    ...generated,
    version: 3,
    routes: contract.routes
  }, null, 2));
}
