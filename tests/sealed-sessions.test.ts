import { createCipheriv } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SealedValueError,
  createSealedSessionCodec,
  openJson,
  sealJson
} from "@cloudframe/server";
import { TEST_NOW, testAeadKeyring } from "./helpers/control-plane";

const invalidSealedValue = () =>
  expect.objectContaining({
    name: "SealedValueError",
    code: "SEALED_VALUE_INVALID",
    message: "SEALED_VALUE_INVALID"
  });

function sealPlaintext(purpose: string, plaintext: string): string {
  const iv = Buffer.alloc(12, 9);
  const cipher = createCipheriv("aes-256-gcm", testAeadKeyring().keys.v1, iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "a1",
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url")
  ].join(".");
}

describe("purpose-bound sealed values", () => {
  it("uses the documented token envelope and rejects another purpose", () => {
    const token = sealJson("cloudframe/test-a", { secret: "hidden" }, testAeadKeyring());

    expect(token).toMatch(/^a1\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("hidden");
    expect(
      openJson("cloudframe/test-a", token, testAeadKeyring().keys, (value) => value)
    ).toEqual({ secret: "hidden" });
    expect(() =>
      openJson("cloudframe/test-b", token, testAeadKeyring().keys, (value) => value)
    ).toThrow(invalidSealedValue());
  });

  it("collapses malformed, unknown-key, authentication, JSON, and parser failures", () => {
    const keyring = testAeadKeyring();
    const token = sealJson("cloudframe/test", { ok: true }, keyring);
    const segments = token.split(".");
    const replacement = segments[3].endsWith("A") ? "B" : "A";
    const tampered = [...segments.slice(0, 3), `${segments[3].slice(0, -1)}${replacement}`, segments[4]].join(".");
    const invalidJson = sealPlaintext("cloudframe/test", "not-json");

    const attempts = [
      () => openJson("cloudframe/test", "not-a-token", keyring.keys, (value) => value),
      () => openJson("cloudframe/test", token.replace(".v1.", ".missing."), keyring.keys, (value) => value),
      () => openJson("cloudframe/test", tampered, keyring.keys, (value) => value),
      () => openJson("cloudframe/test", invalidJson, keyring.keys, (value) => value),
      () => openJson("cloudframe/test", token, keyring.keys, () => {
        throw new Error("parser leaked a secret");
      })
    ];

    for (const attempt of attempts) {
      expect(attempt).toThrow(invalidSealedValue());
    }
    expect(() => sealJson("cloudframe/test", {}, { currentVersion: "bad", keys: { bad: Buffer.alloc(31) } }))
      .toThrow(invalidSealedValue());
    expect(new SealedValueError("SEALED_VALUE_INVALID").message).not.toContain("secret");
  });
});

describe("sealed sessions", () => {
  it("seals device claims and rejects tampering or expiry", () => {
    let now = TEST_NOW;
    const codec = createSealedSessionCodec(testAeadKeyring(), () => now);
    const token = codec.issueDevice({
      version: 2,
      householdId: "h1",
      deviceId: "d1",
      sessionVersion: 3,
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 60_000
    });

    expect(token.split(".")).toHaveLength(5);
    expect(codec.openDevice(token)).toMatchObject({ deviceId: "d1", sessionVersion: 3 });
    const replacement = token.endsWith("A") ? "B" : "A";
    expect(() => codec.openDevice(`${token.slice(0, -1)}${replacement}`)).toThrow(/invalid/i);

    now = new Date(TEST_NOW.getTime() + 60_000);
    expect(() => codec.openDevice(token)).toThrow(invalidSealedValue());
  });

  it("keeps admin, request, OAuth, and device claims in distinct purposes", () => {
    const now = TEST_NOW;
    const codec = createSealedSessionCodec(testAeadKeyring(), () => now);
    const admin = codec.issueAdmin({
      version: 2,
      householdId: "h1",
      sessionId: "admin-1",
      adminPassphraseVersion: 4,
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 60_000
    });
    const request = codec.issueRequest({
      version: 2,
      householdId: "h1",
      requestId: "request-1",
      requestSecret: "request-secret",
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 60_000
    });
    const oauth = codec.issueOAuthState({
      version: 2,
      householdId: "h1",
      adminSessionId: "admin-1",
      provider: "google",
      redirectUri: "https://app.test/api/admin/sources/google/callback",
      sourceId: "source-1",
      reconnectSourceId: "source-1",
      expectedCredentialVersion: 3,
      pkceVerifier: "pkce-verifier",
      stateHash: "state-hash",
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 60_000
    });

    expect(admin).not.toContain("admin-1");
    expect(request).not.toMatch(/request-1|request-secret/);
    expect(oauth).not.toMatch(/admin-1|google|pkce-verifier|state-hash|source-1/);
    expect(codec.openAdmin(admin)).toMatchObject({ sessionId: "admin-1", adminPassphraseVersion: 4 });
    expect(codec.openRequest(request)).toMatchObject({ requestId: "request-1", requestSecret: "request-secret" });
    expect(codec.openOAuthState(oauth)).toMatchObject({
      provider: "google",
      sourceId: "source-1",
      reconnectSourceId: "source-1",
      expectedCredentialVersion: 3
    });
    expect(() => codec.openDevice(admin)).toThrow(invalidSealedValue());
    expect(() => codec.openRequest(oauth)).toThrow(invalidSealedValue());
  });

  it("rejects invalid versions, IDs, integer fields, providers, and timestamps", () => {
    const now = TEST_NOW;
    const codec = createSealedSessionCodec(testAeadKeyring(), () => now);
    const validDevice = {
      version: 2 as const,
      householdId: "h1",
      deviceId: "d1",
      sessionVersion: 3,
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 60_000
    };

    for (const claims of [
      { ...validDevice, version: 1 },
      { ...validDevice, householdId: "" },
      { ...validDevice, deviceId: "" },
      { ...validDevice, sessionVersion: 1.5 },
      { ...validDevice, issuedAt: 1.5 },
      { ...validDevice, expiresAt: now.getTime() }
    ]) {
      expect(() => codec.issueDevice(claims as typeof validDevice)).toThrow(invalidSealedValue());
    }

    expect(() => codec.issueOAuthState({
      version: 2,
      householdId: "h1",
      adminSessionId: "admin-1",
      provider: "dropbox" as "google",
      redirectUri: "https://app.test/callback",
      sourceId: "source-1",
      pkceVerifier: "verifier",
      stateHash: "hash",
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 60_000
    })).toThrow(invalidSealedValue());
  });

  it("requires a reserved source and an exact positive reconnect version", () => {
    const now = TEST_NOW;
    const codec = createSealedSessionCodec(testAeadKeyring(), () => now);
    const valid = {
      version: 2 as const,
      householdId: "h1",
      adminSessionId: "admin-1",
      provider: "google" as const,
      redirectUri: "https://app.test/callback",
      sourceId: "source-1",
      pkceVerifier: "verifier",
      stateHash: "hash",
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 60_000
    };

    expect(codec.openOAuthState(codec.issueOAuthState(valid))).toMatchObject({
      sourceId: "source-1"
    });
    for (const claims of [
      { ...valid, sourceId: "" },
      { ...valid, expectedCredentialVersion: 1 },
      { ...valid, reconnectSourceId: "source-1" },
      {
        ...valid,
        reconnectSourceId: "source-other",
        expectedCredentialVersion: 1
      },
      {
        ...valid,
        reconnectSourceId: "source-1",
        expectedCredentialVersion: 0
      }
    ]) {
      expect(() => codec.issueOAuthState(claims as typeof valid)).toThrow(
        invalidSealedValue()
      );
    }
  });
});
