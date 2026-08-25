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
      "src/**",
      "tests/**/*.mjs"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
);
