import legacy from "@vitejs/plugin-legacy";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    preact(),
    legacy({
      targets: ["Chrome >= 68"],
      modernPolyfills: true,
      renderLegacyChunks: true
    })
  ],
  build: {
    sourcemap: true
  }
});
