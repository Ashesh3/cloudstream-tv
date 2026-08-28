// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlDeviceDto, ControlRootDto } from "@cloudframe/shared";
import { Devices } from "./devices";

afterEach(cleanup);
const activeRoot: ControlRootDto = { id: "root-active", sourceId: "source-1", displayName: "Family Photos", enabled: true, createdAt: "2026-08-20T00:00:00.000Z" };
const inactiveRoot: ControlRootDto = { id: "root-inactive", sourceId: "source-1", displayName: "Old Drive", enabled: false, createdAt: "2026-08-20T00:00:00.000Z" };
const device: ControlDeviceDto = { id: "device-1", name: "Living Room", enabled: true, assignedRootIds: [inactiveRoot.id], mediaOrder: null, slideshowSeconds: null, createdAt: "2026-08-20T00:00:00.000Z", approvedAt: "2026-08-20T00:00:00.000Z", revokedAt: null };

describe("device root access truth", () => {
  it("counts disabled assignments separately and never calls them active access", () => {
    render(<Devices devices={[device]} roots={[activeRoot, inactiveRoot]} onUpdate={vi.fn()} onRevoke={vi.fn()} />);
    const card = screen.getByRole("heading", { name: "Living Room" }).closest('[data-slot="card"]')!;
    expect(within(card as HTMLElement).getByText("Active folders").parentElement).toHaveTextContent("0");
    expect(within(card as HTMLElement).getByText("Access").parentElement).toHaveTextContent("No active folders");
    expect(within(card as HTMLElement).getByText("No active folders", { selector: '[data-slot="badge"]' })).toBeVisible();
    expect(within(card as HTMLElement).getByText("Inactive · Old Drive")).toBeVisible();
    expect(within(card as HTMLElement).getByText("Grants no access")).toBeVisible();
    expect(within(card as HTMLElement).queryByText("Active", { exact: true })).not.toBeInTheDocument();
  });

  it("makes stale assignment removal explicit and strips disabled IDs on save", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(<Devices devices={[device]} roots={[activeRoot, inactiveRoot]} onUpdate={update} onRevoke={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Living Room" }));
    const editor = screen.getByRole("dialog", { name: "Edit device" });
    expect(within(editor).getByText("Old Drive is inactive and grants no access. Saving removes this legacy assignment.")).toBeVisible();
    fireEvent.click(within(editor).getByRole("button", { name: "Save device" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(device.id, expect.objectContaining({ assignedRootIds: [] })));
  });
});
