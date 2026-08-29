import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ControlPlaneStore } from "../control-plane/store.ts";
import type { ControlRequestContextScope } from "./request-context.ts";
import { loadControlRequestContext } from "./request-context.ts";
import type { ControlAuth } from "../services/control-auth.ts";
import type { TranscodeCache } from "../transcode/cache.ts";
import type { TranscodeCoordinator } from "../transcode/coordinator.ts";
import { renderMasterPlaylist, renderMediaPlaylist } from "../transcode/manifests.ts";
import type { TranscodeSourceAuthorizer } from "../transcode/source-authorizer.ts";
import { TranscodeError } from "../transcode/types.ts";
import { HttpError } from "./errors.ts";
import { errorResponse, ok } from "./response.ts";

const PLAYLIST_HEADERS = {
  "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
  "cache-control": "private, no-store",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
};

export function createTranscodeApiApp(options: {
  controlStore: ControlPlaneStore;
  requestContext: ControlRequestContextScope;
  auth: ControlAuth;
  sourceAuthorizer: Pick<TranscodeSourceAuthorizer, "validateCurrent">;
  coordinator: Pick<TranscodeCoordinator, "session" | "heartbeat" | "segment" | "release" | "diagnostic">;
  cache: Pick<TranscodeCache, "pinServed">;
  cacheMaxBytes: number;
  allowedOrigin: string;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const adminDiagnostic = url.pathname === "/api/admin/transcodes/status";
    if (!adminDiagnostic && !url.pathname.startsWith("/api/tv/transcodes/")) return null;
    try {
      if (url.search) throw new HttpError(400, "INVALID_QUERY", "Query parameters are not accepted.");
      if (adminDiagnostic) {
        requireMethod(request, "admin-status");
        const context = await options.requestContext.runRequest(() => loadControlRequestContext(options.controlStore, options.requestContext));
        const admin = await options.auth.admin(request, context, now());
        const diagnostic = options.coordinator.diagnostic();
        const active = diagnostic.active ? {
          itemName: diagnostic.active.itemName,
          provider: diagnostic.active.provider,
          stage: diagnostic.active.stage,
          windowIndex: diagnostic.active.windowIndex,
          progressPercent: diagnostic.active.progressPercent,
          speed: diagnostic.active.speed,
        } : null;
        return ok({
          active,
          leaseDeviceName: diagnostic.leaseDeviceName,
          queuedDemandedWindows: diagnostic.queuedDemandedWindows,
          busyRejections: diagnostic.busyRejections,
          cacheBytes: diagnostic.cacheBytes,
          cacheMaxBytes: options.cacheMaxBytes,
          lastErrorCode: diagnostic.lastErrorCode,
        }, { headers: { "x-csrf-token": admin.csrfToken, "cache-control": "private, no-store" } });
      }
      const match = /^\/api\/tv\/transcodes\/([A-Za-z0-9_-]{16,128})(?:\/(master\.m3u8|stream\.m3u8|heartbeat|segments\/(\d+)\.ts))?$/.exec(url.pathname);
      if (!match) {
        if (/\/segments\/-?\d+\.ts$/.test(url.pathname)) {
          throw new HttpError(400, "INVALID_SEGMENT", "Segment index is invalid.");
        }
        throw new HttpError(404, "NOT_FOUND", "Transcode route not found.");
      }
      const sessionId = match[1]!;
      const action = match[2] ?? "release";
      requireMethod(request, action);
      const context = await options.requestContext.runRequest(() => loadControlRequestContext(options.controlStore, options.requestContext));
      const device = await options.auth.device(request, context, now());
      const session = options.coordinator.session(sessionId);
      if (!session) throw new TranscodeError("TRANSCODER_SESSION_EXPIRED");
      if (session.binding.deviceId !== device.deviceId) throw new HttpError(401, "DEVICE_UNAUTHORIZED", "Device is not authorized.");
      options.sourceAuthorizer.validateCurrent(device, session.binding);

      if (action === "master.m3u8") return playlist(renderMasterPlaylist(sessionId, session.probe, session.profile));
      if (action === "stream.m3u8") return playlist(renderMediaPlaylist(session.probe, session.profile));
      if (action === "heartbeat") {
        requireOrigin(request, options.allowedOrigin);
        options.coordinator.heartbeat(sessionId, device.deviceId);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      if (action === "release") {
        requireOrigin(request, options.allowedOrigin);
        await options.coordinator.release(sessionId, device.deviceId);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      const index = Number(match[3]);
      if (!Number.isSafeInteger(index) || index < 0) throw new HttpError(400, "INVALID_SEGMENT", "Segment index is invalid.");
      const file = await options.coordinator.segment(sessionId, index, request.signal);
      const releasePin = options.cache.pinServed(session.cacheKey, index);
      let released = false;
      const release = () => { if (!released) { released = true; releasePin(); } };
      const source = createReadStream(file.path);
      source.once("close", release);
      source.once("error", release);
      const body = Readable.toWeb(source) as ReadableStream<Uint8Array>;
      return new Response(new ReadableStream({
        start(controller) {
          const reader = body.getReader();
          const pump = (): void => { void reader.read().then(({ done, value }) => { if (done) { release(); controller.close(); return; } controller.enqueue(value); pump(); }, (error) => { release(); controller.error(error); }); };
          pump();
        },
        cancel() { release(); source.destroy(); },
      }), {
        status: 200,
        headers: {
          "content-type": "video/mp2t",
          "content-length": String(file.sizeBytes),
          "cache-control": "private, max-age=3600, immutable",
          "cross-origin-resource-policy": "same-origin",
          "referrer-policy": "no-referrer",
        },
      });
    } catch (error) {
      const mapped = mapError(error);
      return errorResponse(mapped.toApiError(), mapped.status, mapped.responseHeaders);
    }
  };
}

function playlist(value: string) { return new Response(value, { status: 200, headers: PLAYLIST_HEADERS }); }
function requireOrigin(request: Request, origin: string) { if (request.headers.get("origin") !== origin) throw new HttpError(403, "ORIGIN_INVALID", "This device request was blocked."); }
function requireMethod(request: Request, action: string) { const expected = action === "heartbeat" ? "POST" : action === "release" ? "DELETE" : "GET"; if (request.method !== expected) throw new HttpError(405, "METHOD_NOT_ALLOWED", "The request method is not allowed.", undefined, { allow: expected }); }
function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof TranscodeError) {
    const status = error.code === "TRANSCODER_BUSY" ? 409 : error.code === "TRANSCODER_CACHE_FULL" ? 507 : error.code === "TRANSCODER_WINDOW_TIMEOUT" ? 504 : error.code === "TRANSCODER_SOURCE_UNAVAILABLE" ? 503 : error.code === "TRANSCODER_SESSION_EXPIRED" ? 410 : 502;
    return new HttpError(status, error.code, "Transcoded playback request failed.", error.code === "TRANSCODER_BUSY" ? 5 : undefined, error.code === "TRANSCODER_BUSY" ? { "retry-after": "5" } : undefined);
  }
  if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "DEVICE_UNAUTHORIZED") return new HttpError(401, "DEVICE_UNAUTHORIZED", "Device is not authorized.");
  if (error instanceof Error && "code" in error && String((error as { code?: unknown }).code).startsWith("ADMIN_")) return new HttpError(401, "ADMIN_UNAUTHORIZED", "Administrator authentication is required.");
  if (error instanceof Error && "code" in error) return new HttpError(401, String((error as { code: unknown }).code), "Device is not authorized.");
  return new HttpError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
}
