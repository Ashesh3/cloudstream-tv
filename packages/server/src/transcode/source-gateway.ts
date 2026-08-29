import { randomBytes as nodeRandomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { ProviderMediaSourceService, ValidatedProviderMediaSource } from "../services/provider-media-source.ts";
import type { TranscodeSourceAuthorizer } from "./source-authorizer.ts";
import { TranscodeError, type TranscodeSourceBinding } from "./types.ts";

export interface SourceGatewayGrant { capability: string; inputUrl: string; expiresAt: number; revoke(): void; }
export interface TranscodeSourceGateway { start(): Promise<{ origin: string }>; grant(binding: TranscodeSourceBinding, jobId: string): SourceGatewayGrant; close(): Promise<void>; }

interface GrantState { binding: TranscodeSourceBinding; jobId: string; expiresAt: number; active: Set<AbortController>; uses: number; }

export function createTranscodeSourceGateway(options: {
  authorizer: Pick<TranscodeSourceAuthorizer, "withReauthorizedItem">;
  mediaSources: ProviderMediaSourceService;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  log?: (event: unknown) => void;
}): TranscodeSourceGateway {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const randomBytes = options.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  const grants = new Map<string, GrantState>();
  let server: Server | null = null;
  let origin: string | null = null;

  async function start() {
    if (origin) return { origin };
    server = createServer((request, response) => void handle(request, response));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new TranscodeError("TRANSCODER_SOURCE_UNAVAILABLE");
    origin = `http://127.0.0.1:${address.port}`;
    return { origin };
  }

  function grant(binding: TranscodeSourceBinding, jobId: string): SourceGatewayGrant {
    if (!origin) throw new TranscodeError("TRANSCODER_SOURCE_UNAVAILABLE");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(jobId)) throw new TranscodeError("TRANSCODER_PATH_INVALID");
    const capability = Buffer.from(randomBytes(32)).toString("base64url");
    const expiresAt = now().getTime() + 120_000;
    grants.set(capability, { binding, jobId, expiresAt, active: new Set(), uses: 0 });
    return { capability, inputUrl: `${origin}/source/${capability}`, expiresAt, revoke: () => revoke(capability) };
  }

  function revoke(capability: string) { const state = grants.get(capability); grants.delete(capability); for (const controller of state?.active ?? []) controller.abort(); }

  async function close() { for (const capability of grants.keys()) revoke(capability); if (!server) return; server.close(); await once(server, "close"); server = null; origin = null; }

  async function handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
    const peer = request.socket.remoteAddress?.replace(/^::ffff:/, "");
    if (!peer || isIP(peer) === 0 || (peer !== "127.0.0.1" && peer !== "::1")) return finish(response, 403);
    if (request.method !== "GET" && request.method !== "HEAD") return finish(response, 405, { allow: "GET, HEAD" });
    const raw = request.url ?? "";
    if (raw.includes("?") || raw.includes("#")) return finish(response, 404);
    const match = /^\/source\/([A-Za-z0-9_-]{43})$/.exec(raw);
    const state = match ? grants.get(match[1]!) : undefined;
    if (!match || !state || state.expiresAt <= now().getTime() || state.uses >= 2) return finish(response, 404);
    const range = request.headers.range;
    if (range !== undefined && !/^bytes=\d+-\d*$/.test(range)) return finish(response, 400);
    state.uses += 1;
    const controller = new AbortController();
    state.active.add(controller);
    response.once("close", () => controller.abort());
    try {
      const item = await options.authorizer.withReauthorizedItem(state.binding, async (current) => current);
      let source = await options.mediaSources.resolve(item);
      let upstream = await requestUpstream(source, request.method, range, controller.signal);
      if (upstream.status === 401 || upstream.status === 403) {
        source = await options.mediaSources.resolve(item, { refresh: true });
        upstream = await requestUpstream(source, request.method, range, controller.signal);
      }
      response.statusCode = upstream.status;
      for (const name of ["accept-ranges", "content-length", "content-range", "content-type", "etag", "last-modified"]) { const value = upstream.headers.get(name); if (value !== null) response.setHeader(name, value); }
      if (request.method === "HEAD" || !upstream.body) response.end(); else Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(response);
    } catch {
      finish(response, 502);
    } finally { state.active.delete(controller); }
  }

  async function requestUpstream(source: ValidatedProviderMediaSource, method: string | undefined, range: string | undefined, signal: AbortSignal) {
    const headers = new Headers(source.request.headers);
    if (range) headers.set("range", range);
    const response = await fetcher(source.request.url, { method, headers, redirect: "follow", signal });
    if (!validFinalUrl(source.provider, source.item.claims.providerNodeId, response.url || source.request.url)) throw new Error("redirect");
    return response;
  }

  return { start, grant, close };
}

function validFinalUrl(provider: "google" | "onedrive", nodeId: string, raw: string) { try { const url = new URL(raw); if (provider === "google") return url.origin === "https://www.googleapis.com" && url.pathname === `/drive/v3/files/${encodeURIComponent(nodeId)}`; const host = url.hostname.toLowerCase(); return host.endsWith(".sharepoint.com") || host.endsWith(".files.1drv.com") || host === "storage.live.com" || host.endsWith(".storage.live.com") || host.endsWith(".microsoftusercontent.com"); } catch { return false; } }
function finish(response: import("node:http").ServerResponse, status: number, headers: Record<string, string> = {}) { if (response.writableEnded) return; response.statusCode = status; for (const [name, value] of Object.entries(headers)) response.setHeader(name, value); response.end(); }
