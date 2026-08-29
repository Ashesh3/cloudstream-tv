import { describe, expect, it, vi } from "vitest";
import {
  InstallationServiceError,
  createInstallationApiApp,
  type InstallationService,
  type RuntimeRateLimiter,
} from "@cloudframe/server";

const ORIGIN = "https://tv.example.com";
const validBody = {
  setupCode: "AQEBAQEBAQEBAQEBAQEBAQ",
  passphrase: "correct horse battery staple",
};

function harness() {
  const service: InstallationService = {
    status: vi.fn().mockResolvedValue({ state: "unconfigured" }),
    claim: vi.fn().mockResolvedValue({ configured: true }),
  };
  const rateLimiter: RuntimeRateLimiter = {
    consume: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 4,
      retryAfterSeconds: 60,
    }),
  };
  const app = createInstallationApiApp({
    service,
    rateLimiter,
    allowedOrigin: ORIGIN,
    requestSubject: () => "203.0.113.7",
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });
  return { app, rateLimiter, service };
}

function request(path: string, method = "GET", body?: unknown, origin?: string) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(origin === undefined ? {} : { origin }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("installation HTTP boundary", () => {
  it("returns no-store status and lets non-setup routes continue", async () => {
    const { app } = harness();
    const response = await app(request("/api/setup/status"));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    await expect(response?.json()).resolves.toEqual({
      ok: true,
      data: { state: "unconfigured" },
    });
    await expect(app(request("/api/admin/snapshot"))).resolves.toBeNull();
  });

  it("claims only with the exact origin and exact JSON body", async () => {
    const { app, rateLimiter, service } = harness();

    const accepted = await app(request("/api/setup/claim", "POST", validBody, ORIGIN));
    expect(accepted?.status).toBe(200);
    await expect(accepted?.json()).resolves.toEqual({
      ok: true,
      data: { configured: true },
    });
    expect(rateLimiter.consume).toHaveBeenCalledWith(
      "setup-claim",
      "203.0.113.7",
      new Date("2026-08-29T12:00:00.000Z"),
      { limit: 5, windowSeconds: 900 },
    );
    expect(service.claim).toHaveBeenCalledWith(validBody);

    for (const origin of [undefined, "https://other.example.com", `${ORIGIN}/`]) {
      const denied = await app(request("/api/setup/claim", "POST", validBody, origin));
      expect(denied?.status).toBe(403);
      await expect(denied?.json()).resolves.toMatchObject({ code: "ORIGIN_INVALID" });
    }
  });

  it.each([
    ["/api/setup/status?extra=1", "GET", undefined, undefined, 400, "INVALID_QUERY"],
    ["/api/setup/status", "POST", {}, ORIGIN, 405, "METHOD_NOT_ALLOWED"],
    ["/api/setup/claim?extra=1", "POST", validBody, ORIGIN, 400, "INVALID_QUERY"],
    ["/api/setup/claim", "GET", undefined, undefined, 405, "METHOD_NOT_ALLOWED"],
    ["/api/setup/claim", "POST", { setupCode: validBody.setupCode }, ORIGIN, 400, "INVALID_REQUEST"],
    ["/api/setup/claim", "POST", { ...validBody, extra: true }, ORIGIN, 400, "INVALID_REQUEST"],
  ] as const)("rejects invalid route input %#", async (path, method, body, origin, status, code) => {
    const { app } = harness();
    const response = await app(request(path, method, body, origin));

    expect(response?.status).toBe(status);
    await expect(response?.json()).resolves.toMatchObject({ code });
  });

  it("maps rate limits and installation errors to stable responses", async () => {
    const limited = harness();
    vi.mocked(limited.rateLimiter.consume).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 42,
    });
    const limitedResponse = await limited.app(
      request("/api/setup/claim", "POST", validBody, ORIGIN),
    );
    expect(limitedResponse?.status).toBe(429);
    expect(limitedResponse?.headers.get("retry-after")).toBe("42");
    await expect(limitedResponse?.json()).resolves.toMatchObject({ code: "RATE_LIMITED" });

    const cases = [
      ["INSTALLATION_ALREADY_CONFIGURED", 409],
      ["SETUP_CODE_INVALID", 401],
      ["INVALID_PASSPHRASE", 400],
      ["CONTROL_PLANE_UNAVAILABLE", 503],
    ] as const;
    for (const [code, status] of cases) {
      const current = harness();
      vi.mocked(current.service.claim).mockRejectedValueOnce(
        new InstallationServiceError(code),
      );
      const response = await current.app(
        request("/api/setup/claim", "POST", validBody, ORIGIN),
      );
      expect(response?.status).toBe(status);
      await expect(response?.json()).resolves.toMatchObject({ code });
    }
  });
});
