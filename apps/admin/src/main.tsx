import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/archivo-narrow";
import { AdminApp } from "./app";
import { createAdminApi, type AdminApi } from "./api/client";
import "./styles/app.css";
import { TooltipProvider } from "@/components/ui/tooltip";

const testApi = __CLOUDFRAME_E2E__
  ? (window as Window & { __CLOUDFRAME_TEST_ADMIN_API__?: AdminApi }).__CLOUDFRAME_TEST_ADMIN_API__
  : undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider><AdminApp api={testApi ?? createAdminApi()} checkSession={!testApi} /></TooltipProvider>
  </StrictMode>
);
