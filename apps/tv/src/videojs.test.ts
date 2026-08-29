// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { createVideoJsLoader } from "./videojs";

describe("Video.js progressive loader", () => {
  it("shares one successful registration attempt", async () => {
    const importer = vi.fn(async () => {
      if (!customElements.get("video-player")) {
        customElements.define("video-player", class extends HTMLElement {});
      }
      if (!customElements.get("media-container")) {
        customElements.define("media-container", class extends HTMLElement {});
      }
      return {};
    });
    const loadVideoJs = createVideoJsLoader(importer);

    const first = loadVideoJs();
    const second = loadVideoJs();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("resolves false when registration fails so native playback can continue", async () => {
    const importer = vi.fn(async () => {
      throw new Error("unsupported custom element runtime");
    });
    const loadVideoJs = createVideoJsLoader(importer);

    await expect(loadVideoJs()).resolves.toBe(false);
    await expect(loadVideoJs()).resolves.toBe(false);
    expect(importer).toHaveBeenCalledTimes(1);
  });
});
