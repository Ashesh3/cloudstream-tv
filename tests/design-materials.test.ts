import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

describe("Cloudframe Night design contract", () => {
  it("loads one shared Astryx theme without the retired screening-room material", () => {
    const theme = readFileSync(`${root}packages/theme/src/cloudframe-night.ts`, "utf8");
    const adminEntry = readFileSync(`${root}apps/admin/src/main.tsx`, "utf8");
    const tvEntry = readFileSync(`${root}apps/tv/src/main.tsx`, "utf8");
    const tvTokens = readFileSync(`${root}apps/tv/src/styles/tokens.css`, "utf8");
    const source = [theme, adminEntry, tvEntry, tvTokens].join("\n");

    expect(theme).toContain('name: "cloudframe-night"');
    expect(theme).toContain("extends: neutralTheme");
    expect(adminEntry).toContain("cloudframeNightTheme");
    expect(tvEntry).toContain("cloudframeNightTheme");
    expect(source).not.toMatch(/program-stock|Screening Room|Cloudframe Condensed|cue orange/i);
  });

  it("documents the active self-hosted runtime without retired platform claims", () => {
    const documentation = ["PRODUCT.md", "README.md", "DESIGN.md", "docs/operations/self-hosting.md", "docs/operations/webos-acceptance.md", ".env.example"]
      .map(path => readFileSync(`${root}${path}`, "utf8"))
      .join("\n");
    for (const required of ["portable Docker image", "encrypted local SQLite", "/data", "one active TV transcode", "FFmpeg", "demand-paged HLS", "local TV watch history", "browser-side authenticated direct delivery", "read-only Google Drive and OneDrive", "explicit backup"]) expect(documentation).toContain(required);
    for (const retired of ["hosted control blob", "runtime control cache", "recovery mirror", "Mumbai API function", "Cloudframe does not transcode"]) expect(documentation).not.toContain(retired);
  });

  it("keeps the active product documentation on the direct-media boundary", () => {
    const documentation = ["PRODUCT.md", "README.md", "DESIGN.md"]
      .map(path => readFileSync(`${root}${path}`, "utf8"))
      .join("\n");
    expect(documentation).toContain("browser-side authenticated direct delivery");
    expect(documentation).toContain("Google Drive and OneDrive");
    expect(documentation).not.toMatch(/authorized same-origin range proxy|Google proxy|\/api\/tv\/google-media\//i);
  });
});
