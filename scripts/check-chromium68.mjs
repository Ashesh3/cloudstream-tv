import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import {
  assertProductionWorker,
  createProbePaths,
  removeProbeRoot,
  runCheckedProcess,
  spawnChecked,
} from "./chromium68-harness.mjs";

const revision = "555668";
const testCache = testOverride("CLOUDFRAME_CHROMIUM68_TEST_CACHE");
const cache = testCache ?? resolve(".cache", "chromium-68", revision);
const archive = join(cache, "chrome-win32.zip");
const pinnedExecutable = join(cache, "chrome-win32", "chrome.exe");
const testExecutable = testOverride("CLOUDFRAME_CHROMIUM68_TEST_EXECUTABLE");
const executable = testExecutable ?? pinnedExecutable;
const sitePort = await configuredPort("CLOUDFRAME_CHROMIUM68_TEST_SITE_PORT");
const mediaPort = await configuredPort("CLOUDFRAME_CHROMIUM68_TEST_MEDIA_PORT");
const debuggerPort = await configuredPort("CLOUDFRAME_CHROMIUM68_TEST_DEBUGGER_PORT");
const siteOrigin = `http://127.0.0.1:${sitePort}`;
const mediaOrigin = `http://127.0.0.1:${mediaPort}`;
const mediaUrl = `${mediaOrigin}/sample.wav`;
const probeToken = randomBytes(24).toString("base64url");
const mediaBody = pcmWav(10);
const upstreamRequests = [];
let aliasApplicationRequests = 0;
const productionWorkerPath = resolve("apps", "tv", "dist", "cloudframe-media-sw.js");
let temporaryDirectory = null;
let probeWorkerPath = null;
let profile = null;
let chrome = null;
let ws = null;
let requestBrowserClose = null;
let completed = false;

const mediaServer = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", mediaOrigin).pathname;
  if (pathname !== "/sample.wav") {
    response.writeHead(404);
    response.end();
    return;
  }

  const origin = request.headers.origin;
  if (origin !== siteOrigin) {
    response.writeHead(403);
    response.end();
    return;
  }
  const cors = {
    "access-control-allow-origin": siteOrigin,
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "authorization, range",
    "access-control-expose-headers": "accept-ranges, content-length, content-range, content-type",
    vary: "Origin",
  };

  if (request.method === "OPTIONS") {
    const requestedHeaders = String(request.headers["access-control-request-headers"] ?? "")
      .split(",")
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);
    if (
      requestedHeaders.length !== 2 ||
      !requestedHeaders.includes("authorization") ||
      !requestedHeaders.includes("range")
    ) {
      response.writeHead(403, cors);
      response.end();
      return;
    }
    response.writeHead(204, cors);
    response.end();
    return;
  }

  const authorization = request.headers.authorization ?? null;
  const range = request.headers.range ?? null;
  upstreamRequests.push({ method: request.method, authorization, range });
  if (authorization !== `Bearer ${probeToken}`) {
    response.writeHead(401, cors);
    response.end();
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, cors);
    response.end();
    return;
  }

  const interval = byteRange(range, mediaBody.byteLength);
  if (!interval) {
    response.writeHead(416, {
      ...cors,
      "accept-ranges": "bytes",
      "content-range": `bytes */${mediaBody.byteLength}`,
    });
    response.end();
    return;
  }
  const body = mediaBody.subarray(interval.start, interval.end + 1);
  response.writeHead(206, {
    ...cors,
    "accept-ranges": "bytes",
    "content-length": String(body.byteLength),
    "content-range": `bytes ${interval.start}-${interval.end}/${mediaBody.byteLength}`,
    "content-type": "audio/wav",
  });
  response.end(request.method === "HEAD" ? undefined : body);
});

const staticServer = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", siteOrigin).pathname;
  if (pathname.startsWith("/__cloudframe_media__/")) {
    aliasApplicationRequests += 1;
    response.writeHead(404);
    response.end();
    return;
  }
  if (pathname === "/cloudframe-media-sw.js") {
    try {
      const body = await readFile(probeWorkerPath);
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": "text/javascript",
        "service-worker-allowed": "/",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  try {
    const body = await readFile(resolve("apps", "tv", "dist", relative));
    response.writeHead(200, { "content-type": staticContentType(relative) });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

try {
  const probePaths = await createProbePaths();
  temporaryDirectory = probePaths.root;
  probeWorkerPath = probePaths.worker;
  profile = probePaths.profile;
  await mkdir(cache, { recursive: true });
  if (testExecutable === null) {
    try {
      await access(pinnedExecutable);
    } catch {
      const url = `https://storage.googleapis.com/chromium-browser-snapshots/Win/${revision}/chrome-win32.zip`;
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`Pinned Chromium download failed: ${response.status}`);
      await pipeline(response.body, createWriteStream(archive));
      await runCheckedProcess(
        "tar",
        ["-xf", archive, "-C", cache],
        { stdio: "ignore", windowsHide: true },
        "tar",
      );
    }
  }

  const productionWorker = await readFile(productionWorkerPath, "utf8");
  assertProductionWorker(productionWorker);
  await runNode([
    "scripts/build-tv-media-worker.mjs",
    "--outfile",
    probeWorkerPath,
    "--probe-origin",
    mediaOrigin,
  ]);
  const probeWorker = await readFile(probeWorkerPath, "utf8");
  if (!probeWorker.includes(mediaOrigin)) {
    throw new Error("Temporary media worker does not contain the exact probe origin");
  }

  await Promise.all([
    listen(mediaServer, mediaPort),
    listen(staticServer, sitePort),
  ]);
  const chromium = spawnChecked(executable, [
    "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${debuggerPort}`, `--user-data-dir=${profile}`, `${siteOrigin}/`,
  ], { stdio: "ignore", windowsHide: true });
  chrome = chromium.child;
  await chromium.started;

  const chromiumStopped = chromium.completed.then(result => {
    const outcome = result.signal === null ? String(result.code) : `from ${result.signal}`;
    throw new Error(`Pinned Chromium exited ${outcome} before the debugger became ready`);
  });
  const endpoint = await Promise.race([
    waitForDebugger(debuggerPort),
    chromiumStopped,
  ]);
  ws = new WebSocket(endpoint.webSocketDebuggerUrl);
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
  requestBrowserClose = () => command("Browser.close");
  await command("Runtime.enable");
  const product = await command("Browser.getVersion");
  if (!String(product.product).includes("Chrome/68.")) {
    throw new Error(`Pinned snapshot is not Chromium 68: ${product.product}`);
  }
  const evaluated = await command("Runtime.evaluate", {
    expression: `({
      promise:typeof Promise==='function',
      fetch:typeof fetch==='function',
      url:typeof URL==='function',
      abort:typeof AbortController==='function',
      crypto:Boolean(self.crypto&&self.crypto.subtle&&typeof self.crypto.subtle.digest==='function'),
      textEncoder:typeof TextEncoder==='function',
      serviceWorker:Boolean(navigator.serviceWorker),
      readableStream:typeof ReadableStream==='function',
      response:typeof Response==='function'
    })`,
    returnByValue: true,
  });
  const value = evaluated.result.value;
  if (
    !value.promise || !value.fetch || !value.url || !value.abort || !value.crypto ||
    !value.textEncoder || !value.serviceWorker || !value.readableStream || !value.response
  ) {
    throw new Error(`Chromium 68 required APIs missing: ${JSON.stringify(value)}`);
  }
  await command("Page.enable");
  await command("Page.navigate", { url: `${siteOrigin}/` });
  let rendered;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    rendered = await command("Runtime.evaluate", { expression: "document.body && document.body.innerText", returnByValue: true });
    if (String(rendered.result.value ?? "").toLocaleLowerCase().includes("cloudframe")) break;
    await delay(100);
  }
  if (!String(rendered?.result.value ?? "").toLocaleLowerCase().includes("cloudframe")) {
    throw new Error(`Chromium 68 did not render the TV build: ${JSON.stringify(rendered)}`);
  }
  const assets = await readdir(resolve("apps", "tv", "dist", "assets"));
  const playerChunk = assets.find(name => /^player-legacy-.*\.js$/u.test(name));
  const containerChunk = assets.find(name => /^container-legacy-.*\.js$/u.test(name));
  if (!playerChunk) throw new Error("Video.js legacy player chunk was not emitted");
  if (!containerChunk) throw new Error("Video.js legacy container chunk was not emitted");
  const playerResult = await command("Runtime.evaluate", {
    expression: `(async()=>{
      await Promise.all([
        System.import('/assets/${playerChunk}'),
        System.import('/assets/${containerChunk}')
      ]);
      const player=document.createElement('video-player');
      const container=document.createElement('media-container');
      const video=document.createElement('video');
      container.appendChild(video);
      player.appendChild(container);
      document.body.appendChild(player);
      await Promise.resolve();
      return {
        player:Boolean(customElements.get('video-player')),
        container:Boolean(customElements.get('media-container')),
        nativeVideo:player.querySelector('media-container > video')===video
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const playerValue = playerResult.result.value;
  if (!playerValue?.player || !playerValue.container || !playerValue.nativeVideo) {
    throw new Error(`Chromium 68 Video.js fallback failed: ${JSON.stringify(playerResult)}`);
  }

  const workerRace = JSON.stringify({
    source: productionWorker,
    rawUrl: "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true",
    fingerprint: "3AB37G86_cgrjatvKRIjGFG9CjOZwAtQnDzLhQTUlHs",
  });
  const workerRaceResult = await command("Runtime.evaluate", {
    expression: `(async()=>{
      const config=${workerRace};
      const listeners={};
      const messages=[];
      let releaseDigest=null;
      let digestCalls=0;
      let providerFetches=0;
      const validatedDigest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(config.rawUrl));
      const client={id:'client_chromium68_bundle',postMessage:message=>messages.push(message)};
      const fakeSelf={
        location:{origin:'https://tv.test'},
        clients:{claim:()=>Promise.resolve(),get:id=>Promise.resolve(id===client.id?client:undefined)},
        skipWaiting:()=>Promise.resolve(),
        addEventListener:(type,listener)=>{listeners[type]=listener;},
        fetch:()=>{providerFetches+=1;return Promise.reject(new Error('provider-fetch-must-not-run'));},
        crypto:{subtle:{digest:()=>{
          digestCalls+=1;
          return digestCalls===1
            ? new Promise(resolve=>{releaseDigest=()=>resolve(validatedDigest);})
            : Promise.resolve(validatedDigest);
        }}},
        setTimeout:callback=>setTimeout(callback,1),
        clearTimeout:clearTimeout.bind(self)
      };
      new Function('self','crypto','URL','Request','Response','Headers','TextEncoder','Uint8Array','ReadableStream','btoa',config.source)(
        fakeSelf,fakeSelf.crypto,URL,Request,Response,Headers,TextEncoder,Uint8Array,ReadableStream,btoa
      );
      const dispatch=message=>{
        const waits=[];
        listeners.message({data:message,source:client,waitUntil:value=>waits.push(Promise.resolve(value))});
        return Promise.all(waits);
      };
      const pendingGrant=dispatch({
        type:'cloudframe-media-grant',
        requestId:'request_chromium68_bundle_race',
        grant:{
          sessionId:'session_chromium68_bundle_race',
          rawUrl:config.rawUrl,
          fingerprint:config.fingerprint,
          token:'bundle-test-token',
          expiresAtEpoch:Date.now()+60000,
          kind:'video',
          mimeType:'video/mpeg',
          filename:'MOV00516.MPG',
          size:100
        }
      });
      for(let attempt=0;attempt<50&&!releaseDigest;attempt+=1){
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      if(!releaseDigest)return {ok:false,reason:'bundle-validation-did-not-start'};
      await dispatch({type:'cloudframe-media-revoke',sessionId:'session_chromium68_bundle_race'});
      releaseDigest();
      await pendingGrant;
      let fetched=null;
      listeners.fetch({
        request:new Request(config.rawUrl,{headers:{range:'bytes=0-'}}),
        clientId:client.id,
        respondWith:value=>{fetched=Promise.resolve(value);},
        waitUntil:()=>undefined
      });
      if(!fetched)return {ok:false,reason:'bundle-fetch-not-intercepted'};
      const response=await fetched;
      return {
        ok:
          !messages.some(message=>
            message.type==='cloudframe-media-grant-ack'&&
            message.requestId==='request_chromium68_bundle_race'
          )&&
          response.type==='error'&&providerFetches===0
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const workerRaceValue = workerRaceResult.result.value;
  if (!workerRaceValue?.ok) {
    throw new Error(`Chromium 68 production worker ordering failed: ${workerRaceValue?.reason ?? "stale grant acknowledged"}`);
  }

  const probe = JSON.stringify({
    workerUrl: "/cloudframe-media-sw.js",
    rawUrl: mediaUrl,
    token: probeToken,
    size: mediaBody.byteLength,
  });
  const mediaResult = await command("Runtime.evaluate", {
    expression: `(async()=>{
      const config=${probe};
      const sessionId='session_chromium68_probe';
      const requestId='request_chromium68_probe';
      const filename='sample.wav';
      const media=[];
      let controller=null;
      const timeout=(label,ms)=>new Promise((_,reject)=>setTimeout(()=>reject(new Error(label)),ms));
      const exactKeys=(value,keys)=>{
        if(!value||typeof value!=='object'||Array.isArray(value))return false;
        const actual=Object.keys(value).sort();
        const expected=keys.slice().sort();
        return actual.length===expected.length&&actual.every((key,index)=>key===expected[index]);
      };
      const fingerprint=async value=>{
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
        const bytes=new Uint8Array(digest);
        let binary='';
        for(let index=0;index<bytes.length;index+=1)binary+=String.fromCharCode(bytes[index]);
        return btoa(binary).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/g,'');
      };
      const waitForController=()=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('controller-timeout')),10000);
        const changed=()=>{
          if(!navigator.serviceWorker.controller)return;
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('controllerchange',changed);
          resolve(navigator.serviceWorker.controller);
        };
        navigator.serviceWorker.addEventListener('controllerchange',changed);
      });
      const waitForMessage=(predicate,label)=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{
          navigator.serviceWorker.removeEventListener('message',received);
          reject(new Error(label));
        },10000);
        const received=event=>{
          if(!event.source||!controller||event.source.scriptURL!==controller.scriptURL||!predicate(event.data))return;
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('message',received);
          resolve(event.data);
        };
        navigator.serviceWorker.addEventListener('message',received);
      });
      const waitForResult=attempt=>waitForMessage(data=>
        exactKeys(data,['type','sessionId','attempt','outcome','status'])&&
        data.type==='cloudframe-media-result'&&data.sessionId===sessionId&&
        data.attempt===attempt&&data.outcome==='response'&&data.status===206,
        attempt+'-result-timeout'
      );
      const loadMetadata=(source,label)=>{
        const audio=document.createElement('audio');
        media.push(audio);
        audio.preload='metadata';
        document.body.appendChild(audio);
        const loaded=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error(label+'-metadata-timeout')),15000);
          audio.addEventListener('loadedmetadata',()=>{clearTimeout(timer);resolve();},{once:true});
          audio.addEventListener('error',()=>{
            clearTimeout(timer);
            reject(new Error(label+'-media-error-'+String(audio.error?audio.error.code:0)));
          },{once:true});
        });
        audio.src=source;
        audio.load();
        return Promise.race([loaded,timeout(label+'-timeout',16000)]).then(()=>audio.duration);
      };
      try{
        const controllerChanged=waitForController();
        await navigator.serviceWorker.register(config.workerUrl,{scope:'/'});
        await navigator.serviceWorker.ready;
        controller=await controllerChanged;
        const ack=waitForMessage(data=>
          exactKeys(data,['type','requestId','sessionId'])&&
          data.type==='cloudframe-media-grant-ack'&&data.requestId===requestId&&data.sessionId===sessionId,
          'grant-ack-timeout'
        );
        controller.postMessage({
          type:'cloudframe-media-grant',
          requestId,
          grant:{
            sessionId,
            rawUrl:config.rawUrl,
            fingerprint:await fingerprint(config.rawUrl),
            token:config.token,
            expiresAtEpoch:Date.now()+60000,
            kind:'video',
            mimeType:'video/wav',
            filename,
            size:config.size
          }
        });
        await ack;
        const rawResult=waitForResult('google-raw');
        const rawDuration=await loadMetadata(config.rawUrl,'raw');
        await rawResult;
        const aliasResult=waitForResult('google-filename');
        const aliasDuration=await loadMetadata('/__cloudframe_media__/'+sessionId+'/'+encodeURIComponent(filename),'alias');
        await aliasResult;
        controller.postMessage({type:'cloudframe-media-revoke',sessionId});
        return {ok:true,rawLoaded:Number.isFinite(rawDuration),aliasLoaded:Number.isFinite(aliasDuration)};
      }catch(error){
        return {ok:false,reason:error instanceof Error?error.message:'probe-failed'};
      }finally{
        for(const audio of media){
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
          audio.remove();
        }
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const mediaValue = mediaResult.result.value;
  if (!mediaValue?.ok || !mediaValue.rawLoaded || !mediaValue.aliasLoaded) {
    throw new Error(`Chromium 68 media worker probe failed: ${mediaValue?.reason ?? "unknown"}`);
  }
  if (!upstreamRequests.some(request =>
    request.authorization === `Bearer ${probeToken}` &&
    request.range === "bytes=0-"
  )) throw new Error("Chromium 68 did not forward bearer Range media");
  if (aliasApplicationRequests !== 0) {
    throw new Error("Filename alias escaped the service worker");
  }

  const unexpectedErrors = runtimeErrors.filter(error => !isExpectedLegacyProbeError(error));
  if (unexpectedErrors.length) throw new Error(`Chromium 68 runtime errors: ${JSON.stringify(unexpectedErrors)}`);
  completed = true;
} finally {
  await cleanupProbeResources({
    chrome,
    requestBrowserClose,
    ws,
    staticServer,
    mediaServer,
    temporaryDirectory,
  });
}

if (completed) {
  process.stdout.write(`Pinned Chromium 68 revision ${revision} preserved revoked-grant ordering and loaded authenticated Range media and filename alias successfully.\n`);
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

async function configuredPort(name) {
  const value = testOverride(name);
  if (value === null) return freePort();
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${name}`);
  }
  return port;
}

function testOverride(name) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return null;
  const value = process.env[name];
  if (process.env.NODE_ENV !== "test" || typeof value !== "string" || value.length < 1) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function listen(server, port) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });
}

function closeServer(server) {
  return server.listening
    ? new Promise(resolvePromise => server.close(resolvePromise))
    : Promise.resolve();
}

async function cleanupProbeResources(resources) {
  const failures = [];
  const steps = [
    () => closeChromium(resources.chrome, resources.requestBrowserClose),
    () => closeWebSocket(resources.ws),
    () => closeServer(resources.staticServer),
    () => closeServer(resources.mediaServer),
    () => resources.temporaryDirectory
      ? removeProbeRoot(resources.temporaryDirectory)
      : Promise.resolve(),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Chromium 68 cleanup failed");
  }
}

async function closeChromium(child, requestClose) {
  if (!child || processExited(child)) return;
  if (requestClose) {
    try {
      await Promise.race([
        requestClose().catch(() => undefined),
        delay(2_000),
      ]);
    } catch {
      // A browser that is already exiting may reject its final command.
    }
  }
  if (await waitForProcessExit(child, 3_000)) return;
  child.kill();
  if (!await waitForProcessExit(child, 5_000)) {
    throw new Error("Pinned Chromium did not exit before profile cleanup");
  }
}

function waitForProcessExit(child, timeoutMs) {
  if (processExited(child)) return Promise.resolve(true);
  return new Promise(resolvePromise => {
    const exited = () => {
      globalThis.clearTimeout(timer);
      resolvePromise(true);
    };
    const timer = globalThis.setTimeout(() => {
      child.removeListener("exit", exited);
      resolvePromise(false);
    }, timeoutMs);
    child.once("exit", exited);
  });
}

function processExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function closeWebSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise(resolvePromise => {
    const closed = () => {
      globalThis.clearTimeout(timer);
      resolvePromise();
    };
    const timer = globalThis.setTimeout(() => {
      socket.removeListener("close", closed);
      resolvePromise();
    }, 1_000);
    socket.once("close", closed);
    try {
      socket.close();
    } catch {
      closed();
    }
  });
}

function runNode(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Temporary media worker build exited ${code}: ${stderr.trim()}`));
    });
  });
}

function byteRange(value, size) {
  if (typeof value !== "string") return null;
  const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/u.exec(value);
  if (!match) return null;
  if (match[3] !== undefined) {
    const suffix = Number(match[3]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
    start < 0 || start >= size || requestedEnd < start
  ) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function pcmWav(seconds) {
  const sampleRate = 44_100;
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const dataLength = seconds * sampleRate * blockAlign;
  const body = Buffer.alloc(44 + dataLength);
  body.write("RIFF", 0, "ascii");
  body.writeUInt32LE(36 + dataLength, 4);
  body.write("WAVE", 8, "ascii");
  body.write("fmt ", 12, "ascii");
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(channels, 22);
  body.writeUInt32LE(sampleRate, 24);
  body.writeUInt32LE(sampleRate * blockAlign, 28);
  body.writeUInt16LE(blockAlign, 32);
  body.writeUInt16LE(bitsPerSample, 34);
  body.write("data", 36, "ascii");
  body.writeUInt32LE(dataLength, 40);
  return body;
}

function staticContentType(pathname) {
  if (pathname.endsWith(".js")) return "text/javascript";
  if (pathname.endsWith(".css")) return "text/css";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  if (pathname.endsWith(".webp")) return "image/webp";
  return "text/html";
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
