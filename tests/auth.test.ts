import { describe, expect, it } from "vitest";

import {
  clearSessionCookie,
  createSessionCookie,
  decryptProviderToken,
  encryptProviderToken,
  hashPassphrase,
  issueOpaqueToken,
  verifyPassphrase
} from "@cloudframe/server";

describe("opaque tokens", () => {
  it("stores only a SHA-256 hash for an opaque session token", () => {
    const token = issueOpaqueToken();

    expect(token.raw).not.toBe(token.hash);
    expect(token.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("session cookies", () => {
  it("creates a rolling secure HTTP-only device cookie", () => {
    const cookie = createSessionCookie(
      "device",
      "secret",
      new Date("2027-08-26T00:00:00Z")
    );

    expect(cookie).toContain("device_session=secret");
    expect(cookie).toContain("Expires=Thu, 26 Aug 2027 00:00:00 GMT");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("uses lax same-site protection for every sealed session cookie", () => {
    const admin = createSessionCookie(
      "admin",
      "admin-secret",
      new Date("2027-08-26T00:00:00Z")
    );
    const request = createSessionCookie(
      "request",
      "request-secret",
      new Date("2027-08-26T00:00:00Z")
    );

    expect(admin).toContain("admin_session=admin-secret");
    expect(admin).toContain("SameSite=Lax");
    expect(request).toContain("device_request=request-secret");
    expect(request).toContain("SameSite=Lax");
  });

  it("clears the selected secure cookie immediately", () => {
    const cookie = clearSessionCookie("device");

    expect(cookie).toContain("device_session=");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("passphrases", () => {
  it("hashes and verifies a passphrase with Argon2id and a pepper", async () => {
    const encoded = await hashPassphrase("correct horse", "server-pepper");

    expect(encoded).toMatch(/^\$argon2id\$/);
    await expect(
      verifyPassphrase(encoded, "correct horse", "server-pepper")
    ).resolves.toBe(true);
    await expect(
      verifyPassphrase(encoded, "correct horse", "wrong-pepper")
    ).resolves.toBe(false);
    await expect(
      verifyPassphrase(encoded, "wrong horse", "server-pepper")
    ).resolves.toBe(false);
  });
});

describe("provider token encryption", () => {
  it("round-trips provider tokens with AES-256-GCM and a key version", () => {
    const keys = {
      currentVersion: "v2",
      keys: {
        v1: Buffer.alloc(32, 1),
        v2: Buffer.alloc(32, 2)
      }
    };

    const encrypted = encryptProviderToken("provider-secret", keys);

    expect(encrypted.keyVersion).toBe("v2");
    expect(encrypted.ciphertext).not.toContain("provider-secret");
    expect(encrypted.iv).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encrypted.authTag).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decryptProviderToken(encrypted, keys.keys)).toBe("provider-secret");
  });

  it("rejects authenticated ciphertext after tampering", () => {
    const keys = {
      currentVersion: "v1",
      keys: { v1: Buffer.alloc(32, 3) }
    };
    const encrypted = encryptProviderToken("provider-secret", keys);
    const ciphertext = Buffer.from(encrypted.ciphertext, "base64url");
    ciphertext[0] ^= 1;
    const tampered = {
      ...encrypted,
      ciphertext: ciphertext.toString("base64url")
    };

    expect(tampered.ciphertext).not.toBe(encrypted.ciphertext);
    expect(() => decryptProviderToken(tampered, keys.keys)).toThrow();
  });
});
