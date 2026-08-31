import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  base: "/admin/",
  define: {
    __CLOUDFRAME_E2E__: JSON.stringify(process.env.CLOUDFRAME_E2E_BUILD === "1")
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  build: {
    sourcemap: process.env.CLOUDFRAME_E2E_BUILD === "1"
  }
});
