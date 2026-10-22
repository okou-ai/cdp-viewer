import type {
  ExtensionContext,
  ExtensionEvent,
  ExtensionState,
  ViewerExtension,
} from "cdp-viewer/extensions";
import type { ViewerExtension as RootExtension } from "cdp-viewer";
import { browserUse } from "cdp-viewer/extensions/browser-use";

// Exercise both public type routes and a standard event in the installed SDK.
const updatedPage: ViewerExtension = {
  id: "consumer-updated-page",
  setup(context: ExtensionContext) {
    return context.subscribe(
      "Target.targetInfoChanged",
      async (event: ExtensionEvent) => {
        const state: ExtensionState = context.getState();
        const target = event.params.targetInfo;
        if (
          state.status === "disconnected" ||
          context.signal.aborted ||
          typeof target !== "object" ||
          target === null ||
          !("targetId" in target) ||
          typeof target.targetId !== "string" ||
          !("title" in target) ||
          typeof target.title !== "string" ||
          !target.title.startsWith("Adapter ")
        )
          return;
        await context.requestTargetSelection(target.targetId);
      },
    );
  },
};

export function consumerExtensions(): readonly RootExtension[] {
  return [browserUse(), updatedPage];
}
