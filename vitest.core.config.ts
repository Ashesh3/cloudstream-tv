import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineProject({
  root,
  define: { __CLOUDFRAME_CONTAINER_TEST__: "false" },
  resolve: {
    alias: {
      "@cloudframe/shared": `${root}packages/shared/src/index.ts`,
      "@cloudframe/server": `${root}packages/server/src/index.ts`,
      "@cloudframe/providers": `${root}packages/providers/src/index.ts`,
      "@cloudframe/tv-core": `${root}packages/tv-core/src/index.ts`
    }
  },
  test: {
    name: "core-tv",
    include: ["tests/**/*.test.ts", "apps/tv/**/*.test.ts", "apps/tv/**/*.test.tsx"],
    setupFiles: ["apps/tv/src/test/react-timers.ts"],
    restoreMocks: true,
    clearMocks: true,
    isolate: true,
    fileParallelism: false
  }
});
