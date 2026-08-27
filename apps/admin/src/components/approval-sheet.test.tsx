// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("restores focus and closes on Escape", async () => {
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const close = vi.fn(); const view = render(<ApprovalSheet request={request} roots={roots} sources={[source]} onApprove={vi.fn()} onClose={close} />);
    await waitFor(() => expect(screen.getByLabelText("Device name")).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); expect(close).toHaveBeenCalledTimes(1);
    view.unmount(); expect(opener).toHaveFocus(); opener.remove();
  });
});
