import { describe, expect, it } from "vitest";
import { createReadinessController, createSelfHostedApp } from "@cloudframe/server";

function named(name: string, order: string[], match: (path: string) => boolean) {
  return async (request: Request): Promise<Response | null> => {
    order.push(name);
    return match(new URL(request.url).pathname) ? new Response(name) : null;
  };
}

describe("self-hosted route order", () => {
  it("checks setup, transcode, control, and static handlers in order", async () => {
    const order: string[] = [];
    const readiness = createReadinessController();
    readiness.markReady();
    const app = createSelfHostedApp({
      readiness,
      setupApp: named("setup", order, (path) => path.startsWith("/api/setup/")),
      transcodeApp: named("transcode", order, (path) => path.startsWith("/api/tv/transcodes/")),
      controlApp: named("control", order, (path) => path === "/api/admin/snapshot"),
      staticApp: named("static", order, () => true),
    });

    await expect(app(new Request("https://app.test/api/admin/snapshot")).then((response) => response.text()))
      .resolves.toBe("control");
    expect(order).toEqual(["setup", "transcode", "control"]);
  });

  it("keeps liveness available while readiness fails during drain", async () => {
    const readiness = createReadinessController();
    readiness.markReady();
    const app = createSelfHostedApp({
      readiness,
      setupApp: async () => null,
      transcodeApp: async () => null,
      controlApp: async () => null,
      staticApp: async () => null,
    });

    expect((await app(new Request("https://app.test/healthz"))).status).toBe(200);
    expect((await app(new Request("https://app.test/readyz"))).status).toBe(200);
    readiness.beginDrain();
    expect((await app(new Request("https://app.test/healthz"))).status).toBe(200);
    expect((await app(new Request("https://app.test/readyz"))).status).toBe(503);
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const readiness = createReadinessController();
    readiness.markReady();
    const app = createSelfHostedApp({
      readiness,
      setupApp: async () => null,
      transcodeApp: async () => null,
      controlApp: async () => null,
      staticApp: async () => null,
    });
    const response = await app(new Request("https://app.test/api/unknown"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
  });
});
