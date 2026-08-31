import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import { cloudframeNightTheme } from "@cloudframe/theme";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { TvApp } from "./app";
import type { TvApi } from "./api/client";
import { createGoogleMediaBridge } from "./media/google-media-bridge";
import "./styles/tokens.css";
import "./styles/app.css";

const injectedApi = __CLOUDFRAME_E2E__
  ? (window as Window & { __CLOUDFRAME_TEST_TV_API__?: TvApi }).__CLOUDFRAME_TEST_TV_API__
  : undefined;
const googleMedia = createGoogleMediaBridge();
createRoot(document.getElementById("app")!).render(
  <Theme theme={cloudframeNightTheme} mode="dark">
    <TvApp api={injectedApi} googleMedia={googleMedia} />
  </Theme>
);
