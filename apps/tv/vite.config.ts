import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  define: {
    __CLOUDFRAME_E2E__: JSON.stringify(process.env.CLOUDFRAME_E2E_BUILD === "1")
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@astryxdesign/core/astryx.css": fileURLToPath(
        new URL("../../packages/theme/dist/cloudframe-night.tv.css", import.meta.url)
      )
    }
  },
  build: {
    target: "chrome108",
    sourcemap: process.env.CLOUDFRAME_E2E_BUILD === "1",
    cssMinify: false
  }
});
