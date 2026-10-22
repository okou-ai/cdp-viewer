import { renderToString } from "react-dom/server";
import { CdpViewer } from "cdp-viewer";
import { consumerExtensions } from "./extensions";

export function renderViewer() {
  return renderToString(
    <>
      <CdpViewer cdpUrl="wss://fixture.invalid/" />
      <CdpViewer
        cdpUrl="wss://fixture.invalid/"
        interactive
        extensions={consumerExtensions()}
      />
    </>,
  );
}
