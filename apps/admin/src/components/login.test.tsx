// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiError } from "../api/client";
import { Login } from "./login";

afterEach(cleanup);

describe("admin login", () => {
  it("autofocuses the private password field and toggles visibility without submitting", () => {
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} />);
    const input = screen.getByLabelText("Admin passphrase");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("autocomplete", "current-password");
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByText(/never stored in this browser/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show passphrase" }));
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide passphrase" })).toBeVisible();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("deduplicates pending submissions and disables every credential control", async () => {
    let resolve!: () => void;
    const onLogin = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    render(<Login onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText("Admin passphrase"), { target: { value: "private passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.submit(screen.getByRole("button", { name: "Signing in…" }).closest("form")!);
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Admin passphrase")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show passphrase" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    resolve();
  });

  it.each([
    [new AdminApiError(401, "ADMIN_UNAUTHORIZED", "Incorrect passphrase."), "Incorrect passphrase."],
    [new Error("secret internal detail"), "Sign in failed."],
  ])("surfaces only safe failures", async (failure, message) => {
    render(<Login onLogin={vi.fn().mockRejectedValue(failure)} />);
    fireEvent.change(screen.getByLabelText("Admin passphrase"), { target: { value: "private passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(document.body).not.toHaveTextContent("secret internal detail");
  });
});
