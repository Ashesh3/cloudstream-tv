import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dockerBuildArguments } from "./docker-build.mjs";

export async function runContainerSmoke(dependencies = {}) {
  const run = dependencies.run ?? runProcess;
  const http = dependencies.http ?? httpRequest;
  const suffix = dependencies.randomSuffix?.() ?? randomBytes(6).toString("hex");
  const temporary = dependencies.tempDirectory ? await dependencies.tempDirectory() : await mkdtemp(join(tmpdir(), `cloudframe-container-${suffix}-`));
  const wait = dependencies.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const keep = dependencies.keep ?? process.env.CLOUDFRAME_KEEP_SMOKE_RESOURCES === "1";
  const image = `cloudframe-smoke:${suffix}`;
  const container = `cloudframe-smoke-${suffix}`;
  const dataDirectory = join(temporary, "data");
  const segmentPath = join(temporary, "segment-0.ts");
  let running = false;
  try {
    await mkdir(dataDirectory, { recursive: true });
    await chmod(dataDirectory, 0o777).catch(() => undefined);
    await run("docker", dockerBuildArguments({ image, containerTest: true }));
    await run("docker", ["run", "-d", "--name", container, "-p", "127.0.0.1::8080", "-v", `${resolve(dataDirectory)}:/data`, "-e", "APP_ORIGIN=https://127.0.0.1", "-e", "TRANSCODE_CACHE_MAX_BYTES=1GiB", "-e", "TRANSCODE_CACHE_MIN_FREE_BYTES=64MiB", "-e", "TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS=60", "-e", "TRANSCODE_THREADS=1", image]);
    running = true;
    const baseUrl = await containerBaseUrl(run, container);
    await waitFor(http, baseUrl, "/healthz", wait);
    await waitFor(http, baseUrl, "/readyz", wait);
    const logs = await run("docker", ["logs", container]);
    const setupCode = /CLOUDFRAME_SETUP_CODE=([^\s]+)/u.exec(logs.stdout)?.[1];
    if (!setupCode) throw new Error("Container did not emit the setup code");
    const passphrase = "cloudframe smoke passphrase 2026";
    await http({ baseUrl, path: "/api/setup/claim", method: "POST", headers: { origin: "https://127.0.0.1" }, json: { setupCode, passphrase } });
    const login = await http({ baseUrl, path: "/api/admin/login", method: "POST", json: { passphrase } });
    const adminCookie = cookieFrom(login.headers, "admin_session");
    const csrf = header(login.headers, "x-csrf-token");
    await http({ baseUrl, path: "/api/admin/snapshot", headers: { cookie: adminCookie } });
    const fixture = await http({ baseUrl, path: "/api/admin/test-fixture", method: "POST", headers: { cookie: adminCookie, "x-csrf-token": csrf, origin: "https://127.0.0.1" }, json: { fixture: "legacy-mpeg" } });
    const fixtureData = fixture.json?.data ?? fixture.json;
    const deviceCookie = fixtureData?.deviceCookie ? `device_session=${fixtureData.deviceCookie}` : cookieFrom(fixture.headers, "device_session");
    const media = await http({ baseUrl, path: "/api/tv/media-url", method: "POST", headers: { cookie: deviceCookie }, json: { handle: fixtureData.handle } });
    const descriptor = media.json?.data ?? media.json;
    const master = await http({ baseUrl, path: descriptor.playlistUrl, headers: { cookie: deviceCookie } });
    const streamPath = relativePlaylist(descriptor.playlistUrl, text(master));
    const stream = await http({ baseUrl, path: streamPath, headers: { cookie: deviceCookie } });
    const segmentUrl = relativePlaylist(streamPath, text(stream));
    const segment = await http({ baseUrl, path: segmentUrl, headers: { cookie: deviceCookie } });
    await writeFile(segmentPath, segment.bytes ?? new Uint8Array());
    await run("docker", ["cp", segmentPath, `${container}:/tmp/cloudframe-smoke-segment.ts`]);
    await run("docker", ["exec", container, "ffprobe", "-v", "error", "/tmp/cloudframe-smoke-segment.ts"]);
    await run("docker", ["stop", "--time", "20", container]);
    running = false;
    const stopped = await run("docker", ["inspect", "--format", "{{.State.ExitCode}}", container]);
    if (String(stopped.stdout).trim() !== "0") throw new Error(`Container exited with ${String(stopped.stdout).trim()}`);
    await run("docker", ["start", container]);
    running = true;
    const restartedBaseUrl = await containerBaseUrl(run, container);
    await waitFor(http, restartedBaseUrl, "/readyz", wait);
    const status = await http({ baseUrl: restartedBaseUrl, path: "/api/setup/status" });
    if ((status.json?.data ?? status.json)?.state !== "configured") throw new Error("Configured installation did not persist");
    await http({ baseUrl: restartedBaseUrl, path: "/api/admin/login", method: "POST", json: { passphrase } });
    await run("docker", ["stop", "--time", "20", container]);
    running = false;
    const exit = await run("docker", ["inspect", "--format", "{{.State.ExitCode}}", container]);
    if (String(exit.stdout).trim() !== "0") throw new Error(`Container exited with ${String(exit.stdout).trim()}`);
  } finally {
    if (!keep) {
      if (running) await run("docker", ["stop", "--time", "5", container]).catch(() => undefined);
      await run("docker", ["rm", "-f", container]).catch(() => undefined);
      await run("docker", ["image", "rm", "-f", image]).catch(() => undefined);
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function parsePort(value) { const match = /127\.0\.0\.1:(\d+)/u.exec(value); return match ? Number(match[1]) : null; }
async function containerBaseUrl(run, container) {
  const portOutput = await run("docker", ["port", container, "8080/tcp"]);
  return `http://127.0.0.1:${parsePort(portOutput.stdout) ?? 8080}`;
}
async function waitFor(http, baseUrl, path, wait) { for (let attempt = 0; attempt < 120; attempt += 1) { try { if ((await http({ baseUrl, path })).status === 200) return; } catch {} await wait(250); } throw new Error(`${path} did not become ready`); }
function header(headers, name) { if (headers instanceof Headers) return headers.get(name) ?? ""; return headers?.[name] ?? headers?.[name.toLowerCase()] ?? ""; }
function cookieFrom(headers, name) { const cookie = header(headers, "set-cookie"); const match = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`, "u").exec(cookie); if (!match) throw new Error(`Missing ${name} cookie`); return `${name}=${match[1]}`; }
function text(response) { return typeof response.text === "string" ? response.text : new TextDecoder().decode(response.bytes ?? new Uint8Array()); }
function relativePlaylist(base, body) { const entry = body.split(/\r?\n/u).find(line => line && !line.startsWith("#")); if (!entry) throw new Error("Playlist contained no media URI"); return new URL(entry, `http://cloudframe${base}`).pathname; }

async function httpRequest({ baseUrl, path, method = "GET", headers = {}, json }) { const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(json === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: json === undefined ? undefined : JSON.stringify(json) }); const bytes = new Uint8Array(await response.arrayBuffer()); let parsed = null; try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch {} return { status: response.status, headers: response.headers, json: parsed, bytes, text: new TextDecoder().decode(bytes) }; }
function runProcess(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; process.stdout.write(chunk); }); child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; process.stderr.write(chunk); }); child.once("error", reject); child.once("exit", code => code === 0 ? resolve({ stdout, stderr, code }) : reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.slice(-2000)}`))); }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runContainerSmoke();
