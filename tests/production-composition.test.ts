import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createFirestoreClient,
  providerTokenKeyringFromEnv,
  requestOidcTokenSupplier,
  type FirestoreClientSettings,
  versionedAeadKeyringFromEnv
} from "@cloudframe/server";
import { createProductionApi } from "../deploy/api-entry";

describe("production control-plane composition", () => {
  it("builds only the request-bound write-only Firestore identity", async () => {
    const source = await readFile("deploy/api-entry.ts", "utf8");
    expect(source).toContain('serviceAccountEmail: required(environment, "GCP_SERVICE_ACCOUNT_EMAIL")');
    expect(source).not.toMatch(/GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL|ENABLE_LEGACY_SESSION_EXCHANGE/);
    expect(source).toContain("requestOidcTokenSupplier(request)");
    expect(source).toContain("createFirestoreRecoveryMirror(writer, householdId)");
    expect(source).not.toContain("input.controlStore.load()");
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

  it("keeps the deployed app dependencies free of read-capable Firestore types", async () => {
    const source = await readFile("packages/server/src/http/control-app.ts", "utf8");
    const dependencies = source.slice(
      source.indexOf("export interface ControlApiDependencies"),
      source.indexOf("const DEFAULT_RATE_LIMITS")
    );
    expect(dependencies).not.toMatch(/Firestore|Repository|LegacySession/);
  });

  it("maps documented uppercase env suffixes to canonical lowercase versions", () => {
    const first = Buffer.alloc(32, 1).toString("base64url");
    const second = Buffer.alloc(32, 2).toString("base64url");
    expect(versionedAeadKeyringFromEnv({
      SESSION_KEY_VERSION: "v1",
      SESSION_KEY_V1: first,
      SESSION_KEY_OLD: second
    }, "SESSION_KEY")).toMatchObject({
      currentVersion: "v1",
      keys: { v1: expect.any(Uint8Array), old: expect.any(Uint8Array) }
    });
    expect(providerTokenKeyringFromEnv({
      PROVIDER_TOKEN_KEY_VERSION: "v1",
      PROVIDER_TOKEN_KEY_V1: first
    }).currentVersion).toBe("v1");
  });

  it("rejects missing current aliases and case-colliding versions", () => {
    const key = Buffer.alloc(32, 1).toString("base64url");
    expect(() => versionedAeadKeyringFromEnv({
      CONTROL_PLANE_KEY_VERSION: "MiXeD",
      CONTROL_PLANE_KEY_MIXED: key
    }, "CONTROL_PLANE_KEY")).toThrow("CONTROL_PLANE_KEY_INVALID");
    expect(() => providerTokenKeyringFromEnv({
      PROVIDER_TOKEN_KEY_VERSION: "V1",
      PROVIDER_TOKEN_KEY_V1: key,
      PROVIDER_TOKEN_KEY_v1: key
    })).toThrow("PROVIDER_TOKEN_KEY_INVALID");
    expect(() => versionedAeadKeyringFromEnv({
      SESSION_KEY_VERSION: "v1",
      SESSION_KEY_V1: key,
      SESSION_KEY_old: key
    }, "SESSION_KEY")).toThrow("SESSION_KEY_INVALID");
  });

  it("constructs the documented production environment with one Firestore writer", () => {
    const calls: Array<{ config: import("@cloudframe/server").FirestoreClientConfig; client: Record<string, unknown> }> = [];
    const request = new Request("https://app.test/api/bootstrap", {
      headers: { "x-vercel-oidc-token": "request-oidc" }
    });
    const app = createProductionApi(request, documentedEnvironment(), {
      createFirestoreClient(config) {
        const client = firestoreClient();
        calls.push({ config, client });
        return client as never;
      },
      waitUntil: () => undefined,
      fetch: vi.fn() as never
    });

    expect(app).toBeTypeOf("function");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.config.serviceAccountEmail).toBe("writer@cloudframe-prod.iam.gserviceaccount.com");
    for (const call of calls) {
      expect(call.config.oidcTokenSupplier).toBeTypeOf("function");
      expect(call.config.oidcTokenSupplier!()).resolves.toBe("request-oidc");
    }
  });
});

function documentedEnvironment(): NodeJS.ProcessEnv {
  const key = Buffer.alloc(32, 7).toString("base64url");
  return {
    VERCEL_ENV: "production",
    APP_ORIGIN: "https://app.test",
    HOUSEHOLD_ID: "h1",
    CONTROL_PLANE_ENV: "production",
    BLOB_STORE_ID: "store-1",
    FIRESTORE_PROJECT_ID: "cloudframe-prod",
    FIRESTORE_DATABASE_ID: "(default)",
    GCP_WORKLOAD_IDENTITY_PROVIDER: "projects/1/locations/global/workloadIdentityPools/vercel/providers/vercel",
    GCP_SERVICE_ACCOUNT_EMAIL: "writer@cloudframe-prod.iam.gserviceaccount.com",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    ONEDRIVE_CLIENT_ID: "onedrive-client",
    ONEDRIVE_CLIENT_SECRET: "onedrive-secret",
    ONEDRIVE_TENANT: "common",
    ADMIN_PASSPHRASE_PEPPER: "p".repeat(32),
    CSRF_SECRET: "c".repeat(32),
    BROWSE_ID_SECRET: "b".repeat(32),
    ROOT_ID_SECRET: "r".repeat(32),
    RATE_LIMIT_SECRET: "l".repeat(32),
    CONTROL_PLANE_KEY_VERSION: "v1",
    CONTROL_PLANE_KEY_V1: key,
    SESSION_KEY_VERSION: "v1",
    SESSION_KEY_V1: key,
    BROWSE_HANDLE_KEY_VERSION: "v1",
    BROWSE_HANDLE_KEY_V1: key,
    PROVIDER_TOKEN_KEY_VERSION: "v1",
    PROVIDER_TOKEN_KEY_V1: key
  };
}

function firestoreClient() {
  const get = async () => ({ docs: [] });
  return {
    collection() {
      return {
        doc: () => ({ set: async () => undefined, get: async () => ({ exists: false, id: "missing", data: () => undefined }) }),
        where: () => ({ limit: () => ({ get }) })
      };
    }
  };
}
