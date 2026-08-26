import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const revision = "555668";
const cache = resolve(".cache", "chromium-68", revision);
const archive = join(cache, "chrome-win32.zip");
const executable = join(cache, "chrome-win32", "chrome.exe");
const sitePort = await freePort();
const port = await freePort();
await mkdir(cache, { recursive: true });

try {
  await access(executable);
} catch {
  const url = `https://storage.googleapis.com/chromium-browser-snapshots/Win/${revision}/chrome-win32.zip`;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Pinned Chromium download failed: ${response.status}`);
  await pipeline(response.body, createWriteStream(archive));
  await new Promise((resolvePromise, reject) => {
    const tar = spawn("tar", ["-xf", archive, "-C", cache], { stdio: "ignore", windowsHide: true });
    tar.once("exit", code => code === 0 ? resolvePromise() : reject(new Error(`tar exited ${code}`)));
  });
}

const profile = join(cache, "profile");
await rm(profile, { recursive: true, force: true });
const staticServer = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${sitePort}`).pathname;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  try {
    const body = await readFile(resolve("apps", "tv", "dist", relative));
    response.writeHead(200, { "content-type": relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : "text/html" });
    response.end(body);
  } catch {
    response.writeHead(404); response.end();
  }
});
await new Promise(resolvePromise => staticServer.listen(sitePort, "127.0.0.1", resolvePromise));
const chrome = spawn(executable, [
  "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `http://127.0.0.1:${sitePort}/`
], { stdio: "ignore", windowsHide: true });

try {
  const endpoint = await waitForDebugger(port);
  const ws = new WebSocket(endpoint.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => { ws.once("open", resolvePromise); ws.once("error", reject); });
  let id = 0;
  const pending = new Map();
  const runtimeErrors = [];
  ws.on("message", data => {
    const message = JSON.parse(String(data));
    if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") runtimeErrors.push(message.params);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const commandId = ++id;
    pending.set(commandId, { resolve: resolvePromise, reject });
    ws.send(JSON.stringify({ id: commandId, method, params }));
  });
  await command("Runtime.enable");
  const product = await command("Browser.getVersion");
  if (!String(product.product).includes("Chrome/68.")) {
    throw new Error(`Pinned snapshot is not Chromium 68: ${product.product}`);
  }
  const evaluated = await command("Runtime.evaluate", {
    expression: "({promise:typeof Promise==='function',fetch:typeof fetch==='function',url:typeof URL==='function',abort:typeof AbortController==='function'})",
    returnByValue: true
  });
  const value = evaluated.result.value;
  if (!value.promise || !value.fetch || !value.url || !value.abort) {
    throw new Error(`Chromium 68 required APIs missing: ${JSON.stringify(value)}`);
  }
  await command("Page.enable");
  await command("Page.navigate", { url: `http://127.0.0.1:${sitePort}/` });
  let rendered;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    rendered = await command("Runtime.evaluate", { expression: "document.body && document.body.innerText", returnByValue: true });
    if (String(rendered.result.value ?? "").includes("Cloudframe")) break;
    await delay(100);
  }
  if (!String(rendered?.result.value ?? "").includes("Cloudframe")) {
    throw new Error(`Chromium 68 did not render the TV build: ${JSON.stringify(rendered)}`);
  }
  const unexpectedErrors = runtimeErrors.filter(error => !isExpectedLegacyProbeError(error));
  if (unexpectedErrors.length) throw new Error(`Chromium 68 runtime errors: ${JSON.stringify(unexpectedErrors)}`);
  ws.close();
  process.stdout.write(`Pinned Chromium ${revision} executed required TV APIs successfully.\n`);
} finally {
  chrome.kill();
  await new Promise(resolvePromise => staticServer.close(resolvePromise));
}

async function waitForDebugger(debugPort) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(target => target.type === "page");
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {
      // The debugger endpoint is expected to refuse connections during startup.
    }
    await delay(100);
  }
  throw new Error("Pinned Chromium remote-debugging-port did not become ready");
}

async function freePort() {
  const server = createServer();
  await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const free = typeof address === "object" && address ? address.port : 0;
  await new Promise(resolvePromise => server.close(resolvePromise));
  return free;
}

function isExpectedLegacyProbeError(error) {
  const description = error.exception?.description ?? error.text ?? "";
  const url = error.url ?? error.stackTrace?.callFrames?.[0]?.url ?? "";
  return (
    description.includes("import.meta.resolve not supported") &&
    url.startsWith("data:text/javascript,")
  ) || (
    description.includes("Unexpected token ?") &&
    /\/assets\/index-(?!legacy-)[^/]+\.js$/.test(url)
  );
}
