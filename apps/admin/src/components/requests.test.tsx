// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Requests } from "./requests";

afterEach(cleanup);

describe("requests warning state", () => {
  it("uses an Astryx warning banner when enrollment is paused", () => {
    render(<Requests requests={[]} roots={[]} sources={[]} disabled pendingId={null} onApprove={vi.fn()} onDeny={vi.fn()} />);

    const warning = screen.getByRole("alert");
    expect(within(warning).getByText("New requests are paused")).toBeVisible();
    expect(within(warning).getByText(/turn enrollment back on in Settings/i)).toBeVisible();
  });

  it("renders newest-first request rows with direct actions and no record Cards", () => {
    const approve = vi.fn();
    const deny = vi.fn();
    const requests = [
      { id: "old", requestedName: "Kitchen", status: "pending", createdAt: "2026-08-25T00:00:00.000Z", expiresAt: "2026-08-25T00:30:00.000Z", resolvedAt: null, approvedDeviceId: null },
      { id: "new", requestedName: "Den TV", status: "pending", createdAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-26T00:30:00.000Z", resolvedAt: null, approvedDeviceId: null },
    ] as const;
    render(<Requests requests={[...requests]} roots={[]} sources={[]} disabled={false} pendingId={null} onApprove={approve} onDeny={deny} />);
    const rows = screen.getAllByTestId("request-row");
    expect(rows[0]).toHaveTextContent("Den TV");
    expect(rows[1]).toHaveTextContent("Kitchen");
    expect(document.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Approve Den TV" }));
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Deny Kitchen" }));
    expect(approve).toHaveBeenCalledWith(requests[1]);
    expect(deny).toHaveBeenCalledWith(requests[0]);
  });

  it("shows a distinct request empty state", () => {
    render(<Requests requests={[]} roots={[]} sources={[]} disabled={false} pendingId={null} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "No pending requests" })).toBeVisible();
  });
});
