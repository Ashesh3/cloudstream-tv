import { execFile } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Script, createContext, type Context } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
const RAW_URL =
  "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true";
const TEST_FINGERPRINT = "3AB37G86_cgrjatvKRIjGFG9CjOZwAtQnDzLhQTUlHs";

describe("production Google media worker bundle", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it("does not restore a grant revoked while the shipped fingerprint digest is pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cloudframe-media-worker-bundle-"));
    temporaryDirectories.push(directory);
    const workerPath = join(directory, "cloudframe-media-sw.js");
    await execFileAsync(process.execPath, [
      "scripts/build-tv-media-worker.mjs",
      "--outfile",
      workerPath,
    ], { cwd: process.cwd(), windowsHide: true });
    const source = await readFile(workerPath, "utf8");

    let resolveDigest!: (value: ArrayBuffer) => void;
    const pendingDigest = new Promise<ArrayBuffer>(resolve => {
      resolveDigest = resolve;
    });
    const actualDigest = await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(RAW_URL),
    );
    const digest = vi.fn()
      .mockReturnValueOnce(pendingDigest)
      .mockImplementation((algorithm: AlgorithmIdentifier, data: BufferSource) =>
        webcrypto.subtle.digest(algorithm, data)
      );
    const providerFetch = vi.fn(async () => new Response(null, { status: 500 }));
    const clientMessages: Array<Record<string, unknown>> = [];
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const client = {
      id: "client_tv",
      postMessage(message: Record<string, unknown>) {
        clientMessages.push(message);
      },
    };
    const workerScope = {
      location: { origin: "https://tv.test" },
      clients: {
        claim: async () => undefined,
        get: async (id: string) => id === client.id ? client : undefined,
      },
      skipWaiting: async () => undefined,
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        listeners.set(type, listener);
      },
      fetch: providerFetch,
      crypto: { subtle: { digest } },
      setTimeout(callback: TimerHandler) {
        return globalThis.setTimeout(callback, 1);
      },
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
    const context = createContext({
      self: workerScope,
      crypto: workerScope.crypto,
      URL,
      Request,
      Response,
      Headers,
      TextEncoder,
      Uint8Array,
      ReadableStream,
      btoa(value: string) {
        return Buffer.from(value, "binary").toString("base64");
      },
    });
    new Script(source, { filename: "cloudframe-media-sw.js" }).runInContext(context);

    const pendingGrant = dispatchMessage(context, listeners, client, {
      type: "cloudframe-media-grant",
      requestId: "request_bundle_race",
      grant: {
        sessionId: "session_bundle_race",
        rawUrl: RAW_URL,
        fingerprint: TEST_FINGERPRINT,
        token: "ya29.bundle-test-token",
        expiresAtEpoch: Date.now() + 60_000,
        kind: "video",
        mimeType: "video/mpeg",
        size: 100,
      },
    });
    expect(digest).toHaveBeenCalledOnce();
    await dispatchMessage(context, listeners, client, {
      type: "cloudframe-media-revoke",
      sessionId: "session_bundle_race",
    });
    resolveDigest(actualDigest);
    await pendingGrant;

    expect(clientMessages.some(message =>
      message.type === "cloudframe-media-grant-ack" &&
      message.requestId === "request_bundle_race"
    )).toBe(false);
    const response = await dispatchFetch(
      listeners,
      client.id,
      new Request(RAW_URL, { headers: { range: "bytes=0-" } }),
    );
    expect(response.type).toBe("error");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(clientMessages)).not.toContain("ya29.bundle-test-token");
  }, 15_000);
});

async function dispatchMessage(
  context: Context,
  listeners: Map<string, (event: Record<string, unknown>) => void>,
  client: { id: string; postMessage(message: Record<string, unknown>): void },
  message: Record<string, unknown>,
): Promise<void> {
  const waits: Promise<unknown>[] = [];
  const data = new Script(`(${JSON.stringify(message)})`).runInContext(context) as unknown;
  listeners.get("message")?.({
    data,
    source: client,
    waitUntil(value: Promise<unknown>) {
      waits.push(Promise.resolve(value));
    },
  });
  await Promise.all(waits);
}

async function dispatchFetch(
  listeners: Map<string, (event: Record<string, unknown>) => void>,
  clientId: string,
  request: Request,
): Promise<Response> {
  let response: Promise<Response> | null = null;
  listeners.get("fetch")?.({
    request,
    clientId,
    respondWith(value: Promise<Response> | Response) {
      response = Promise.resolve(value);
    },
    waitUntil() {
      // The media runtime currently has no fetch-lifetime background work.
    },
  });
  if (!response) throw new Error(`Worker did not intercept ${request.url}`);
  return response;
}
