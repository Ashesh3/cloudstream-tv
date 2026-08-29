/// <reference types="vite/client" />
import type { JSX } from "preact";

declare global {
  const __CLOUDFRAME_E2E__: boolean;

  namespace preact.JSX {
    interface IntrinsicElements {
      "video-player": JSX.HTMLAttributes<HTMLElement>;
      "video-skin": JSX.HTMLAttributes<HTMLElement>;
    }
  }
}

export {};
