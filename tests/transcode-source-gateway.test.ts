import { describe, expect, it, vi } from "vitest";
import {
  createTranscodeSourceGateway,
  type AuthorizedBrowseItem,
  type TranscodeSourceBinding,
} from "@cloudframe/server";

const binding: TranscodeSourceBinding = {
  householdId: "h1", deviceId: "device-1", deviceSessionVersion: 1,
  sourceId: "source-1", rootId: "root-1", rootProviderNodeId: "provider-root",
  providerNodeId: "video-1", provider: "google", itemId: "item-1",
  name: "MOV00516.MPG", mimeType: "video/mpeg", size: 12_345,
  contentRevision: "revision-7", credentialVersion: 1,
};

const item = {
  id: binding.itemId,
  source: { id: "source-1", provider: "google" },
  claims: { providerNodeId: "video-1" },
} as AuthorizedBrowseItem;

function response(body: BodyInit | null, init: ResponseInit & { url: string }) {
  const value = new Response(body, init);
  Object.defineProperty(value, "url", { value: init.url });
  return value;
}

function harness(fetcher: typeof fetch = vi.fn(async (_input, init) => {
  const range = new Headers(init?.headers).get("range");
  if (init?.method === "HEAD") return response(null, { status: 200, url: "https://www.googleapis.com/drive/v3/files/video-1?alt=media&supportsAllDrives=true", headers: { "content-length": "100", "content-type": "video/mpeg", "accept-ranges": "bytes" } });
  if (range === "bytes=10-19") return response(Buffer.alloc(10, 7), { status: 206, url: "https://www.googleapis.com/drive/v3/files/video-1?alt=media&supportsAllDrives=true", headers: { "content-range": "bytes 10-19/100", "content-length": "10", "content-type": "video/mpeg", "accept-ranges": "bytes", etag: '"v1"', "last-modified": "Sat, 29 Aug 2026 00:00:00 GMT" } });
  return response(Buffer.alloc(100, 3), { status: 200, url: "https://www.googleapis.com/drive/v3/files/video-1?alt=media&supportsAllDrives=true", headers: { "content-length": "100", "content-type": "video/mpeg" } });
}) as typeof fetch) {
  let refresh = false;
  const mediaSources = {
    resolve: vi.fn(async (_item: AuthorizedBrowseItem, options?: { refresh?: boolean }) => {
      refresh = options?.refresh === true;
      return {
        item,
        provider: "google" as const,
        credentialVersion: 1,
        request: {
          url: "https://www.googleapis.com/drive/v3/files/video-1?alt=media&supportsAllDrives=true",
          headers: new Headers({ authorization: `Bearer ${refresh ? "refreshed" : "initial"}` }),
          expiresAt: new Date(Date.now() + 60_000),
        },
      };
    }),
  };
  const authorizer = {
    withReauthorizedItem: vi.fn(async (_binding: TranscodeSourceBinding, operation: (item: AuthorizedBrowseItem) => Promise<unknown>) => operation(item)),
  };
  const logs: unknown[] = [];
  const gateway = createTranscodeSourceGateway({
    authorizer: authorizer as never,
    mediaSources,
    fetch: fetcher,
    now: () => new Date(),
    randomBytes: (size) => Buffer.alloc(size, 5),
    log: (event) => logs.push(event),
  });
  return { gateway, fetcher, mediaSources, authorizer, logs };
}

describe("loopback transcode source gateway", () => {
  it("serves GET, HEAD, and one exact byte range without exposing provider credentials", async () => {
    const current = harness();
    const { origin } = await current.gateway.start();
    try {
      const grant = current.gateway.grant(binding, "job_" + "a".repeat(32));
      expect(grant.inputUrl).toBe(`${origin}/source/${grant.capability}`);

      const head = await fetch(grant.inputUrl, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("100");
      const ranged = await fetch(grant.inputUrl, { headers: { range: "bytes=10-19" } });
      expect(ranged.status).toBe(206);
      expect(Buffer.from(await ranged.arrayBuffer())).toEqual(Buffer.alloc(10, 7));
      expect(ranged.headers.get("content-range")).toBe("bytes 10-19/100");
      expect(ranged.headers.get("etag")).toBe('"v1"');
      expect(JSON.stringify(current.logs)).not.toMatch(/initial|refreshed|googleapis|capability/);
    } finally { await current.gateway.close(); }
  });

  it("passes through provider 416 and retries 401 exactly once with refreshed authorization", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(null, { status: 416, url: "https://www.googleapis.com/drive/v3/files/video-1?alt=media&supportsAllDrives=true", headers: { "content-range": "bytes */100" } }))
      .mockResolvedValueOnce(response(null, { status: 401, url: "https://www.googleapis.com/drive/v3/files/video-1?alt=media&supportsAllDrives=true" }))
      .mockResolvedValueOnce(response("ok", { status: 200, url: "https://www.googleapis.com/drive/v3/files/video-1?alt=media&supportsAllDrives=true" }));
    const current = harness(fetcher as typeof fetch);
    const { origin } = await current.gateway.start();
    try {
      const first = current.gateway.grant(binding, "job_" + "a".repeat(32));
      expect((await fetch(first.inputUrl, { headers: { range: "bytes=100-" } })).status).toBe(416);
      const second = current.gateway.grant(binding, "job_" + "b".repeat(32));
      expect(await fetch(second.inputUrl).then((value) => value.text())).toBe("ok");
      expect(current.mediaSources.resolve).toHaveBeenLastCalledWith(item, { refresh: true });
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally { await current.gateway.close(); }
  });

  it("streams a large body and rejects malformed methods, ranges, paths, and revoked grants", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 4; index += 1) controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    const fetcher = vi.fn(async () => response(body, { status: 200, url: "https://www.googleapis.com/drive/v3/files/video-1?alt=media&supportsAllDrives=true", headers: { "content-length": String(4 * 1024 * 1024) } }));
    const current = harness(fetcher as typeof fetch);
    const { origin } = await current.gateway.start();
    try {
      const grant = current.gateway.grant(binding, "job_" + "a".repeat(32));
      expect(await fetch(grant.inputUrl).then((value) => value.arrayBuffer()).then((value) => value.byteLength)).toBe(4 * 1024 * 1024);
      expect((await fetch(grant.inputUrl, { method: "POST" })).status).toBe(405);
      expect((await fetch(grant.inputUrl, { headers: { range: "bytes=0-1,3-4" } })).status).toBe(400);
      expect((await fetch(`${origin}/source/${grant.capability}?x=1`)).status).toBe(404);
      grant.revoke();
      expect((await fetch(grant.inputUrl)).status).toBe(404);
    } finally { await current.gateway.close(); }
  });

  it("expires grants and rejects traversal-shaped job identifiers", async () => {
    let clock = Date.now();
    const current = harness();
    current.gateway = createTranscodeSourceGateway({
      authorizer: current.authorizer as never,
      mediaSources: current.mediaSources,
      fetch: current.fetcher,
      now: () => new Date(clock),
      randomBytes: (size) => Buffer.alloc(size, 6),
    });
    const { origin } = await current.gateway.start();
    try {
      expect(() => current.gateway.grant(binding, "../wrong-job")).toThrow("TRANSCODER_PATH_INVALID");
      const grant = current.gateway.grant(binding, "job_" + "a".repeat(32));
      clock += 120_001;
      expect((await fetch(`${origin}/source/${grant.capability}`)).status).toBe(404);
    } finally { await current.gateway.close(); }
  });
});
