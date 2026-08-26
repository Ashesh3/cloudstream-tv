import { render } from "preact";
import { TvApp } from "./app";
import type { TvApi } from "./api/client";
import "./styles/tokens.css";
import "./styles/app.css";

const injectedApi = __CLOUDFRAME_E2E__
  ? (window as Window & { __CLOUDFRAME_TEST_TV_API__?: TvApi }).__CLOUDFRAME_TEST_TV_API__
  : undefined;
render(<TvApp api={injectedApi} />, document.getElementById("app")!);
