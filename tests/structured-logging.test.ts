import { describe, expect, it } from "vitest";
import { MemoryRepository, createApiApp } from "@cloudframe/server";

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
});
