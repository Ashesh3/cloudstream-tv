import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ts": "video/mp2t",
  ".webp": "image/webp",
};

export interface StaticAppOptions {
  publicRoot: string;
}

export function createStaticApp(options: StaticAppOptions) {
  const publicRoot = resolve(options.publicRoot);
  const tvIndex = resolve(publicRoot, "index.html");
  const adminIndex = resolve(publicRoot, "admin", "index.html");

  return async (request: Request): Promise<Response | null> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, HEAD", "cache-control": "no-store" },
      });
    }

    const path = safePathname(request);
    if (path instanceof Response) return path;
    const requested = path === "/" ? "index.html" : path.slice(1);
    const direct = resolve(publicRoot, requested);
    if (!inside(publicRoot, direct)) return new Response(null, { status: 404 });

    const directResponse = await serveFile(direct, publicRoot, request.method === "HEAD");
    if (directResponse) return directResponse;
    if (path.startsWith("/assets/")) return new Response(null, { status: 404 });

    const fallback = path === "/admin" || path.startsWith("/admin/")
      ? adminIndex
      : tvIndex;
    return await serveFile(fallback, publicRoot, request.method === "HEAD") ??
      new Response(null, { status: 404 });
  };
}

function safePathname(request: Request): string | Response {
  let raw: string;
  try {
    const target = request.headers.get("x-cloudframe-request-target");
    raw = target === null
      ? new URL(request.url).pathname
      : target.split("?", 1)[0]!;
  } catch {
    return new Response(null, { status: 400 });
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return new Response(null, { status: 400 });
  }
  const segments = decoded.split("/");
  if (
    segments.some((segment) => segment === "." || segment === "..") ||
    segments.some((segment) => /%2e/i.test(segment))
  ) {
    return new Response(null, { status: 400 });
  }
  return decoded;
}

async function serveFile(
  path: string,
  publicRoot: string,
  head: boolean,
): Promise<Response | null> {
  if (!inside(publicRoot, path)) return null;
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    return null;
  }
  if (!metadata.isFile()) return null;
  const extension = extname(path).toLowerCase();
  const relativePath = relative(publicRoot, path).replaceAll(sep, "/");
  const cacheControl = extension === ".html"
    ? "no-cache"
    : relativePath.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600";
  const headers = {
    "cache-control": cacheControl,
    "content-length": String(metadata.size),
    "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
  };
  if (head) return new Response(null, { status: 200, headers });
  return new Response(
    Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
    { status: 200, headers },
  );
}

function inside(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}
