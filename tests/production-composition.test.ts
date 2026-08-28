import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createFirestoreClient,
  providerTokenKeyringFromEnv,
  requestOidcTokenSupplier,
  type FirestoreClientSettings,
  versionedAeadKeyringFromEnv
} from "@cloudframe/server";

describe("production control-plane composition", () => {
  it("builds separate request-bound Firestore writer and optional legacy reader identities", async () => {
    const source = await readFile("deploy/api-entry.ts", "utf8");
    expect(source).toContain('serviceAccountEmail: required(environment, "GCP_SERVICE_ACCOUNT_EMAIL")');
    expect(source).toContain('"GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL"');
    expect(source).toContain('ENABLE_LEGACY_SESSION_EXCHANGE !== "1"');
    expect(source).toContain("requestOidcTokenSupplier(request)");
    expect(source).toContain("createFirestoreRecoveryMirror(writer, householdId)");
    expect(source).not.toMatch(/FirestoreRepository|createApiApp|createIndexingService/);
  });

  it("uses the active request OIDC token for the production Firestore writer", async () => {
    const supplier = requestOidcTokenSupplier(new Request("https://app.test", {
      headers: { "x-vercel-oidc-token": "request-oidc" }
    }));
    await expect(supplier()).resolves.toBe("request-oidc");
    await expect(requestOidcTokenSupplier(new Request("https://app.test"))()).rejects.toThrow(/unavailable/i);

    let captured: FirestoreClientSettings | undefined;
    const client = createFirestoreClient(
      {
        environment: "production",
        projectId: "cloudframe-prod",
        workloadIdentityProvider: "projects/1/locations/global/workloadIdentityPools/vercel/providers/vercel",
        serviceAccountEmail: "writer@cloudframe-prod.iam.gserviceaccount.com",
        oidcTokenSupplier: supplier
      },
      {
        createClient(settings) { captured = settings; return { kind: "writer" }; },
        getVercelOidcToken: async () => "ambient-must-not-be-used"
      }
    );

    expect(client).toEqual({ kind: "writer" });
    expect(captured?.credentials).toMatchObject({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/vercel/providers/vercel",
      service_account_impersonation_url: expect.stringContaining("writer%40cloudframe-prod.iam.gserviceaccount.com")
    });
    if (!captured?.credentials || !("subject_token_supplier" in captured.credentials)) {
      throw new Error("Expected workload identity credentials");
    }
    await expect(captured.credentials.subject_token_supplier.getSubjectToken()).resolves.toBe("request-oidc");
    expect(captured.credentials).not.toHaveProperty("private_key");
  });

  it("supports the local emulator but rejects long-lived production credentials", () => {
    let captured: FirestoreClientSettings | undefined;
    createFirestoreClient(
      { environment: "local", projectId: "cloudframe-local", emulatorHost: "127.0.0.1:8080" },
      {
        createClient(settings) { captured = settings; return {}; },
        getVercelOidcToken: async () => "unused"
      }
    );
    expect(captured).toMatchObject({ host: "127.0.0.1:8080", ssl: false });
    expect(captured?.credentials).toBeUndefined();

    expect(() => createFirestoreClient(
      {
        environment: "production",
        projectId: "cloudframe-prod",
        explicitCredentials: { clientEmail: "service@example.test", privateKey: "secret" }
      },
      { createClient: () => ({}), getVercelOidcToken: async () => "unused" }
    )).toThrow(/production.*workload identity/i);
  });

  it("does not construct the legacy reader unless the exact feature flag is enabled", async () => {
    const source = await readFile("deploy/api-entry.ts", "utf8");
    const legacyFactory = vi.fn();
    const exactEnabled = source.includes('ENABLE_LEGACY_SESSION_EXCHANGE !== "1"');

    for (const value of [undefined, "", "0", "true", "01", " 1"]) {
      if (value === "1") legacyFactory();
    }

    expect(exactEnabled).toBe(true);
    expect(legacyFactory).not.toHaveBeenCalled();
  });

  it("keeps the deployed app dependencies free of read-capable Firestore types", async () => {
    const source = await readFile("packages/server/src/http/control-app.ts", "utf8");
    const dependencies = source.slice(
      source.indexOf("export interface ControlApiDependencies"),
      source.indexOf("const DEFAULT_RATE_LIMITS")
    );
    expect(dependencies).not.toMatch(/Firestore|Repository|LegacySessionReader/);
    expect(dependencies).toContain("legacySessionExchange?: LegacySessionExchange");
  });

  it("loads exact-case current and historical key versions", () => {
    const first = Buffer.alloc(32, 1).toString("base64url");
    const second = Buffer.alloc(32, 2).toString("base64url");
    expect(versionedAeadKeyringFromEnv({
      SESSION_KEY_VERSION: "MiXeD",
      SESSION_KEY_MiXeD: first,
      SESSION_KEY_old: second
    }, "SESSION_KEY")).toMatchObject({
      currentVersion: "MiXeD",
      keys: { MiXeD: expect.any(Uint8Array), old: expect.any(Uint8Array) }
    });
    expect(providerTokenKeyringFromEnv({
      PROVIDER_TOKEN_KEY_VERSION: "v1",
      PROVIDER_TOKEN_KEY_v1: first
    }).currentVersion).toBe("v1");
  });

  it("rejects missing current aliases and case-colliding versions", () => {
    const key = Buffer.alloc(32, 1).toString("base64url");
    expect(() => versionedAeadKeyringFromEnv({
      CONTROL_PLANE_KEY_VERSION: "v1",
      CONTROL_PLANE_KEY_V1: key
    }, "CONTROL_PLANE_KEY")).toThrow("CONTROL_PLANE_KEY_INVALID");
    expect(() => providerTokenKeyringFromEnv({
      PROVIDER_TOKEN_KEY_VERSION: "V1",
      PROVIDER_TOKEN_KEY_V1: key,
      PROVIDER_TOKEN_KEY_v1: key
    })).toThrow("PROVIDER_TOKEN_KEY_INVALID");
  });
});
