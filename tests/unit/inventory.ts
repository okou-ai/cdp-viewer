import { command } from "ccstate";
import type { ViewerModel, ViewerUpdate } from "../../src/viewer/model";
import type { ViewerTarget } from "../../src/viewer/types";

// Compose real model commands so fixture observations publish as one transaction.
const observeTargets$ = command(
  (
    { set },
    model: ViewerModel,
    patch: ViewerUpdate & { targets?: readonly ViewerTarget[] },
  ) => {
    const { targets, ...data } = patch;
    if (targets) {
      const now = performance.now();
      const round = set(model.inventoryUpdate$, {
        type: "begin-round",
        now,
      }).round!;
      set(model.inventoryUpdate$, { type: "listed", round, targets });
      for (const target of targets) {
        const state = set(model.inventoryUpdate$, { type: "order" });
        set(model.inventoryUpdate$, {
          type: "membership",
          observation: {
            id: target.id,
            epoch: state.epoch,
            generation: state.entries.get(target.id)!.generation,
            order: state.sequence,
            startedAt: now,
          },
          member: true,
        });
      }
      set(model.inventoryUpdate$, { type: "complete-round", round });
    }
    set(model.updateData$, data);
  },
);

export function updateModel(
  model: ViewerModel,
  patch: ViewerUpdate & { targets?: readonly ViewerTarget[] },
): void {
  model.run(observeTargets$, model, patch);
}
