import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createNodeRequest, writeNodeResponse } from "@cloudframe/server";

async function withServer(
  handler: (request: Request) => Promise<Response>,
  operation: (origin: string) => Promise<void>,
) {
  const server = createServer((incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.once("close", () => controller.abort());
    const request = createNodeRequest(
      incoming,
      "https://configured.example",
      controller.signal,
    );
    void handler(request)
      .then((response) => writeNodeResponse(response, outgoing))
      .catch((error) => {
        outgoing.statusCode = 500;
        outgoing.end(String(error));
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address");
  try {
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

describe("Node/Web HTTP adapter", () => {
  it("streams a large request body into a Web Request", async () => {
    await withServer(
      async (request) => new Response(request.body, {
        headers: { "content-type": "application/octet-stream" },
      }),
      async (origin) => {
        const size = await fetch(`${origin}/echo`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: Buffer.alloc(256 * 1024, 7),
        }).then((response) => response.arrayBuffer())
          .then((value) => value.byteLength);
        expect(size).toBe(256 * 1024);
      },
    );
  });

  it("delivers the first response chunk before the producer finishes", async () => {
    let producedFinal = false;
    await withServer(
      async () => new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
          await new Promise((resolve) => setTimeout(resolve, 40));
          controller.enqueue(new TextEncoder().encode("-second"));
          await new Promise((resolve) => setTimeout(resolve, 40));
          producedFinal = true;
          controller.enqueue(new TextEncoder().encode("-third"));
          controller.close();
        },
      })),
      async (origin) => {
        const response = await fetch(`${origin}/stream`);
        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe("first");
        expect(producedFinal).toBe(false);
        let rest = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          rest += new TextDecoder().decode(chunk.value);
        }
        expect(rest).toBe("-second-third");
      },
    );
  });

  it("aborts the Web signal when the client disconnects", async () => {
    let observedSignal: AbortSignal | undefined;
    let resolveObserved!: (signal: AbortSignal) => void;
    const observed = new Promise<AbortSignal>((resolve) => {
      resolveObserved = resolve;
    });
    await withServer(
      async (request) => {
        observedSignal = request.signal;
        resolveObserved(request.signal);
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        return new Response(null, { status: 499 });
      },
      async (origin) => {
        const controller = new AbortController();
        const pending = fetch(`${origin}/wait`, { signal: controller.signal }).catch(() => undefined);
        await observed;
        controller.abort();
        await pending;
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(observedSignal?.aborted).toBe(true);
      },
    );
  });

  it("replaces forged peer and forwarding headers with the socket address", async () => {
    await withServer(
      async (request) => new Response(JSON.stringify({
        peer: request.headers.get("x-cloudframe-peer-address"),
        forwarded: request.headers.get("x-vercel-forwarded-for"),
        url: request.url,
      }), { headers: { "content-type": "application/json" } }),
      async (origin) => {
        const value = await fetch(`${origin}/headers?x=1`, {
          headers: {
            "x-cloudframe-peer-address": "203.0.113.9",
            "x-vercel-forwarded-for": "198.51.100.2",
            host: "forged.example",
          },
        }).then((response) => response.json()) as Record<string, string | null>;
        expect(value.peer).toBe("127.0.0.1");
        expect(value.forwarded).toBeNull();
        expect(value.url).toBe("https://configured.example/headers?x=1");
      },
    );
  });

  it("preserves repeated cookies when writing a Web response", async () => {
    const cookies: string[] = [];
    const target = {
      statusCode: 0,
      setHeader(name: string, value: string | string[]) {
        if (name.toLowerCase() === "set-cookie") cookies.push(...(Array.isArray(value) ? value : [value]));
      },
      end() {},
      once() { return this; },
    } as unknown as ServerResponse;
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");

    await writeNodeResponse(new Response(null, { status: 204, headers }), target);
    expect(cookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
});
