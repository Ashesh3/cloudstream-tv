import { access, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const forbidden = /@vercel\/blob|@vercel\/functions|@vercel\/oidc|@google-cloud\/firestore|createVercelBlobControlStore|createVercelRuntimeControlCache|createFirestoreRecoveryMirror|requestOidcTokenSupplier|build:vercel|BLOB_STORE_ID|FIRESTORE_PROJECT_ID|GCP_WORKLOAD_IDENTITY_PROVIDER/;

describe("post-cutover cleanup", () => {
  it("removes retired platform packages, adapters, scripts, and configuration", async () => {
    const tracked = execFileSync("git", ["ls-files", "packages", "deploy", "scripts", "package.json", "packages/server/package.json", ".env.example", "Dockerfile", ".dockerignore", "compose.example.yaml"], { encoding: "utf8" })
      .split(/\r?\n/u).filter(Boolean).filter(path => !path.startsWith("docs/superpowers/"));
    for (const path of tracked) {
      if (!await access(path).then(() => true, () => false)) continue;
      expect(await readFile(path, "utf8"), path).not.toMatch(forbidden);
    }
    expect(await readFile("package-lock.json", "utf8")).not.toMatch(/node_modules\/(?:@vercel|@google-cloud\/firestore)|"@vercel\/|"@google-cloud\/firestore"/);
  });

  it("documents only self-hosted runtime configuration", async () => {
    const environment = await readFile(".env.example", "utf8");
    expect(environment).toMatch(/APP_ORIGIN=.*PORT=8080.*DATA_DIR=\/data/s);
    expect(environment).not.toMatch(/MASTER_KEY|PASSPHRASE|VERCEL|BLOB|FIRESTORE|GCP_/i);
  });
});
