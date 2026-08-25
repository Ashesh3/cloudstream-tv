import { render } from "preact";
import { TvApp } from "./app";
import "./styles/tokens.css";
import "./styles/app.css";

render(<TvApp />, document.getElementById("app")!);
