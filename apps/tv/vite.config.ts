import legacy from "@vitejs/plugin-legacy";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  define: {
    __CLOUDFRAME_E2E__: JSON.stringify(process.env.CLOUDFRAME_E2E_BUILD === "1")
  },
  plugins: [
    preact(),
    legacy({
      targets: { chrome: "68" },
      modernPolyfills: true,
      renderLegacyChunks: true
    })
  ],
  build: {
    sourcemap: process.env.CLOUDFRAME_E2E_BUILD === "1",
    cssMinify: false
  }
});
