import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const INTERNAL_PEER_HEADER = "x-cloudframe-peer-address";
const INTERNAL_TARGET_HEADER = "x-cloudframe-request-target";

export function createNodeRequest(
  request: IncomingMessage,
  appOrigin: string,
  signal: AbortSignal,
): Request {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  request.once("aborted", abort);
  request.socket.once("close", abort);

  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (!name || value === undefined) continue;
    const lower = name.toLowerCase();
    if (
      lower === INTERNAL_PEER_HEADER ||
      lower === INTERNAL_TARGET_HEADER
    ) continue;
    headers.append(name, value);
  }
  const peer = normalizePeerAddress(request.socket.remoteAddress);
  if (peer) headers.set(INTERNAL_PEER_HEADER, peer);
  headers.set(INTERNAL_TARGET_HEADER, request.url ?? "/");

  const method = request.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    signal: controller.signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(new URL(request.url ?? "/", appOrigin), init);
}

export async function writeNodeResponse(
  response: Response,
  target: ServerResponse,
): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") target.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) target.setHeader("set-cookie", cookies);

  if (target.req?.method === "HEAD" || response.body === null) {
    target.end();
    return;
  }

  const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  let settled = false;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    target.once("finish", finish);
    target.once("error", fail);
    source.once("error", fail);
    target.once("close", () => {
      if (!target.writableFinished) {
        source.destroy();
        void response.body?.cancel().catch(() => undefined);
      }
      finish();
    });
    source.pipe(target);
  });
}

function normalizePeerAddress(value: string | undefined): string | null {
  if (!value) return null;
  const unwrapped = value.startsWith("::ffff:") ? value.slice(7) : value;
  return unwrapped.length <= 64 && isIP(unwrapped) !== 0 ? unwrapped : null;
}
