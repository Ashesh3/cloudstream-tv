import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main aria-label="Cloudframe Admin">Cloudframe Admin</main>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
