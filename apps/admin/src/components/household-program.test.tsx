// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlDeviceDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
import { HouseholdProgram } from "./household-program";

afterEach(cleanup);
const source: ControlSourceDto = { id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy", createdAt: "2026-08-20T00:00:00.000Z" };
const roots: ControlRootDto[] = [
  { id: "root-albums", sourceId: source.id, displayName: "Albums", enabled: true, createdAt: source.createdAt },
  { id: "root-legacy", sourceId: source.id, displayName: "Entire My Drive", enabled: false, createdAt: source.createdAt }
];
const devices: ControlDeviceDto[] = [{ id: "tv-1", name: "Living Room", enabled: true, assignedRootIds: ["root-albums", "root-legacy"], mediaOrder: null, slideshowSeconds: null, createdAt: source.createdAt, approvedAt: source.createdAt, revokedAt: null }];

describe("household program", () => {
  it("shows immediate access, assignments, and inactive legacy records without indexing readiness", () => {
    render(<HouseholdProgram source={source} roots={roots} devices={devices} onRemove={vi.fn()} />);
    expect(screen.getByText("Approved folders are available to assigned televisions immediately.")).toBeVisible();
    expect(screen.getAllByText("Living Room")).toHaveLength(2);
    expect(screen.getByText("Inactive legacy selection")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/index|ready|prepar/i);
  });
  it("keeps inactive record removal accessible", () => {
    const onRemove = vi.fn(); render(<HouseholdProgram source={source} roots={roots} devices={devices} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Review removal impact for Entire My Drive" }));
    expect(onRemove).toHaveBeenCalledWith(roots[1]);
  });
});
