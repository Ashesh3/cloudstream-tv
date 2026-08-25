import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@cloudframe/shared": `${root}packages/shared/src/index.ts`,
      "@cloudframe/server": `${root}packages/server/src/index.ts`,
      "@cloudframe/providers": `${root}packages/providers/src/index.ts`,
      "@cloudframe/indexer": `${root}packages/indexer/src/index.ts`,
      "@cloudframe/tv-core": `${root}packages/tv-core/src/index.ts`
    }
  },
  test: {
    include: ["tests/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    restoreMocks: true,
    clearMocks: true
  }
});
