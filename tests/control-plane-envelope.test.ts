import { createDecipheriv } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ControlPlaneEnvelopeError,
  decryptControlPlaneEnvelope,
  encryptControlPlaneDocument
} from "@cloudframe/server";
import { testAeadKeyring, testControlDocument } from "./helpers/control-plane";

function decryptPlaintext(envelope: {
  iv: string;
  ciphertext: string;
  authTag: string;
}): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    testAeadKeyring().keys.v1,
    Buffer.from(envelope.iv, "base64url")
  );
  decipher.setAAD(Buffer.from("cloudframe/control-plane/v2", "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

const invalidEnvelope = () =>
  expect.objectContaining({
    name: "ControlPlaneEnvelopeError",
    code: "CONTROL_PLANE_INVALID",
    message: "CONTROL_PLANE_INVALID"
  });

describe("encrypted control-plane envelopes", () => {
  it("round-trips a document and rejects ciphertext tampering", () => {
    const envelope = encryptControlPlaneDocument(
      testControlDocument(),
      testAeadKeyring()
    );

    expect(envelope).toMatchObject({
      envelopeVersion: 1,
      keyVersion: "v1",
      revision: 1
    });
    expect(JSON.stringify(envelope)).not.toContain("Living Room");
    expect(
      decryptControlPlaneEnvelope(envelope, testAeadKeyring().keys)
    ).toEqual(testControlDocument());
    expect(() =>
      decryptControlPlaneEnvelope(
        { ...envelope, ciphertext: `${envelope.ciphertext}A` },
        testAeadKeyring().keys
      )
    ).toThrowError(invalidEnvelope());
  });

  it("rejects a clear revision that differs from the authenticated document", () => {
    const envelope = encryptControlPlaneDocument(
      testControlDocument(),
      testAeadKeyring()
    );

    expect(() =>
      decryptControlPlaneEnvelope(
        { ...envelope, revision: envelope.revision + 1 },
        testAeadKeyring().keys
      )
    ).toThrowError(invalidEnvelope());
  });

  it("serializes equivalent documents with stable recursive key ordering", () => {
    const document = testControlDocument();
    const request = document.pendingDeviceRequests["request-1"];
    document.pendingDeviceRequests = {
      "request-2": { ...request, id: "request-2" },
      "request-1": request
    };
    const reordered = {
      roots: document.roots,
      sources: document.sources,
      pendingDeviceRequests: {
        "request-1": request,
        "request-2": { ...request, id: "request-2" }
      },
      devices: document.devices,
      household: document.household,
      updatedAt: document.updatedAt,
      revision: document.revision,
      householdId: document.householdId,
      schemaVersion: document.schemaVersion
    };

    expect(
      decryptPlaintext(encryptControlPlaneDocument(document, testAeadKeyring()))
    ).toBe(
      decryptPlaintext(encryptControlPlaneDocument(reordered, testAeadKeyring()))
    );
  });

  it("orders distinct Unicode record keys independently of locale collation", () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    const request = testControlDocument().pendingDeviceRequests["request-1"];
    const first = testControlDocument();
    first.pendingDeviceRequests = {
      [composed]: { ...request, id: composed },
      [decomposed]: { ...request, id: decomposed }
    };
    const second = testControlDocument();
    second.pendingDeviceRequests = {
      [decomposed]: { ...request, id: decomposed },
      [composed]: { ...request, id: composed }
    };

    expect(
      decryptPlaintext(encryptControlPlaneDocument(first, testAeadKeyring()))
    ).toBe(
      decryptPlaintext(encryptControlPlaneDocument(second, testAeadKeyring()))
    );
  });

  it("normalizes malformed envelopes, missing keys, and invalid documents", () => {
    const envelope = encryptControlPlaneDocument(
      testControlDocument(),
      testAeadKeyring()
    );
    const invalidDocument = testControlDocument();
    invalidDocument.updatedAt = "secret invalid timestamp";

    const attempts = [
      () => decryptControlPlaneEnvelope({ ...envelope, envelopeVersion: 2 } as never, testAeadKeyring().keys),
      () => decryptControlPlaneEnvelope({ ...envelope, extra: "secret" } as never, testAeadKeyring().keys),
      () => decryptControlPlaneEnvelope(envelope, {}),
      () => encryptControlPlaneDocument(invalidDocument, testAeadKeyring())
    ];

    for (const attempt of attempts) {
      expect(attempt).toThrowError(invalidEnvelope());
    }
    expect(new ControlPlaneEnvelopeError("CONTROL_PLANE_INVALID").message).not.toContain(
      "secret"
    );
  });

  it("does not retain caller references through encryption or decryption", () => {
    const input = testControlDocument();
    const envelope = encryptControlPlaneDocument(input, testAeadKeyring());
    input.devices["device-1"].name = "Mutated";

    const opened = decryptControlPlaneEnvelope(envelope, testAeadKeyring().keys);
    opened.devices["device-1"].name = "Opened mutation";

    expect(
      decryptControlPlaneEnvelope(envelope, testAeadKeyring().keys).devices["device-1"].name
    ).toBe("Living Room");
  });
});
