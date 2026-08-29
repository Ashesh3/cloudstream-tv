// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstRun } from "./first-run";

afterEach(cleanup);

describe("first-run ownership", () => {
  it("explains the local boundary and submits matching permanent credentials", async () => {
    const onClaim = vi.fn().mockResolvedValue(undefined);
    render(<FirstRun onClaim={onClaim} />);

    expect(screen.getByText((_, element) =>
      element?.tagName === "P" && element.textContent?.includes("empty /data volume") === true
    )).toBeVisible();
    expect(screen.getByText(/no cloud configuration was imported/i)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Setup code"), {
      target: { value: "AQEBAQEBAQEBAQEBAQEBAQ" },
    });
    fireEvent.change(screen.getByLabelText("New admin passphrase"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.change(screen.getByLabelText("Confirm admin passphrase"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Claim installation" }));

    expect(await screen.findByRole("button", { name: "Claiming installation…" }))
      .toBeDisabled();
    expect(onClaim).toHaveBeenCalledWith({
      setupCode: "AQEBAQEBAQEBAQEBAQEBAQ",
      passphrase: "correct horse battery staple",
    });
  });

  it("keeps mismatched passphrases local and actionable", async () => {
    const onClaim = vi.fn();
    render(<FirstRun onClaim={onClaim} />);

    fireEvent.change(screen.getByLabelText("Setup code"), {
      target: { value: "AQEBAQEBAQEBAQEBAQEBAQ" },
    });
    fireEvent.change(screen.getByLabelText("New admin passphrase"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.change(screen.getByLabelText("Confirm admin passphrase"), {
      target: { value: "different permanent passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Claim installation" }));

    expect(await screen.findByText("The passphrases do not match.")).toBeVisible();
    expect(onClaim).not.toHaveBeenCalled();
  });
});
