import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  base: "/admin/",
  define: {
    __CLOUDFRAME_E2E__: JSON.stringify(process.env.CLOUDFRAME_E2E_BUILD === "1")
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  build: {
    sourcemap: true
  }
});
