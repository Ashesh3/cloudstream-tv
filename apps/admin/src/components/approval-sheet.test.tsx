// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlRequestDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
import { ApprovalSheet } from "./approval-sheet";

class ResizeObserverMock { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal("ResizeObserver", ResizeObserverMock); afterEach(cleanup);
const request: ControlRequestDto = { id: "request-1", requestedName: "Den TV", status: "pending", createdAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-29T01:00:00.000Z", resolvedAt: null, approvedDeviceId: null };
const source: ControlSourceDto = { id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy", createdAt: "2026-08-20T00:00:00.000Z" };
const roots: ControlRootDto[] = [{ id: "root-1", sourceId: source.id, displayName: "Family Photos", enabled: true, createdAt: source.createdAt }, { id: "root-2", sourceId: source.id, displayName: "Trips", enabled: false, createdAt: source.createdAt }];

describe("approval sheet accessibility", () => {
  it("explains immediate access scope and submits only enabled roots", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalSheet request={request} roots={roots} sources={[source]} onApprove={submit} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Approve device" });
    expect(within(dialog).getByText("Access begins immediately after approval.")).toBeVisible();
    expect(screen.queryByLabelText("Trips")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Family Photos")); fireEvent.click(within(dialog).getByRole("button", { name: "Approve device" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: "Den TV", rootIds: ["root-1"] }));
  });
  it("restores opener focus after Escape closes the controlled dialog", async () => {
    const close = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Open approval</button>{open && <ApprovalSheet request={request} roots={roots} sources={[source]} onApprove={vi.fn()} onClose={() => { close(); setOpen(false); }} />}</>;
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open approval" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByLabelText("Device name")).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Approve device" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps validation and safe approval failures inside the dialog", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("private failure"));
    render(<ApprovalSheet request={request} roots={roots} sources={[source]} onApprove={submit} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Approve device" }));
    expect(await screen.findByText("Enter a device name.")).toBeVisible();
    expect(screen.getAllByText("Select at least one folder.")).not.toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "Den TV" } });
    fireEvent.click(screen.getByLabelText("Family Photos"));
    fireEvent.click(screen.getByRole("button", { name: "Approve device" }));
    expect(await screen.findByText("Approval failed. Try again.")).toBeVisible();
    expect(screen.queryByText("private failure")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Approve device" })).toBeVisible();
  });
});
