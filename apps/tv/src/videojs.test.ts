// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { createVideoJsLoader } from "./videojs";

describe("Video.js progressive loader", () => {
  it("shares one successful registration attempt", async () => {
    const registry = fakeRegistry();
    const importer = vi.fn(async () => {
      registry.define("video-player");
      registry.define("media-container");
      return {};
    });
    const loadVideoJs = createVideoJsLoader(importer, registry);

    const first = loadVideoJs();
    const second = loadVideoJs();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("resolves false when registration fails so native playback can continue", async () => {
    const registry = fakeRegistry();
    const importer = vi.fn(async () => {
      throw new Error("unsupported custom element runtime");
    });
    const loadVideoJs = createVideoJsLoader(importer, registry);

    await expect(loadVideoJs()).resolves.toBe(false);
    await expect(loadVideoJs()).resolves.toBe(false);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("resolves false when only the player element registers", async () => {
    const registry = fakeRegistry();
    const importer = vi.fn(async () => {
      registry.define("video-player");
      return {};
    });
    const loadVideoJs = createVideoJsLoader(importer, registry);

    await expect(loadVideoJs()).resolves.toBe(false);
  });
});

function fakeRegistry() {
  const definitions = new Map<string, CustomElementConstructor>();
  return {
    get(name: string) {
      return definitions.get(name);
    },
    define(name: string) {
      definitions.set(name, class extends HTMLElement {});
    },
  };
}
