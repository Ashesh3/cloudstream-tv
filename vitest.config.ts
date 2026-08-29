import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __CLOUDFRAME_CONTAINER_TEST__: "false" },
  test: {
    projects: ["./vitest.core.config.ts", "./apps/admin/vitest.config.ts"]
  }
});
