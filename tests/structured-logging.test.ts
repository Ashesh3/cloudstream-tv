import { describe, expect, it } from "vitest";
import { MemoryRepository, ProviderError, createApiApp } from "@cloudframe/server";
import { cookieValue, createTestApi, jsonRequest } from "./helpers/api";

describe("API structured logging", () => {
  it("emits request IDs and safe route identifiers without secrets or query values", async () => {
    const events: unknown[] = [];
    const app = createApiApp({
      repository: new MemoryRepository(),
      config: { householdId: "h1", passphrasePepper: "pepper", csrfSecret: "csrf", allowedOrigin: "https://app.test" },
      logger: { info: (event: unknown) => events.push(event), error: (event: unknown) => events.push(event) }
    });
    const response = await app(new Request("https://app.test/api/admin/sources/source-safe?token=secret", {
      method: "DELETE",
      headers: { authorization: "Bearer secret", cookie: "admin_session=secret", "x-request-id": "request-safe" }
    }));
    expect(response.headers.get("x-request-id")).toBe("request-safe");
    const serialized = JSON.stringify(events);
    expect(serialized).toContain('"requestId":"request-safe"');
    expect(serialized).toContain('"sourceId":"source-safe"');
    expect(serialized).toContain('"level":"error"');
    expect(serialized).toContain('"errorCode":"ADMIN_UNAUTHORIZED"');
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("admin_session");

    await expect(app(new Request("https://app.test/api/admin/sources/%E0%A4%A", { method: "DELETE" }))).resolves.toBeInstanceOf(Response);
    expect(JSON.stringify(events)).toContain('"sourceId":"invalid"');
  });

  it("logs only bounded unexpected error identity, never its message", async () => {
    const events: unknown[] = [];
    const repository = new MemoryRepository();
    repository.getHousehold = async () => {
      const error = Object.assign(new Error("synthetic secret provider response"), { name: "GoogleAuthError", code: "E_OIDC" });
      throw error;
    };
    const app = createApiApp({
      repository,
      config: { householdId: "h1", passphrasePepper: "pepper", csrfSecret: "csrf", allowedOrigin: "https://app.test" },
      logger: { info: event => events.push(event), error: event => events.push(event) }
    });
    await app(new Request("https://app.test/api/bootstrap"));
    const serialized = JSON.stringify(events);
    expect(serialized).toContain('"errorName":"GoogleAuthError"');
    expect(serialized).not.toContain("synthetic secret provider response");
  });

  it("logs live provider errors without provider messages, tokens, or cursor query values", async () => {
    const events: unknown[] = [];
    const harness = await createTestApi();
    const login = await harness.app(jsonRequest(
      "/api/admin/login",
      "POST",
      { passphrase: "correct horse battery staple" }
    ));
    const session = cookieValue(login, "admin_session")!;
    const app = createApiApp({
      repository: harness.repository,
      providerFolders: {
        browse: async () => {
          throw new ProviderError("PROVIDER_THROTTLED", "token=provider-secret cursor=opaque-secret", {
            retryable: true,
            retryAfterSeconds: 19
          });
        },
        resolveAncestry: async () => { throw new Error("unused"); }
      },
      config: {
        householdId: harness.householdId,
        passphrasePepper: harness.pepper,
        csrfSecret: harness.csrfSecret,
        allowedOrigin: harness.origin
      },
      logger: { info: event => events.push(event), error: event => events.push(event) }
    });

    await app(new Request(`${harness.origin}/api/admin/sources/source-safe/provider-folders?cursor=opaque-secret`, {
      headers: { cookie: `admin_session=${session}`, "x-request-id": "provider-request" }
    }));

    const serialized = JSON.stringify(events);
    expect(serialized).toContain('"errorCode":"PROVIDER_THROTTLED"');
    expect(serialized).toContain('"errorName":"ProviderError"');
    expect(serialized).not.toContain("opaque-secret");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("admin_session");
  });
});
