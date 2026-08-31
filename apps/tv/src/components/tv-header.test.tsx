// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TvHeader } from "./tv-header";

afterEach(cleanup);

describe("TvHeader", () => {
  it("keeps manual controls outside grid focus while exposing collection path", () => {
    const home = vi.fn(); const sources = vi.fn();
    render(<TvHeader title="Trips" breadcrumbs={[{ id: "root", name: "Photos" }]} onHome={home} onSources={sources} />);
    expect(screen.getByText("Photos / Trips")).toBeVisible();
    for (const button of screen.getAllByRole("button")) expect(button).toHaveAttribute("tabindex", "-1");
    fireEvent.click(screen.getByRole("button", { name: "Cloudframe home" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage sources" }));
    expect(home).toHaveBeenCalledTimes(1); expect(sources).toHaveBeenCalledTimes(1);
  });
});
