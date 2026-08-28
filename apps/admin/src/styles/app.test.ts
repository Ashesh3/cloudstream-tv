// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("admin reduced motion", () => {
  it("scopes alternatives to the animated admin elements", () => {
    const styles = readFileSync(resolve(process.cwd(), "apps/admin/src/styles/app.css"), "utf8");
    const block = styles.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(block).not.toContain("*, *::before, *::after");
    expect(block).toContain(".program-root");
    expect(block).toContain(".provider-folder-list > li");
    expect(block).toContain(".animate-spin");
    expect(block).toContain(".animate-pulse");
    expect(block).toContain('[data-slot="dialog-content"] .animate-spin');
    expect(block).toContain('[data-slot="alert-dialog-content"] .animate-spin');
  });
});
