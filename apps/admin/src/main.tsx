import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import { cloudframeNightTheme } from "@cloudframe/theme";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@cloudframe/theme/cloudframe-night.css";
import "@fontsource-variable/instrument-sans";
import { AdminApp } from "./app";
import { createAdminApi, type AdminApi } from "./api/client";

const testApi = __CLOUDFRAME_E2E__
  ? (window as Window & { __CLOUDFRAME_TEST_ADMIN_API__?: AdminApi }).__CLOUDFRAME_TEST_ADMIN_API__
  : undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Theme theme={cloudframeNightTheme} mode="dark">
      <AdminApp api={testApi ?? createAdminApi()} checkSession={!testApi} />
    </Theme>
  </StrictMode>
);
