import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const adminRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineProject({
  root: adminRoot,
  define: { __CLOUDFRAME_CONTAINER_TEST__: "false" },
  resolve: {
    alias: {
      "@": `${adminRoot}src`,
      "@cloudframe/shared": `${repoRoot}packages/shared/src/index.ts`
    }
  },
  test: {
    name: "admin",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
    isolate: true
  }
});
