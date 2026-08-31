// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceRequest } from "./device-request";

afterEach(cleanup);

describe("DeviceRequest", () => {
  it("autofocuses, trims, bounds, and submits a household TV name", async () => {
    const submit = vi.fn();
    render(<DeviceRequest onSubmit={submit} />);
    const input = screen.getByLabelText("TV name");
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.input(input, { target: { value: `  ${"a".repeat(90)}  ` } });
    fireEvent.submit(input.closest("form")!);
    expect(submit).toHaveBeenCalledWith("a".repeat(78));
  });

  it("keeps the request disabled while blank or busy and preserves safe errors", () => {
    const { rerender } = render(<DeviceRequest onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Request access" })).toBeDisabled();
    fireEvent.input(screen.getByLabelText("TV name"), { target: { value: "Den TV" } });
    rerender(<DeviceRequest busy error="Try again shortly." onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Requesting…" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Try again shortly.");
  });
});
