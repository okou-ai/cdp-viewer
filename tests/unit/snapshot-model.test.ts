import { expect, it, vi } from "vitest";
import { createViewerModel } from "../../src/viewer/model";
import type { ViewerTransition } from "../../src/viewer/model";
import type {
  ViewerError,
  ViewerNavigation,
  ViewerTarget,
} from "../../src/viewer/types";

const targets: readonly ViewerTarget[] = Object.freeze([
  Object.freeze({ id: "page-a", title: "A" }),
  Object.freeze({ id: "page-b", title: "B" }),
]);
const navigation: ViewerNavigation = Object.freeze({
  url: "https://fixture.invalid/",
  canGoBack: false,
  canGoForward: false,
});

function streamingViewer() {
  const model = createViewerModel();
  model.update({ targets, navigation });
  model.transition({ type: "select", targetId: "page-a", paused: false });
  model.transition({ type: "streaming" });
  model.update({ navigation });
  return model;
}

it("retains snapshots and projections for equivalent observations", () => {
  const model = streamingViewer();
  const snapshot = model.getSnapshot();
  const tabs = model.read(model.tabLayout$);
  const controls = model.read(model.controls$);
  const notify = vi.fn();
  const tabsChanged = vi.fn();
  const controlsChanged = vi.fn();
  const stop = model.subscribe(notify);
  const stopTabs = model.watch(model.tabLayout$, tabsChanged);
  const stopControls = model.watch(model.controls$, controlsChanged);
  for (let index = 0; index < 3; index++) {
    model.update({
      targets: Object.freeze(
        targets.map((target) => Object.freeze({ ...target })),
      ),
      navigation: Object.freeze({ ...navigation }),
    });
    model.update({});
    model.transition({ type: "streaming" });
  }
  expect(model.getSnapshot()).toBe(snapshot);
  expect(model.read(model.tabLayout$)).toBe(tabs);
  expect(model.read(model.controls$)).toBe(controls);
  expect(notify).not.toHaveBeenCalled();
  expect(tabsChanged).not.toHaveBeenCalled();
  expect(controlsChanged).not.toHaveBeenCalled();
  stop();
  stopTabs();
  stopControls();
});

it.each([
  { change: "id", next: [{ id: "replacement", title: "A" }, targets[1]!] },
  { change: "title", next: [{ id: "page-a", title: "Renamed" }, targets[1]!] },
  { change: "order", next: [targets[1]!, targets[0]!] },
  { change: "addition", next: [...targets, { id: "page-c", title: "C" }] },
  { change: "removal", next: [targets[0]!] },
  { change: "empty list", next: [] },
])("publishes a target $change and retains equal navigation", ({ next }) => {
  const model = streamingViewer();
  const before = model.getSnapshot();
  const notify = vi.fn();
  const stop = model.subscribe(notify);
  model.update({ targets: next, navigation: { ...navigation } });
  const after = model.getSnapshot();
  expect(after).not.toBe(before);
  expect(after.targets).toEqual(next);
  expect(after.navigation).toBe(before.navigation);
  expect(Object.isFrozen(after)).toBe(true);
  expect(notify).toHaveBeenCalledOnce();
  model.update({ targets: next.map((target) => ({ ...target })) });
  expect(model.getSnapshot()).toBe(after);
  expect(notify).toHaveBeenCalledOnce();
  stop();
});

it.each([
  { change: "URL", next: { ...navigation, url: "https://next.invalid/" } },
  { change: "back", next: { ...navigation, canGoBack: true } },
  { change: "forward", next: { ...navigation, canGoForward: true } },
  { change: "unavailable", next: null },
])("publishes navigation $change and retains equal targets", ({ next }) => {
  const model = streamingViewer();
  const before = model.getSnapshot();
  const notify = vi.fn();
  const stop = model.subscribe(notify);
  model.update({
    targets: targets.map((target) => ({ ...target })),
    navigation: next,
  });
  const after = model.getSnapshot();
  expect(after).not.toBe(before);
  expect(after.navigation).toEqual(next);
  expect(after.targets).toBe(before.targets);
  expect(notify).toHaveBeenCalledOnce();
  model.update({ navigation: next ? { ...next } : null });
  expect(model.getSnapshot()).toBe(after);
  expect(notify).toHaveBeenCalledOnce();
  model.update({ navigation });
  expect(model.getSnapshot().navigation).toBe(navigation);
  expect(notify).toHaveBeenCalledTimes(2);
  stop();
});

it.each([
  { type: "select", targetId: "page-b", paused: false },
  { type: "paused" },
  { type: "target-lost", error: null },
  { type: "failed", error: { kind: "frame", message: "Synthetic failure" } },
  {
    type: "disconnected",
    established: true,
    error: { kind: "connection", message: "Synthetic disconnect" },
  },
] satisfies ViewerTransition[])(
  "publishes a $type transition",
  (transition) => {
    const model = streamingViewer();
    const before = model.getSnapshot();
    const notify = vi.fn();
    const stop = model.subscribe(notify);
    model.transition(transition);
    expect(model.getSnapshot()).not.toBe(before);
    expect(notify).toHaveBeenCalledOnce();
    stop();
  },
);

it("keeps error owner identity while repeated reports only replace notifications", () => {
  const model = streamingViewer();
  const error: ViewerError = { kind: "input", message: "Synthetic warning" };
  model.update({ error });
  const first = model.read(model.notification$)!;
  const snapshot = model.getSnapshot();
  const notify = vi.fn();
  const noticeChanged = vi.fn();
  const stop = model.subscribe(notify);
  const stopNotice = model.watch(model.notification$, noticeChanged);
  model.update({ error });
  const repeated = model.read(model.notification$)!;
  expect(model.getSnapshot()).toBe(snapshot);
  expect(notify).not.toHaveBeenCalled();
  expect(noticeChanged).toHaveBeenCalledOnce();
  expect(repeated).toMatchObject({
    error,
    previous: { id: first.id, error },
    exiting: false,
  });
  expect(repeated.id).not.toBe(first.id);
  model.run(model.exitNotification$, first.id);
  model.run(model.removeNotification$, first.id);
  expect(model.read(model.notification$)).toBe(repeated);

  const replacement: ViewerError = { ...error };
  model.update({ error: replacement });
  expect(model.getSnapshot().error).toBe(replacement);
  expect(model.getSnapshot().error).not.toBe(error);
  expect(notify).toHaveBeenCalledOnce();
  model.update({ error: null });
  expect(model.getSnapshot().error).toBeNull();
  expect(model.read(model.notification$)?.exiting).toBe(true);
  expect(notify).toHaveBeenCalledTimes(2);
  stop();
  stopNotice();
});

it("runs private reset and selection effects even with an unchanged snapshot", () => {
  const model = createViewerModel();
  const initial = model.getSnapshot();
  model.run(model.configure$, { interactive: true, scoped: false });
  model.run(model.setConnected$, true);
  expect(model.read(model.controls$).canMutateTabs).toBe(true);
  model.run(model.setTabAction$, { type: "create" });
  model.transition({ type: "reset" });
  expect(model.getSnapshot()).toBe(initial);
  expect(model.read(model.tabAction$)).toBeNull();
  expect(model.read(model.controls$).canMutateTabs).toBe(false);

  model.update({ targets });
  model.transition({ type: "select", targetId: "page-a", paused: false });
  const selected = model.getSnapshot();
  expect(model.read(model.controls$).loadingPreview).toBe(false);
  model.run(model.setClipboard$, {
    message: "Owned copy recovery",
    text: "Owned text",
  });
  model.transition({
    type: "select",
    targetId: "page-a",
    paused: false,
    preview: true,
  });
  expect(model.getSnapshot()).toBe(selected);
  expect(model.read(model.clipboard$)).toBeNull();
  expect(model.read(model.controls$).loadingPreview).toBe(true);
  model.transition({ type: "select", targetId: "page-a", paused: false });
  expect(model.getSnapshot()).toBe(selected);
  expect(model.read(model.controls$).loadingPreview).toBe(false);
});
