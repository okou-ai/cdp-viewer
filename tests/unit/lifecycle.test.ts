import { expect, it } from "vitest";
import { initialIntent, transitionIntent } from "../../src/viewer/lifecycle";
import type { IntentEvent } from "../../src/viewer/lifecycle";
import { createViewerModel } from "../../src/viewer/model";
import type { ViewerTransition } from "../../src/viewer/model";

it("keeps no-op pause identity and gives deliberate reselection a new intent", () => {
  const initial = initialIntent();
  expect(transitionIntent(initial, { type: "pause", paused: false })).toBe(
    initial,
  );
  const selected = transitionIntent(initial, {
    type: "select",
    targetId: "page-a",
    paused: false,
  });
  expect(
    transitionIntent(selected, {
      type: "select",
      targetId: "page-a",
      paused: false,
    }),
  ).not.toBe(selected);
  const paused = transitionIntent(selected, { type: "pause", paused: true });
  expect(paused).toMatchObject({ paused: true, targetId: "page-a" });
  expect(transitionIntent(selected, { type: "target-lost" }).selection).toBe(
    selected.selection,
  );
  expect(
    transitionIntent(selected, {
      type: "select",
      targetId: "page-a",
      paused: false,
    }).selection,
  ).not.toBe(selected.selection);
  expect(transitionIntent(paused, { type: "reset" })).toMatchObject({
    paused: true,
    targetId: null,
  });
});

it("returns the originating committed intent when publication synchronously replaces it", () => {
  const model = createViewerModel();
  let replace = true;
  const stop = model.watch(model.intent$, () => {
    if (replace && model.read(model.intent$).targetId === "page-a") {
      replace = false;
      model.run(model.commitIntent$, { type: "pause", paused: true });
    }
  });
  const origin = model.run(model.commitIntent$, {
    type: "select",
    targetId: "page-a",
    paused: false,
  });
  stop();
  expect(origin.paused).toBe(false);
  expect(model.read(model.intent$)).not.toBe(origin);
  expect(model.read(model.intent$).paused).toBe(true);
  expect(model.getSnapshot().status).toBe("paused");
});

it("preserves latest parent intent across bounded parent and image outcome sequences", () => {
  const owner = {};
  const error = { kind: "frame", message: "Synthetic image failure" } as const;
  const events: readonly ViewerTransition[] = [
    { type: "pause", paused: true },
    { type: "pause", paused: false },
    { type: "streaming" },
    { type: "select", targetId: "page-b", paused: false },
    { type: "target-lost", error: null },
    {
      type: "disconnected",
      established: true,
      error: { kind: "connection", message: "Synthetic loss" },
    },
    { type: "image-settled", owner, ready: true },
    { type: "image-retrying", owner },
    { type: "image-starting", owner },
    { type: "image-painted", owner },
    { type: "image-released", owner },
    { type: "image-cancelled", owner, stopped: true },
  ];
  let sequences = 0;
  for (const first of events)
    for (const second of events)
      for (const last of events) {
        const model = createViewerModel();
        model.transition({ type: "select", targetId: "page-a", paused: false });
        model.transition({
          type: "image-failed",
          owner,
          targetId: "page-a",
          error,
        });
        let paused = false;
        let target: string | null = "page-a";
        for (const event of [first, second, last]) {
          if (event.type === "pause") paused = event.paused;
          if (event.type === "select") {
            paused = event.paused;
            target = event.targetId;
          }
          if (event.type === "target-lost") target = null;
          model.transition(event);
          expect(model.read(model.intent$).paused).toBe(paused);
          expect(model.read(model.intent$).targetId).toBe(target);
          expect(model.getSnapshot().selectedTargetId).toBe(target);
          if (
            paused &&
            target &&
            model.getSnapshot().status !== "disconnected"
          ) {
            expect(model.getSnapshot().status).toBe("paused");
            expect(model.read(model.controls$).canRetryImage).toBe(false);
          }
        }
        sequences++;
      }
  expect(sequences).toBe(1728);
});

it("keeps original intent values immutable across retirement facts", () => {
  const original = transitionIntent(initialIntent(), {
    type: "select",
    targetId: "page-a",
    paused: false,
  });
  const events: readonly IntentEvent[] = [
    { type: "pause", paused: true },
    { type: "invalidate" },
    { type: "target-lost" },
    { type: "discovery-failed" },
  ];
  for (const event of events) transitionIntent(original, event);
  expect(original).toMatchObject({ targetId: "page-a", paused: false });
  expect(Object.isFrozen(original)).toBe(true);
});
