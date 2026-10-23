import { StrictMode } from "react";
import { mountDemo } from "./bootstrap";
import "cdp-viewer/style.css";
import { App } from "./App";
import "./style.css";

mountDemo(
  <StrictMode>
    <App />
  </StrictMode>,
);
