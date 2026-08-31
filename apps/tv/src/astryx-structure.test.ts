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

  it("uses Cloudframe Night browse structure without obsolete screening-room language", async () => {
    const app = await readFile("apps/tv/src/app.tsx", "utf8");
    const folder = await readFile("apps/tv/src/components/folder-card.tsx", "utf8");
    const media = await readFile("apps/tv/src/components/media-card.tsx", "utf8");
    const grid = await readFile("apps/tv/src/components/virtual-grid.tsx", "utf8");
    const migrated = [app, folder, media, grid].join("\n");

    expect(app).toContain("StatePanel");
    expect(app).toContain("StateAction");
    expect(folder).toContain("cloudframe-card");
    expect(media).toContain("cloudframe-card");
    expect(grid).toContain("data-grid-focused");
    expect(grid).toContain('role="grid"');
    expect(migrated).not.toMatch(/program-stock|screening program|program projection|projection-(?:stock|cue|vignette|image)/i);
    expect(migrated).not.toMatch(/#[\da-f]{3,8}\b/i);
  });

  it("keeps the viewer on the layer-free TV media engine with Cloudframe Night presentation", async () => {
    const viewer = await readFile("apps/tv/src/components/viewer.tsx", "utf8");
    const overlay = await readFile("apps/tv/src/components/viewer-overlay.tsx", "utf8");
    const player = await readFile("apps/tv/src/components/video-player.tsx", "utf8");
    const source = [viewer, overlay, player].join("\n");
    expect(viewer).toContain("cloudframe-viewer-shell");
    expect(viewer).toContain("Item {state.index + 1}");
    expect(overlay).toContain("Now viewing");
    expect(player).toContain("video-player");
    expect(player).toContain("video-skin");
    expect(source).not.toMatch(/Lightbox|ButtonGroup|Popover|Tooltip|Now screening|Program \{state\.index/i);
  });
});
