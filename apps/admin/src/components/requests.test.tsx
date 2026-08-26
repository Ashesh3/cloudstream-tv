// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Requests } from "./requests";

afterEach(cleanup);

describe("requests warning state", () => {
  it("uses the semantic ledger warning contract when enrollment is paused", () => {
    render(<Requests requests={[]} roots={[]} sources={[]} disabled pendingId={null} onApprove={vi.fn()} onDeny={vi.fn()} />);

    const warning = screen.getByRole("alert");
    expect(warning).toHaveClass("ledger-warning");
    expect(warning.className).not.toMatch(/(?:bg|border|text)-amber-/);
    expect(within(warning).getByText("New requests are paused")).toBeVisible();
    expect(within(warning).getByText(/turn enrollment back on in Settings/i)).toBeVisible();

    const styles = readFileSync(resolve(process.cwd(), "apps/admin/src/styles/app.css"), "utf8");
    expect(styles).toContain("--warning-surface:");
    expect(styles).toContain("--warning-border:");
    expect(styles).toContain("--warning-foreground:");
    expect(styles).toContain("--warning-muted:");
  });
});
