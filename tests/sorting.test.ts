import { describe, expect, it } from "vitest";

import type { MediaNode, TvBrowseItemDto } from "@cloudframe/shared";
import { selectFolderCoverNodeIds, sortBrowseItems } from "@cloudframe/shared";

describe("folder listing sorting", () => {
  it("places alphabetized folders before media sorted by captured newest", () => {
    const items = [
      item({ id: "m-old", name: "Old", kind: "image", capturedAt: iso("2024-01-01") }),
      item({ id: "f-z", name: "Zoo", kind: "folder" }),
      item({ id: "m-new", name: "New", kind: "video", capturedAt: iso("2025-01-01") }),
      item({ id: "f-a", name: "albums", kind: "folder" })
    ];

    expect(sortBrowseItems(items, "captured-desc").map(item => item.id)).toEqual([
      "f-a",
      "f-z",
      "m-new",
      "m-old"
    ]);
  });

  it("falls back from captured to created and then modified timestamps", () => {
    const items = [
      item({
        id: "modified",
        name: "Modified",
        kind: "image",
        modifiedAtProvider: iso("2025-01-01")
      }),
      item({
        id: "created",
        name: "Created",
        kind: "image",
        createdAtProvider: iso("2024-01-01"),
        modifiedAtProvider: iso("2026-01-01")
      }),
      item({
        id: "captured",
        name: "Captured",
        kind: "image",
        capturedAt: iso("2023-01-01"),
        createdAtProvider: iso("2027-01-01")
      })
    ];

    expect(sortBrowseItems(items, "captured-desc").map(item => item.id)).toEqual([
      "modified",
      "created",
      "captured"
    ]);
    expect(sortBrowseItems(items, "captured-asc").map(item => item.id)).toEqual([
      "captured",
      "created",
      "modified"
    ]);
  });

  it("keeps equal items in their original order", () => {
    const first = item({ id: "first", name: "Same", kind: "image" });
    const second = item({ id: "second", name: "same", kind: "image" });

    expect(sortBrowseItems([first, second], "name-asc").map(item => item.id)).toEqual([
      "first",
      "second"
    ]);
  });
});

describe("folder cover selection", () => {
  it("prefers newest suitable descendants without duplicate IDs", () => {
    const descendants = [
      node({ id: "duplicate", providerNodeId: "p-2", kind: "image", capturedAt: date("2025-01-02") }),
      node({ id: "duplicate", providerNodeId: "p-2-copy", kind: "image", capturedAt: date("2026-01-01") }),
      node({ id: "video", providerNodeId: "p-3", kind: "video", capturedAt: date("2025-01-03") }),
      node({ id: "no-preview", providerNodeId: "p-4", kind: "image", hasPreview: false, capturedAt: date("2027-01-01") }),
      node({ id: "folder", providerNodeId: "p-5", kind: "folder", capturedAt: date("2028-01-01") }),
      node({ id: "old", providerNodeId: "p-1", kind: "image", capturedAt: date("2025-01-01") })
    ];

    expect(selectFolderCoverNodeIds(descendants)).toEqual([
      "duplicate",
      "video",
      "old"
    ]);
  });

  it("uses provider ID as the final stable tie-breaker", () => {
    const descendants = [
      node({ id: "z", providerNodeId: "provider-z", kind: "image", capturedAt: date("2025-01-01") }),
      node({ id: "a", providerNodeId: "provider-a", kind: "image", capturedAt: date("2025-01-01") }),
      node({ id: "m", providerNodeId: "provider-m", kind: "image", capturedAt: date("2025-01-01") })
    ];

    expect(selectFolderCoverNodeIds(descendants)).toEqual(["a", "m", "z"]);
  });

  it("returns no covers when the requested limit is zero", () => {
    expect(
      selectFolderCoverNodeIds(
        [node({ id: "cover", kind: "image", capturedAt: date("2025-01-01") })],
        0
      )
    ).toEqual([]);
  });
});

function date(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function iso(value: string): string {
  return date(value).toISOString();
}

function item(
  overrides: Partial<TvBrowseItemDto> & Pick<TvBrowseItemDto, "id" | "kind">
): TvBrowseItemDto {
  const { id, kind, ...optional } = overrides;
  const name = optional.name ?? id;
  return {
    id,
    handle: `handle-${id}`,
    name,
    normalizedName: name.toLocaleLowerCase("en"),
    kind,
    mimeType: kind === "folder" ? null : `${kind}/synthetic`,
    size: null,
    width: null,
    height: null,
    capturedAt: null,
    createdAtProvider: null,
    modifiedAtProvider: null,
    thumbnailRevision: null,
    hasPreview: false,
    ...optional
  };
}

function node(overrides: Partial<MediaNode> & Pick<MediaNode, "id" | "kind">): MediaNode {
  const { id, kind, ...optional } = overrides;
  return {
    id,
    householdId: "h1",
    sourceId: "s1",
    provider: "google",
    providerNodeId: optional.providerNodeId ?? id,
    parentNodeId: "parent",
    ancestorNodeIds: ["parent"],
    name: optional.name ?? id,
    normalizedName: (optional.name ?? id).toLocaleLowerCase("en"),
    kind,
    mimeType: null,
    size: null,
    width: null,
    height: null,
    capturedAt: null,
    createdAtProvider: null,
    modifiedAtProvider: null,
    thumbnailRevision: "revision",
    hasPreview: true,
    folderCoverNodeIds: [],
    childFolderCount: 0,
    childMediaCount: 0,
    available: true,
    indexedAt: date("2026-08-26"),
    ...optional
  };
}
