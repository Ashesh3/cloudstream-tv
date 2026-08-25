import type { AdminSession } from "@cloudframe/shared";
import { hashOpaqueToken, verifyPassphrase } from "@cloudframe/server";
import { describe, expect, it } from "vitest";
import {
  cookieHeader,
  cookieValue,
  createTestApi,
  jsonRequest,
  setCookies
} from "./helpers/api";

const PASSPHRASE = "correct horse battery staple";

describe("HTTP bootstrap and admin authentication", () => {
  it("bootstraps the configured household only when it is absent", async () => {
    const { app, repository, householdId, pepper } = await createTestApi({
      bootstrapHousehold: false
    });

    const response = await app(jsonRequest("/api/bootstrap", "GET"));

    expect(response.status).toBe(200);
    const household = await repository.getHousehold(householdId);
    expect(household).toBeTruthy();
    await expect(
      verifyPassphrase(household!.adminPassphraseHash, PASSPHRASE, pepper)
    ).resolves.toBe(true);
    expect(JSON.stringify(await response.json())).not.toContain("adminPassphraseHash");
  });

  it("never overwrites an existing household from the bootstrap environment", async () => {
    const { app } = await createTestApi({
      storedPassphrase: PASSPHRASE,
      initialPassphrase: "a different bootstrap secret"
    });
    await app(jsonRequest("/api/bootstrap", "GET"));

    const original = await app(
      jsonRequest("/api/admin/login", "POST", { passphrase: PASSPHRASE })
    );
    const environment = await app(
      jsonRequest("/api/admin/login", "POST", {
        passphrase: "a different bootstrap secret"
      })
    );

    expect(original.status).toBe(200);
    expect(environment.status).toBe(401);
  });

  it.each([undefined, "short"])(
    "fails safely when an absent household has invalid bootstrap configuration",
    async initialPassphrase => {
      const { app, repository, householdId } = await createTestApi({
        bootstrapHousehold: false,
        initialPassphrase
      });
      const response = await app(jsonRequest("/api/bootstrap", "GET"));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "BOOTSTRAP_NOT_CONFIGURED"
      });
      expect(await repository.getHousehold(householdId)).toBeNull();
    }
  );

  it("logs in with an opaque 365-day cookie and returns a memory-only CSRF token", async () => {
    const { app, repository, now } = await createTestApi();
    const response = await app(
      jsonRequest("/api/admin/login", "POST", { passphrase: PASSPHRASE })
    );

    expect(response.status).toBe(200);
    const raw = cookieValue(response, "admin_session");
    expect(raw).toBeTruthy();
    expect(setCookies(response).join("\n")).toMatch(
      /admin_session=.*HttpOnly; Secure; SameSite=Lax/
    );
    expect(response.headers.get("x-csrf-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(await repository.getAdminSessionByHash(hashOpaqueToken(raw!))).toMatchObject({
      expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      tokenHash: hashOpaqueToken(raw!)
    });
  });

  it("returns safe structured errors for invalid credentials and malformed bodies", async () => {
    const { app } = await createTestApi();
    const invalid = await app(
      jsonRequest("/api/admin/login", "POST", { passphrase: "not the secret" })
    );
    expect(invalid.status).toBe(401);
    const invalidBody = await invalid.json();
    expect(invalidBody).toEqual({
      code: "INVALID_CREDENTIALS",
      message: "The passphrase is incorrect."
    });
    expect(JSON.stringify(invalidBody)).not.toContain("not the secret");

    const malformed = await app(
      new Request("https://dev.cloudframe.example/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      })
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ code: "INVALID_JSON" });
  });

  it("requires exact Origin and CSRF validation for every authenticated admin mutation", async () => {
    const { app, origin } = await createTestApi();
    const login = await app(
      jsonRequest("/api/admin/login", "POST", { passphrase: PASSPHRASE })
    );
    const raw = cookieValue(login, "admin_session")!;
    const csrf = login.headers.get("x-csrf-token")!;
    const baseHeaders = { cookie: cookieHeader(["admin_session", raw]) };

    for (const headers of [
      baseHeaders,
      { ...baseHeaders, origin: "https://evil.example", "x-csrf-token": csrf },
      { ...baseHeaders, origin }
    ]) {
      const response = await app(
        jsonRequest("/api/admin/logout", "POST", {}, headers)
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "ADMIN_MUTATION_FORBIDDEN"
      });
    }

    const success = await app(
      jsonRequest("/api/admin/logout", "POST", {}, {
        ...baseHeaders,
        origin,
        "x-csrf-token": csrf
      })
    );
    expect(success.status).toBe(200);
    expect(setCookies(success).some(value => /admin_session=;.*Max-Age=0/.test(value))).toBe(true);
  });

  it("rejects expired, revoked, cross-household, and stale-passphrase sessions", async () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    const cases: Array<Partial<AdminSession>> = [
      { expiresAt: now },
      { revokedAt: new Date(now.getTime() - 1) },
      { householdId: "another-household" },
      { passphraseVersion: 2 }
    ];

    for (const override of cases) {
      const { app, repository, householdId } = await createTestApi({ now });
      const raw = `session-${JSON.stringify(override)}`;
      await repository.putAdminSession({
        id: `admin-${cases.indexOf(override)}`,
        householdId,
        tokenHash: hashOpaqueToken(raw),
        passphraseVersion: 1,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        ...override
      });
      const response = await app(
        jsonRequest("/api/admin/requests", "GET", undefined, {
          cookie: cookieHeader(["admin_session", raw])
        })
      );
      expect(response.status).toBe(401);
      expect(setCookies(response).some(value => /admin_session=;.*Max-Age=0/.test(value))).toBe(true);
    }
  });

  it("renews an admin cookie and record only within the final 30 days", async () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    const { app, repository, householdId } = await createTestApi({ now });
    const raw = "renew-admin-session";
    await repository.putAdminSession({
      id: "admin-renew",
      householdId,
      tokenHash: hashOpaqueToken(raw),
      passphraseVersion: 1,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000),
      revokedAt: null
    });

    const response = await app(
      jsonRequest("/api/admin/requests", "GET", undefined, {
        cookie: cookieHeader(["admin_session", raw])
      })
    );

    expect(response.status).toBe(200);
    expect(cookieValue(response, "admin_session")).toBe(raw);
    expect(response.headers.get("x-csrf-token")).toBeTruthy();
    expect(await repository.getAdminSessionByHash(hashOpaqueToken(raw))).toMatchObject({
      expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
    });
  });

  it("rate-limits login and returns an exact Retry-After", async () => {
    const { app } = await createTestApi({
      rateLimits: { "admin-login": { limit: 1, windowSeconds: 60 } }
    });
    const headers = { "x-forwarded-for": "198.51.100.4" };
    expect((await app(jsonRequest("/api/admin/login", "POST", { passphrase: "wrong" }, headers))).status).toBe(401);
    const limited = await app(
      jsonRequest("/api/admin/login", "POST", { passphrase: PASSPHRASE }, headers)
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toEqual({
      code: "RATE_LIMITED",
      message: "Too many requests. Try again later.",
      retryAfterSeconds: 60
    });
  });

  it("does not let spoofed x-forwarded-for values evade a fixed client identity", async () => {
    const { app } = await createTestApi({
      rateLimits: { "admin-login": { limit: 1, windowSeconds: 60 } },
      requestSubject: () => "trusted-platform-client"
    });

    const first = await app(
      jsonRequest(
        "/api/admin/login",
        "POST",
        { passphrase: "wrong" },
        { "x-forwarded-for": "198.51.100.10" }
      )
    );
    const second = await app(
      jsonRequest(
        "/api/admin/login",
        "POST",
        { passphrase: "wrong" },
        { "x-forwarded-for": "203.0.113.99" }
      )
    );

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
  });

  it("distinguishes platform-owned Vercel client identities", async () => {
    const { app } = await createTestApi({
      rateLimits: { "admin-login": { limit: 1, windowSeconds: 60 } }
    });

    const first = await app(
      jsonRequest(
        "/api/admin/login",
        "POST",
        { passphrase: "wrong" },
        { "x-vercel-forwarded-for": "198.51.100.10, 10.0.0.1" }
      )
    );
    const second = await app(
      jsonRequest(
        "/api/admin/login",
        "POST",
        { passphrase: "wrong" },
        { "x-vercel-forwarded-for": "203.0.113.99" }
      )
    );

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
  });

  it("supports an injected local client-identity boundary", async () => {
    const { app } = await createTestApi({
      rateLimits: { "admin-login": { limit: 1, windowSeconds: 60 } },
      requestSubject: request => request.headers.get("x-test-client") ?? "unknown"
    });

    const first = await app(
      jsonRequest(
        "/api/admin/login",
        "POST",
        { passphrase: "wrong" },
        { "x-test-client": "client-a" }
      )
    );
    const second = await app(
      jsonRequest(
        "/api/admin/login",
        "POST",
        { passphrase: "wrong" },
        { "x-test-client": "client-b" }
      )
    );

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
  });

  it("uses consistent safe errors for unknown endpoints and wrong methods", async () => {
    const { app } = await createTestApi();
    const missing = await app(jsonRequest("/api/does-not-exist", "GET"));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "The requested endpoint does not exist."
    });
    const wrongMethod = await app(jsonRequest("/api/bootstrap", "POST", {}));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
  });
});
