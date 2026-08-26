// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssignedRootDto, DeviceRequestDto, SourceDto } from "@cloudframe/shared";
import { ApprovalSheet } from "./approval-sheet";

afterEach(cleanup);

const request: DeviceRequestDto = {
  id: "request-1", requestedName: "Den TV", status: "pending",
  createdAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-26T01:00:00.000Z",
  resolvedAt: null, approvedDeviceId: null
};
const source: SourceDto = {
  id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy",
  accessTokenExpiresAt: null, nextSyncAt: null, lastSyncStartedAt: null,
  lastSyncCompletedAt: null, lastSyncErrorCode: null, createdAt: "2026-08-20T00:00:00.000Z"
};
const roots: AssignedRootDto[] = [
  { id: "root-1", sourceId: "source-1", providerNodeId: "a", displayName: "Family Photos", ancestryProviderIds: [], enabled: true, createdAt: "2026-08-20T00:00:00.000Z" },
  { id: "root-2", sourceId: "source-1", providerNodeId: "b", displayName: "Trips", ancestryProviderIds: [], enabled: false, createdAt: "2026-08-20T00:00:00.000Z" }
];

describe("approval sheet accessibility", () => {
  it("focuses the name, traps Tab, restores focus, and submits only enabled roots", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const submit = vi.fn().mockResolvedValue(undefined);
    const view = render(<ApprovalSheet request={request} roots={roots} sources={[source]} onApprove={submit} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Device name")).toHaveFocus());
    expect(screen.queryByLabelText("Trips")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Family Photos"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve device" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Approve device" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: "Den TV", rootIds: ["root-1"] }));
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("closes on Escape without submitting", () => {
    const close = vi.fn();
    const submit = vi.fn();
    render(<ApprovalSheet request={request} roots={roots} sources={[source]} onApprove={submit} onClose={close} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });
});
