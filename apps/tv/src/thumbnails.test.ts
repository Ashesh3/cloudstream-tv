// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  createThumbnailWarmer,
  thumbnailRequestBatches,
  type ThumbnailCandidate,
} from "./thumbnails";

describe("thumbnail request scheduling", () => {
  it("includes folders and every previewable loaded item without a mounted-row filter", () => {
    const items: ThumbnailCandidate[] = [
      candidate("folder", "folder", false),
      candidate("visible", "image", true),
      candidate("offscreen", "video", true),
      candidate("unpreviewable", "image", false),
    ];

    expect(thumbnailRequestBatches(items, {})).toEqual([
      [items[0], items[1], items[2]],
    ]);
  });

  it("skips an already-requested handle but requests a renewed handle for the same item", () => {
    const oldItem = candidate("photo", "image", true, "sealed-old");
    const renewedItem = candidate("photo", "image", true, "sealed-new");

    expect(thumbnailRequestBatches([oldItem], {
      photo: { requestedHandle: "sealed-old" },
    })).toEqual([]);
    expect(thumbnailRequestBatches([renewedItem], {
      photo: { requestedHandle: "sealed-old" },
    })).toEqual([[renewedItem]]);
  });

  it("bounds batches by handle count and encoded JSON body size", () => {
    const countItems = Array.from({ length: 101 }, (_, index) =>
      candidate(`item-${index}`, "image", true),
    );
    expect(thumbnailRequestBatches(countItems, {}).map(batch => batch.length)).toEqual([100, 1]);

    const longItems = Array.from({ length: 6 }, (_, index) =>
      candidate(`long-${index}`, "image", true, `sealed-${index}-${"x".repeat(180)}`),
    );
    const maxBytes = 500;
    const batches = thumbnailRequestBatches(longItems, {}, maxBytes);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const body = JSON.stringify({ handles: batch.map(item => item.handle), maxDimension: 720 });
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(maxBytes);
    }
  });
});

describe("browser thumbnail warming", () => {
  it("deduplicates URLs and assigns no-referrer before starting the image request", () => {
    const events: string[] = [];
    const images: FakeImage[] = [];
    const warmer = createThumbnailWarmer(() => {
      const image = new FakeImage(events);
      images.push(image);
      return image;
    });

    expect(warmer.warm("https://provider.example/preview")).toBe(true);
    expect(warmer.warm("https://provider.example/preview")).toBe(false);
    expect(images).toHaveLength(1);
    expect(events).toEqual([
      "referrerPolicy:no-referrer",
      "src:https://provider.example/preview",
    ]);

    images[0]!.onload?.(new Event("load"));
    expect(warmer.warm("https://provider.example/preview")).toBe(false);
  });

  it("releases retained image objects after load, error, or clear", () => {
    const images: FakeImage[] = [];
    const warmer = createThumbnailWarmer(() => {
      const image = new FakeImage([]);
      images.push(image);
      return image;
    });

    warmer.warm("https://provider.example/a");
    warmer.warm("https://provider.example/b");
    expect(warmer.retainedCount()).toBe(2);
    images[0]!.onerror?.(new Event("error"));
    expect(warmer.retainedCount()).toBe(1);
    warmer.clear();
    expect(warmer.retainedCount()).toBe(0);
    expect(images[1]!.onload).toBeNull();
    expect(images[1]!.onerror).toBeNull();
  });
});

function candidate(
  id: string,
  kind: ThumbnailCandidate["kind"],
  hasPreview: boolean,
  handle = `sealed-${id}`,
): ThumbnailCandidate {
  return { id, handle, kind, hasPreview };
}

class FakeImage {
  onload: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  #referrerPolicy = "";
  #src = "";

  constructor(private readonly events: string[]) {}

  set referrerPolicy(value: string) {
    this.#referrerPolicy = value;
    this.events.push(`referrerPolicy:${value}`);
  }

  get referrerPolicy() {
    return this.#referrerPolicy;
  }

  set src(value: string) {
    this.#src = value;
    this.events.push(`src:${value}`);
  }

  get src() {
    return this.#src;
  }
}
