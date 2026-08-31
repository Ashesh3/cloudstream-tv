/// <reference types="vite/client" />
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare global {
  const __CLOUDFRAME_E2E__: boolean;

  namespace React.JSX {
    interface IntrinsicElements {
      "video-player": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
      "video-skin": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

export {};
