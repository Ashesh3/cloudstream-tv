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
    const row = screen.getByTestId("device-row");
    expect(row).toHaveTextContent("0 active folders");
    expect(row).toHaveTextContent("No active folders");
    expect(row).toHaveTextContent("Inactive · Old Drive");
    expect(row).toHaveTextContent("Grants no access");
    expect(document.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
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

  it("distinguishes paused, active, and inactive legacy access with visible labels", () => {
    render(<Devices devices={[{ ...device, enabled: false }, { ...device, id: "device-2", name: "Den TV", assignedRootIds: [activeRoot.id] }]} roots={[activeRoot, inactiveRoot]} onUpdate={vi.fn()} onRevoke={vi.fn()} />);
    const rows = screen.getAllByTestId("device-row");
    expect(rows[0]).toHaveTextContent("Paused");
    expect(rows[1]).toHaveTextContent("Active");
  });

  it("focuses the editor, preserves all form fields, and closes on Escape", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(<Devices devices={[{ ...device, assignedRootIds: [activeRoot.id], mediaOrder: "captured-asc", slideshowSeconds: 12 }]} roots={[activeRoot, inactiveRoot]} onUpdate={update} onRevoke={vi.fn()} />);
    const edit = screen.getByRole("button", { name: "Edit Living Room" });
    edit.focus();
    fireEvent.click(edit);
    expect(await screen.findByLabelText("Device name")).toHaveFocus();
    expect(screen.getByLabelText("Device enabled")).toBeChecked();
    expect(screen.getByLabelText("Family Photos")).toBeChecked();
    expect(screen.getByLabelText("Oldest captured first")).toBeChecked();
    expect(screen.getByLabelText("Slideshow seconds")).toHaveValue("12");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Edit device" }), { key: "Escape" });
    await waitFor(() => expect(edit).toHaveFocus());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit device" })).not.toBeInTheDocument());
    expect(update).not.toHaveBeenCalled();
  });

  it("commits a slideshow draft when Save is clicked directly", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(<Devices devices={[device]} roots={[activeRoot]} onUpdate={update} onRevoke={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Living Room" }));
    const slideshow = screen.getByLabelText("Slideshow seconds");
    fireEvent.focus(slideshow);
    fireEvent.change(slideshow, { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Save device" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(device.id, expect.objectContaining({ slideshowSeconds: 24 })));
  });
});
