import { createHash, randomBytes } from "node:crypto";

export interface OpaqueToken {
  raw: string;
  hash: string;
}

export function hashOpaqueToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function issueOpaqueToken(): OpaqueToken {
  const raw = randomBytes(32).toString("base64url");

  return {
    raw,
    hash: hashOpaqueToken(raw)
  };
}
