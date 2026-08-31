// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("admin styling entry", () => {
  it("ships the Astryx theme without loading the superseded Admin stylesheet or display font", () => {
    const entry = readFileSync(resolve(process.cwd(), "apps/admin/src/main.tsx"), "utf8");
    expect(entry).toContain("@astryxdesign/core/astryx.css");
    expect(entry).toContain("@cloudframe/theme/cloudframe-night.css");
    expect(entry).not.toContain("./styles/app.css");
    expect(entry).not.toContain("archivo-narrow");
  });
});
