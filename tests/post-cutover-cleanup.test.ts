import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("post-cutover cleanup", () => {
  it("removes the temporary legacy-cookie exchange surface", async () => {
    await expect(
      access("packages/server/src/control-plane/legacy-session-exchange.ts")
    ).rejects.toMatchObject({ code: "ENOENT" });

    for (const path of [
      ".env.example",
      "README.md",
      "deploy/api-entry.ts",
      "docs/operations/firebase-vercel-setup.md",
      "packages/server/src/http/control-app.ts",
      "packages/server/src/index.ts",
      "scripts/migrate-vercel-control-plane.ts",
      "scripts/restore-vercel-control-plane.ts"
    ]) {
      expect(await readFile(path, "utf8"), path).not.toMatch(
        /legacy-session-exchange|ENABLE_LEGACY_SESSION_EXCHANGE|GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL/
      );
    }
  });

  it("keeps the public HTTP composition free of a legacy exchange dependency", async () => {
    const source = await readFile("packages/server/src/http/control-app.ts", "utf8");
    const contracts = await readFile("packages/shared/src/contracts.ts", "utf8");
    const dependencies = source.slice(
      source.indexOf("export interface ControlApiDependencies"),
      source.indexOf("const DEFAULT_RATE_LIMITS")
    );

    expect(dependencies).not.toMatch(/LegacySession|legacySessionExchange/);
    expect(contracts).not.toMatch(/interface (?:Household|AdminSession|Device|DeviceSession)\b/);
  });
});
