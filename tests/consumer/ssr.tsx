import { renderToString } from "react-dom/server";
import { CdpViewer } from "cdp-viewer";

export function renderViewer() {
  return renderToString(<CdpViewer cdpUrl="wss://fixture.invalid/" />);
}
