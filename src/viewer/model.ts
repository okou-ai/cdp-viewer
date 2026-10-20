import { createStore, state } from "ccstate";
import type { ViewerSnapshot } from "./types";

export function createViewerModel() {
  const snapshot$ = state<ViewerSnapshot>(
    Object.freeze({
      status: "connecting",
      targets: Object.freeze([]),
      selectedTargetId: null,
      error: null,
      navigation: null,
    }),
  );
  const store = createStore();
  return {
    getSnapshot: () => store.get(snapshot$),
    subscribe: (listener: () => void) => store.watch(snapshot$, listener),
    update: (patch: Partial<ViewerSnapshot>) => {
      store.set(snapshot$, (old) => Object.freeze({ ...old, ...patch }));
    },
  };
}

export type ViewerModel = ReturnType<typeof createViewerModel>;
