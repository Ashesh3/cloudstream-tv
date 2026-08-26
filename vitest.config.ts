import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["./vitest.core.config.ts", "./apps/admin/vitest.config.ts"]
  }
});
