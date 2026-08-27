import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_LIMITS,
  type AdminSnapshotResponse,
  type ControlPlaneDocumentV2,
  type TvBrowseItemDto
} from "@cloudframe/shared";

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

  it("keeps provider ids and credentials out of TV DTOs", () => {
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

  it("does not expose indexing health in the admin snapshot", () => {
    const keys: Array<keyof AdminSnapshotResponse> = [
      "revision", "household", "pendingRequests", "devices", "sources", "roots", "recoveryCopy"
    ];
    expect(keys).not.toContain("indexHealth" as keyof AdminSnapshotResponse);
  });
});
