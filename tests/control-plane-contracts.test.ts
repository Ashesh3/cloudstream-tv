import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_LIMITS,
  type AdminSnapshotResponse,
  type TvBootstrapResponse,
  type TvBrowseItemDto,
  type TvRootDto
} from "@cloudframe/shared";

// @ts-expect-error Admin snapshots must not expose index health.
void (null as unknown as AdminSnapshotResponse["indexHealth"]);
// @ts-expect-error Admin snapshots must not expose synchronization progress.
void (null as unknown as AdminSnapshotResponse["indexProgress"]);
// @ts-expect-error Admin snapshots must not expose sync timestamps.
void (null as unknown as AdminSnapshotResponse["lastSyncCompletedAt"]);

// @ts-expect-error TV browse DTOs must not expose provider node ids.
void (null as unknown as TvBrowseItemDto["providerNodeId"]);
// @ts-expect-error TV browse DTOs must not expose provider credentials.
void (null as unknown as TvBrowseItemDto["encryptedRefreshToken"]);
// @ts-expect-error TV browse DTOs must not expose access tokens.
void (null as unknown as TvBrowseItemDto["accessToken"]);
// @ts-expect-error TV root DTOs must not expose provider root ids.
void (null as unknown as TvRootDto["providerRootId"]);
// @ts-expect-error TV bootstrap DTOs must not expose refresh tokens.
void (null as unknown as TvBootstrapResponse["refreshToken"]);

describe("v2 control-plane contracts", () => {
  it("sets the approved single-household ceilings", () => {
    expect(CONTROL_PLANE_LIMITS).toEqual({
      devices: 8,
      pendingRequests: 8,
      sources: 4,
      roots: 32,
      ancestryEntries: 64,
      visibleNameLength: 120
    });
  });

  it("keeps provider ids and credentials out of TV DTO runtime values", () => {
    const item: TvBrowseItemDto = {
      id: "item_public_id",
      handle: "sealed-item",
      name: "Lake.mp4",
      normalizedName: "lake.mp4",
      kind: "video",
      mimeType: "video/mp4",
      size: 123,
      width: 1920,
      height: 1080,
      capturedAt: null,
      createdAtProvider: null,
      modifiedAtProvider: null,
      thumbnailRevision: "7",
      hasPreview: true
    };
    expect(JSON.stringify(item)).not.toMatch(/providerNodeId|accessToken|refreshToken/);
  });

});
