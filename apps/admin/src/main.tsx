import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./app";
import { createAdminApi, type AdminApi } from "./api/client";
import "./styles/tokens.css";
import "./styles/app.css";

const testApi = __CLOUDFRAME_E2E__
  ? (window as Window & { __CLOUDFRAME_TEST_ADMIN_API__?: AdminApi }).__CLOUDFRAME_TEST_ADMIN_API__
  : undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AdminApp api={testApi ?? createAdminApi()} checkSession={!testApi} />
  </StrictMode>
);
