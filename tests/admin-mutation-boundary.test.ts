import { describe, expect, it } from "vitest";
import { verifyAdminMutation } from "@cloudframe/server";
import type { AuthenticatedAdmin } from "@cloudframe/server";

const authenticated: AuthenticatedAdmin = {
  session: {
    id: "session-1", householdId: "household-1", tokenHash: "hash", passphraseVersion: 1,
    createdAt: new Date(0), lastSeenAt: new Date(0), expiresAt: new Date(1), revokedAt: null
  },
  csrfToken: "expected-csrf",
  responseHeaders: new Headers()
};

describe("admin mutation verification boundary", () => {
  it("returns a fresh token only for a stale CSRF failure", () => {
    const request = new Request("https://cloudframe.example/api/admin/settings", {
      method: "PATCH",
      headers: { origin: "https://cloudframe.example", "x-csrf-token": "stale-csrf" }
    });
    try {
      verifyAdminMutation(request, authenticated, "https://cloudframe.example");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: "CSRF_INVALID" });
      expect(new Headers((error as { responseHeaders: HeadersInit }).responseHeaders).get("x-csrf-token")).toBe("expected-csrf");
    }
  });

  it("rejects a bad origin without issuing a retry token", () => {
    const request = new Request("https://cloudframe.example/api/admin/settings", {
      method: "PATCH",
      headers: { origin: "https://evil.example", "x-csrf-token": "expected-csrf" }
    });
    try {
      verifyAdminMutation(request, authenticated, "https://cloudframe.example");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: "ORIGIN_INVALID" });
      expect((error as { responseHeaders?: HeadersInit }).responseHeaders).toBeUndefined();
    }
  });
});

