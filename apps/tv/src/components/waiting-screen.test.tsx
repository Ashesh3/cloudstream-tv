// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WaitingScreen } from "./waiting-screen";

afterEach(cleanup);

describe("WaitingScreen", () => {
  it("shows passive request identity, expiry, and pending truth", () => {
    render(<WaitingScreen name="Den TV" expiresAt="2026-08-26T00:30:00.000Z" />);
    expect(screen.getByText(/Den TV is queued in Cloudframe Admin/)).toBeVisible();
    expect(screen.getByRole("status", { name: "Approval request pending" })).toBeVisible();
    expect(screen.getByText(/Request expires/)).toBeVisible();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });
});
