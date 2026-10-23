import { renderToString } from "react-dom/server";
import { CdpViewer } from "cdp-viewer";
import { browserUse } from "cdp-viewer/extensions/browser-use";
import type { ViewerExtension } from "cdp-viewer/extensions";

const custom: ViewerExtension = {
  id: "custom",
  setup: (context) =>
    context.subscribe("Custom.activeTargetChanged", async (event) => {
      const id = event.params.targetId;
      if (typeof id === "string") await context.requestTargetSelection(id);
    }),
};

export function renderViewer() {
  return renderToString(
    <>
      <CdpViewer cdpUrl="wss://fixture.invalid/" />
      <CdpViewer
        cdpUrl="wss://fixture.invalid/"
        interactive
        transport="split"
        windowSizeSync="initial"
        capture={{ quality: 0, maxWidth: 1280, maxHeight: 720 }}
        extensions={[browserUse(), custom]}
      />
    </>,
  );
}
