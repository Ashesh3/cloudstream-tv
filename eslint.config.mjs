import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "build/**",
      "apps/*/dist/**",
      "node_modules/**",
      ".superpowers/**",
      ".vercel/**",
      ".next/**",
      "playwright-report/**",
      "test-results/**",
      "e2e/fixtures/hls-long/**",
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
        Headers: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        URL: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly"
      }
    }
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    files: ["scripts/*.mjs"],
    rules: {
      "no-empty": "off"
    }
  }
);
