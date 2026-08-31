// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrated = [
  "apps/admin/src/components/login.tsx",
  "apps/admin/src/components/first-run.tsx",
  "apps/admin/src/components/shell.tsx",
  "apps/admin/src/components/admin-overview.tsx",
] as const;

describe("Admin Astryx structure", () => {
  it("uses Astryx composition without legacy UI imports or utility-class layout", async () => {
    for (const path of migrated) {
      const source = await readFile(path, "utf8");
      if (path.endsWith(".tsx")) expect(source, path).toContain("@astryxdesign/core");
      expect(source, path).not.toContain("@/components/ui");
      expect(source, path).not.toMatch(/<(?:div|span)\b/);
      expect(source, path).not.toContain("className=");
      expect(source, path).not.toMatch(/#[\da-f]{3,8}\b/i);
      expect(source, path).not.toMatch(/\b\d+(?:\.\d+)?px\b/);
      expect(source, path).not.toMatch(/Screening Room|screening ledger|booth|program-stock|DIRECTION_SEED/i);
    }
  });

  it("removes the superseded Admin direction artifact from the application entry", async () => {
    const html = await readFile("apps/admin/index.html", "utf8");
    expect(html).not.toMatch(/Screening Room|screening ledger|booth|program-stock|DIRECTION_SEED|THESIS:/i);
  });

  it("uses the shared frame, count-only badges, and semantic status primitives", async () => {
    const shell = await readFile("apps/admin/src/components/shell.tsx", "utf8");
    const overview = await readFile("apps/admin/src/components/admin-overview.tsx", "utf8");
    expect(shell).toContain("AppShell");
    expect(shell).toContain("SideNav");
    expect(shell).toContain('mobileNav={{ breakpoint: "md" }}');
    expect(shell).toContain("Badge");
    expect(overview).toContain("StatusDot");
    expect(overview).not.toContain("Badge");
  });
});
