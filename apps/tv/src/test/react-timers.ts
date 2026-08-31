import { vi } from "vitest";

Object.defineProperty(globalThis, "jest", {
  configurable: true,
  value: vi
});
