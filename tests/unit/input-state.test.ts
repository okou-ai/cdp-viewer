import { expect, it } from "vitest";
import { NativeComposition } from "../../src/input/composition";
import { InputLifecycle } from "../../src/input/lifecycle";
import type { InputTransition } from "../../src/input/lifecycle";

const shift = { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" } as const;
const transitions = [
  ["blur", true, false],
  ["navigation-started", true, false],
  ["same-document", true, false],
  ["document-lost", false, false],
  ["target-replaced", true, true],
  ["paused", true, true],
  ["disconnected", false, true],
  ["disposed", true, true],
  ["failed", true, false],
] as const satisfies readonly (readonly [InputTransition, boolean, boolean])[];

it.each(transitions)(
  "%s cancels the old owner and applies its document/transport release policy",
  (reason, release, terminal) => {
    const lifecycle = new InputLifecycle("owned-session");
    const owner = lifecycle.owner;
    lifecycle.beginFocus(owner);
    lifecycle.acceptFocus(owner, "owned-focus");
    lifecycle.pressKey(owner, shift);
    lifecycle.pointer(owner, { x: 20, y: 40 }, "left");
    const cleanup = lifecycle.transition(reason)!;
    expect(lifecycle.owns(owner)).toBe(false);
    expect(lifecycle.available).toBe(!terminal);
    expect(cleanup.owner).toBe(owner);
    expect(cleanup.objectId).toBe("owned-focus");
    expect(cleanup.keys).toEqual(release ? [shift] : []);
    expect(cleanup.buttons).toEqual(release ? ["left"] : []);
    expect(cleanup.point).toEqual({ x: 20, y: 40 });
    expect(lifecycle.focusedObject(lifecycle.owner)).toBeNull();
    expect(lifecycle.transition(reason)?.keys ?? []).toEqual([]);
    expect(lifecycle.transition(reason)?.buttons ?? []).toEqual([]);
    if (terminal) expect(lifecycle.transition("blur")).toBeNull();
  },
);

it.each([
  "blur",
  "navigation-started",
  "same-document",
  "document-lost",
  "failed",
] as const)(
  "late focus and release results cannot alter a new owner after %s",
  (reason) => {
    const lifecycle = new InputLifecycle("owned-session");
    const old = lifecycle.owner;
    lifecycle.pressKey(old, shift);
    lifecycle.transition(reason);
    const current = lifecycle.owner;
    lifecycle.beginFocus(current);
    lifecycle.acceptFocus(current, "new-focus");
    lifecycle.pressKey(current, shift);
    lifecycle.pointer(current, { x: 80, y: 90 }, "left");
    lifecycle.acceptFocus(old, "late-old-focus");
    lifecycle.releaseKey(old, shift);
    lifecycle.releaseButton(old, "left");
    expect(lifecycle.focusedObject(current)).toBe("new-focus");
    const cleanup = lifecycle.transition("blur")!;
    expect(cleanup.keys).toEqual([shift]);
    expect(cleanup.buttons).toEqual(["left"]);
    expect(current.document).toBe(reason === "document-lost" ? 1 : 0);
  },
);

it("keeps tokens isolated even when two connections reuse the same session ID", () => {
  const first = new InputLifecycle("same-id");
  const second = new InputLifecycle("same-id");
  expect(first.owner).toEqual(second.owner);
  expect(first.owns(second.owner)).toBe(false);
  first.pressKey(second.owner, shift);
  expect(first.transition("blur")!.keys).toEqual([]);
});

it("preserves pressed-input accounting across bounded event sequences", () => {
  const actions = ["press", "acknowledge", "cancel"] as const;
  for (const a of actions)
    for (const b of actions)
      for (const c of actions)
        for (const d of actions) {
          const lifecycle = new InputLifecycle("owned-session");
          let held = false;
          for (const action of [a, b, c, d]) {
            if (action === "press") {
              lifecycle.pressKey(lifecycle.owner, shift);
              held = true;
            } else if (action === "acknowledge") {
              lifecycle.releaseKey(lifecycle.owner, shift);
              held = false;
            } else {
              expect(lifecycle.transition("blur")!.keys).toHaveLength(
                held ? 1 : 0,
              );
              held = false;
            }
          }
          expect(lifecycle.transition("blur")!.keys).toHaveLength(held ? 1 : 0);
        }
});

it.each(["before", "after", "none"] as const)(
  "composition commits once with %s trailing-input ordering and preserves repeated text",
  (ordering) => {
    const owner = new InputLifecycle("owned-session").owner;
    const composition = new NativeComposition();
    composition.start(owner);
    expect(composition.input("preedit", owner, true, true).text).toBe("");
    if (ordering === "before")
      expect(composition.input("中", owner, true, true).text).toBe("");
    expect(composition.end("中", owner).text).toBe("中");
    if (ordering !== "none")
      expect(composition.input("中", owner, true, false).text).toBe("");
    expect(
      composition.input(
        ordering === "none" ? "中中" : "中",
        owner,
        false,
        false,
      ).text,
    ).toBe("中");
    expect(composition.end("中", owner).text).toBe("");
  },
);

it.each([
  "blur",
  "navigation-started",
  "same-document",
  "document-lost",
  "failed",
] as const)(
  "composition cannot commit to a replacement focus after %s",
  (reason) => {
    const lifecycle = new InputLifecycle("owned-session");
    const composition = new NativeComposition();
    composition.start(lifecycle.owner);
    lifecycle.transition(reason);
    const owner = lifecycle.owner;
    expect(composition.end("old text", owner).text).toBe("");
    expect(composition.input("old text", owner, true, false).text).toBe("");
    expect(composition.input("🙂", owner, false, false).text).toBe("🙂");
    composition.start(owner);
    expect(composition.end("current text", owner).text).toBe("current text");
  },
);

it("cancels native composition and rejects orphaned composition input", () => {
  const owner = new InputLifecycle("owned-session").owner;
  const composition = new NativeComposition();
  composition.start(owner);
  expect(composition.end("", owner).text).toBe("");
  composition.start(owner);
  composition.reset();
  expect(composition.input("late value", owner, true, true)).toEqual({
    keep: false,
    text: "",
  });
  expect(composition.end("late value", null)).toEqual({ value: "", text: "" });
  expect(composition.input("ordinary", owner, false, false).text).toBe(
    "ordinary",
  );
});
