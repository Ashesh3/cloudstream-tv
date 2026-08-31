// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("TV Astryx structure", () => {
  it("uses the shared Astryx foundation with Chromium-safe, layer-free TV surfaces", async () => {
    const entry = await readFile("apps/tv/src/main.tsx", "utf8");
    const state = await readFile("apps/tv/src/components/device-request.tsx", "utf8");
    expect(entry).toContain("@astryxdesign/core/astryx.css");
    expect(entry).toContain("cloudframeNightTheme");
    expect(entry).toContain("@astryxdesign/core/theme");
    expect(state).toContain("@astryxdesign/core/Section");
    expect(state).toContain("@astryxdesign/core/VStack");
    expect(state).not.toMatch(/program ledger|program-stock|Screening Room|booth/i);
    for (const path of ["apps/tv/src/components/device-request.tsx", "apps/tv/src/components/waiting-screen.tsx", "apps/tv/src/components/tv-header.tsx"]) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(/Popover|Tooltip|HoverCard|DropdownMenu|Selector|MobileNav/);
      expect(source, path).not.toMatch(/#[\da-f]{3,8}\b/i);
    }
  });

  it("keeps the source drawer on the explicit TV focus manager", async () => {
    const source = await readFile("apps/tv/src/components/source-drawer.tsx", "utf8");
    expect(source).toContain("data-drawer-focusable");
    expect(source).toContain("@astryxdesign/core/Section");
    expect(source).toContain("@astryxdesign/core/VStack");
    expect(source).toContain("normalizeTvKey");
    expect(source).toContain('role="dialog"');
    expect(source).not.toMatch(/@astryxdesign\/core\/(?:Dialog|MobileNav|ButtonGroup)/);
  });
});
