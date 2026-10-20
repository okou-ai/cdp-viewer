import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "cdp-viewer/style.css";
import { App } from "./App";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("The demo root is missing.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
