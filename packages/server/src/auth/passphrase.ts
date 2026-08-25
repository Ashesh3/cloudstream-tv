import { hash, verify, type Options } from "@node-rs/argon2";

const OPTIONS = {
  algorithm: 2,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32
} satisfies Options;

export function hashPassphrase(
  passphrase: string,
  pepper: string
): Promise<string> {
  return hash(passphrase, {
    ...OPTIONS,
    secret: Buffer.from(pepper, "utf8")
  });
}

export function verifyPassphrase(
  encodedHash: string,
  passphrase: string,
  pepper: string
): Promise<boolean> {
  return verify(encodedHash, passphrase, {
    secret: Buffer.from(pepper, "utf8")
  });
}
