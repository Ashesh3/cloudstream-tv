// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssignedRootDto, DeviceDto, SourceDto } from "@cloudframe/shared";
import { HouseholdProgram } from "./household-program";

afterEach(cleanup);

const source: SourceDto = {
  id: "source-1", provider: "google", accountLabel: "Home Drive", status: "syncing", accessTokenExpiresAt: null, nextSyncAt: null, lastSyncStartedAt: null, lastSyncCompletedAt: null, lastSyncErrorCode: null,
  indexProgress: { mode: "initial", processedNodeCount: 42, pendingFolderCount: 3, reconciliationActive: false }, createdAt: "2026-08-20T00:00:00.000Z", providerRootId: "provider-root",
  indexState: { kind: "indexing", processedNodeCount: 42, pendingFolderCount: 3, recoverable: true, errorCode: null }
};
const roots: AssignedRootDto[] = [
  { id: "root-albums", sourceId: source.id, providerNodeId: "albums", displayName: "Albums", ancestryProviderIds: ["provider-root"], enabled: true, createdAt: source.createdAt },
  { id: "root-legacy", sourceId: source.id, providerNodeId: "provider-root", displayName: "My Drive", ancestryProviderIds: [], enabled: true, createdAt: source.createdAt }
];
const devices: DeviceDto[] = [{ id: "tv-1", name: "Living Room", enabled: true, assignedRootIds: ["root-albums", "root-legacy"], mediaOrder: null, slideshowSeconds: null, createdAt: source.createdAt, approvedAt: source.createdAt, lastSeenAt: source.createdAt, revokedAt: null }];

describe("household program", () => {
  it("shows indexing truth, assigned televisions, and an explicit legacy whole-drive warning", () => {
    render(<HouseholdProgram source={source} roots={roots} devices={devices} onRemove={vi.fn()} />);

    expect(screen.getByText("Indexing selected folders")).toBeVisible();
    expect(screen.getByText("42 items prepared")).toBeVisible();
    expect(screen.getAllByText("Living Room")).toHaveLength(2);
    expect(screen.getByText("Entire My Drive")).toBeVisible();
    expect(screen.getByText("Legacy whole-drive selection")).toBeVisible();
  });

  it("routes destructive actions through removal impact review", () => {
    const onRemove = vi.fn();
    render(<HouseholdProgram source={source} roots={[roots[0]!]} devices={devices} onRemove={onRemove} />);

    fireEvent.click(screen.getByRole("button", { name: "Review removal impact for Albums" }));
    expect(onRemove).toHaveBeenCalledWith(roots[0]);
  });
});
