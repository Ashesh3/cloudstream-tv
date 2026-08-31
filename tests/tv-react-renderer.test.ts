import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("TV React renderer", () => {
  it("uses React without Preact compatibility aliases", async () => {
    const [entry, vite, tsconfig, vitest, manifest, rootManifest] = await Promise.all([
      readFile("apps/tv/src/main.tsx", "utf8"),
      readFile("apps/tv/vite.config.ts", "utf8"),
      readFile("apps/tv/tsconfig.json", "utf8"),
      readFile("vitest.core.config.ts", "utf8"),
      readFile("apps/tv/package.json", "utf8").then(JSON.parse),
      readFile("package.json", "utf8").then(JSON.parse)
    ]);

    expect(entry).toContain('from "react-dom/client"');
    expect(entry).toContain("createRoot(");
    expect(vite).toContain('from "@vitejs/plugin-react"');
    expect(tsconfig).not.toContain("jsxImportSource");
    expect(vitest).not.toContain("preact/compat");
    expect(vitest).not.toContain("preact/jsx-runtime");
    expect(manifest.dependencies).toMatchObject({ react: expect.any(String), "react-dom": expect.any(String) });
    expect(manifest.dependencies.preact).toBeUndefined();
    expect(manifest.devDependencies["@preact/preset-vite"]).toBeUndefined();
    expect(rootManifest.devDependencies["@testing-library/preact"]).toBeUndefined();
  });
});
