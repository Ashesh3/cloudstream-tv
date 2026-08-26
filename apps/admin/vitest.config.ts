import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const adminRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineProject({
  root: adminRoot,
  resolve: {
    alias: {
      "@cloudframe/shared": `${repoRoot}packages/shared/src/index.ts`
    }
  },
  test: {
    name: "admin",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    restoreMocks: true,
    clearMocks: true,
    isolate: true
  }
});
