import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "apps/*/dist/**",
      "node_modules/**",
      ".superpowers/**",
      ".vercel/**",
      ".next/**",
      "playwright-report/**",
      "test-results/**",
      "src/**",
      "tests/**/*.mjs"
    ]
  },
  js.configs.recommended,
  {
    files: ["scripts/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        Response: "readonly",
        console: "readonly",
        process: "readonly"
      }
    }
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
);
