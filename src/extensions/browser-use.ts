import type { ViewerExtension } from "./types";

/** Optional Browser Use activation events; ordinary Chrome needs no adapter. */
export function browserUse(): ViewerExtension {
  return Object.freeze<ViewerExtension>({
    id: "browser-use",
    setup: (context) =>
      context.subscribe("BrowserUse.activeTargetChanged", async (event) => {
        const targetId = event.params.targetId;
        if (
          event.sessionId !== undefined ||
          typeof targetId !== "string" ||
          !targetId.trim()
        )
          return;
        await context.requestTargetSelection(targetId);
      }),
  });
}
