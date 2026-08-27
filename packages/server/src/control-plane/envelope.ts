import { z } from "zod";

import type { ControlPlaneDocumentV2 } from "@cloudframe/shared";
import { openJson, sealJson, type VersionedAeadKeyring } from "../crypto/aead";
import { parseControlPlaneDocument } from "./schema";

const CONTROL_PLANE_PURPOSE = "cloudframe/control-plane/v2";

export interface ControlPlaneEnvelopeV1 {
  envelopeVersion: 1;
  keyVersion: string;
  revision: number;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export class ControlPlaneEnvelopeError extends Error {
  readonly code = "CONTROL_PLANE_INVALID";

  constructor(code: "CONTROL_PLANE_INVALID") {
    super(code);
    this.name = "ControlPlaneEnvelopeError";
  }
}

const envelopeSchema = z
  .object({
    envelopeVersion: z.literal(1),
    keyVersion: z.string().regex(/^[A-Za-z0-9_-]+$/),
    revision: z.number().int().safe().positive(),
    iv: z.string().regex(/^[A-Za-z0-9_-]+$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/),
    authTag: z.string().regex(/^[A-Za-z0-9_-]+$/)
  })
  .strict();

function invalid(): ControlPlaneEnvelopeError {
  return new ControlPlaneEnvelopeError("CONTROL_PLANE_INVALID");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

export function encryptControlPlaneDocument(
  value: unknown,
  keyring: VersionedAeadKeyring
): ControlPlaneEnvelopeV1 {
  try {
    const document = parseControlPlaneDocument(value);
    const token = sealJson(CONTROL_PLANE_PURPOSE, stableValue(document), keyring);
    const [tokenVersion, keyVersion, iv, ciphertext, authTag] = token.split(".");
    if (tokenVersion !== "a1" || !keyVersion || !iv || !ciphertext || !authTag) {
      throw invalid();
    }

    return {
      envelopeVersion: 1,
      keyVersion,
      revision: document.revision,
      iv,
      ciphertext,
      authTag
    };
  } catch {
    throw invalid();
  }
}

export function decryptControlPlaneEnvelope(
  value: unknown,
  keys: Record<string, Uint8Array>
): ControlPlaneDocumentV2 {
  try {
    const envelope = envelopeSchema.parse(value);
    const token = [
      "a1",
      envelope.keyVersion,
      envelope.iv,
      envelope.ciphertext,
      envelope.authTag
    ].join(".");
    const document = openJson(
      CONTROL_PLANE_PURPOSE,
      token,
      keys,
      parseControlPlaneDocument
    );

    if (document.revision !== envelope.revision) {
      throw invalid();
    }
    return document;
  } catch {
    throw invalid();
  }
}
