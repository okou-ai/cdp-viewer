import { updateModel } from "./inventory";
import { expect, it, vi } from "vitest";
import { createDemoModel } from "../../demo/model";
import { browserUse } from "../../src/extensions/browser-use";
import { createViewerModel } from "../../src/viewer/model";
import type { ViewerTransition } from "../../src/viewer/model";
import type { ViewerError } from "../../src/viewer/types";

const navigation = (url: string) => ({
  url,
  canGoBack: false,
  canGoForward: false,
});

function streamingViewer() {
  const model = createViewerModel();
  updateModel(model, { targets: [{ id: "page-a", title: "A" }] });
  model.transition({ type: "select", targetId: "page-a", paused: false });
  model.transition({ type: "streaming" });
  return model;
}

it("replaces identical notifications and rejects stale expiry or exit completion", () => {
  const model = streamingViewer();
  const error: ViewerError = { kind: "input", message: "Synthetic warning" };
  model.update({ error });
  const first = model.read(model.notification$)!;
  expect(first).toMatchObject({ error, exiting: false });
  model.update({ navigation: navigation("https://one.invalid/") });
  updateModel(model, { targets: [{ id: "page-a", title: "Updated" }] });
  expect(model.read(model.notification$)).toBe(first);
  model.run(model.removeNotification$, first.id);
  expect(model.read(model.notification$)).toBe(first);
  model.update({ error });
  const second = model.read(model.notification$)!;
  expect(second.id).not.toBe(first.id);
  model.run(model.exitNotification$, first.id);
  model.run(model.removeNotification$, first.id);
  expect(model.read(model.notification$)).toBe(second);
  model.run(model.exitNotification$, second.id);
  expect(model.read(model.notification$)?.exiting).toBe(true);
  model.update({ error });
  const replacement = model.read(model.notification$)!;
  expect(replacement).toMatchObject({ error, exiting: false });
  expect(replacement.id).not.toBe(second.id);
  model.run(model.removeNotification$, second.id);
  expect(model.read(model.notification$)).toBe(replacement);
  model.run(model.exitNotification$, replacement.id);
  const diagnostic = model.getSnapshot();
  model.run(model.removeNotification$, replacement.id);
  expect(model.read(model.notification$)).toBeNull();
  expect(model.getSnapshot()).toBe(diagnostic);
  expect(model.getSnapshot().error).toBe(error);
  model.update({ navigation: navigation("https://two.invalid/") });
  expect(model.read(model.notification$)).toBeNull();
});

it("bounds covering arrivals to the current and previous report and ignores stale completion", () => {
  const model = streamingViewer();
  const report = (message: string) => {
    model.update({ error: { kind: "input", message } });
    return model.read(model.notification$)!;
  };
  const first = report("First warning");
  expect(first.previous).toBeNull();
  expect(first.entrance).toBe("initial");
  const second = report("Second warning");
  expect(second).toMatchObject({
    previous: { id: first.id, error: first.error },
  });
  const third = report("Third warning");
  expect(third.previous).toEqual({ id: second.id, error: second.error });
  model.run(model.finishReplacement$, second.id);
  expect(model.read(model.notification$)).toBe(third);
  const diagnostic = model.getSnapshot();
  model.run(model.finishReplacement$, third.id);
  expect(model.read(model.notification$)).toMatchObject({
    id: third.id,
    entrance: "replacement",
    previous: null,
    exiting: false,
  });
  expect(model.getSnapshot()).toBe(diagnostic);
  const fourth = report("Fourth warning");
  model.run(model.exitNotification$, fourth.id);
  const exiting = model.read(model.notification$);
  expect(exiting?.previous).toBeNull();
  model.run(model.finishReplacement$, fourth.id);
  expect(model.read(model.notification$)).toBe(exiting);
  model.transition({ type: "reset" });
  model.run(model.finishReplacement$, fourth.id);
  expect(model.read(model.notification$)).toBeNull();
});

it("exits cleared warnings and keeps sibling notification lifetimes independent", () => {
  const first = streamingViewer();
  const second = streamingViewer();
  const error: ViewerError = { kind: "tab", message: "Synthetic tab warning" };
  first.update({ error });
  second.update({ error });
  const sibling = second.read(second.notification$);
  const notice = first.read(first.notification$)!;
  first.update({ error: null });
  expect(first.read(first.notification$)).toMatchObject({
    id: notice.id,
    exiting: true,
  });
  expect(first.getSnapshot().error).toBeNull();
  first.run(first.removeNotification$, notice.id);
  expect(first.read(first.notification$)).toBeNull();
  expect(second.read(second.notification$)).toBe(sibling);
  expect(second.getSnapshot().error).toBe(error);
});

const notificationResets: readonly ViewerTransition[] = [
  { type: "reset" },
  { type: "select", targetId: "page-b", paused: false },
  { type: "paused" },
  { type: "stopped" },
  { type: "target-lost", error: null },
  {
    type: "discovery-failed",
    error: { kind: "scope", message: "Synthetic scope" },
  },
  { type: "failed", error: { kind: "frame", message: "Synthetic frame" } },
  {
    type: "disconnected",
    established: true,
    error: { kind: "connection", message: "Synthetic disconnect" },
  },
];
it.each(notificationResets)(
  "discards notification presentation when its session is $type",
  (transition) => {
    const model = streamingViewer();
    model.update({ error: { kind: "input", message: "Synthetic warning" } });
    const previous = model.read(model.notification$)!;
    model.transition(transition);
    expect(model.read(model.notification$)).toBeNull();
    model.transition({ type: "streaming" });
    model.update({ error: { kind: "input", message: "Replacement warning" } });
    const next = model.read(model.notification$)!;
    expect(next.id).not.toBe(previous.id);
    model.run(model.exitNotification$, previous.id);
    model.run(model.removeNotification$, previous.id);
    expect(model.read(model.notification$)).toBe(next);
  },
);

it("only clears notifications when the owning runtime unbinds", () => {
  const model = streamingViewer();
  const actions = () => ({
    select: vi.fn(),
    navigate: vi.fn(),
    createTab: vi.fn(),
    closeTab: vi.fn(),
  });
  const original = actions();
  const replacement = actions();
  model.run(model.bind$, original);
  model.run(model.bind$, replacement);
  model.update({ error: { kind: "input", message: "Replacement warning" } });
  const notice = model.read(model.notification$);
  model.run(model.unbind$, original);
  expect(model.read(model.notification$)).toBe(notice);
  model.run(model.unbind$, replacement);
  expect(model.read(model.notification$)).toBeNull();
});

it("keeps action eligibility independent across scope, stream errors and pending work", () => {
  const first = createViewerModel();
  const second = createViewerModel();
  first.run(first.configure$, { interactive: true, scoped: false });
  second.run(second.configure$, { interactive: true, scoped: true });
  for (const model of [first, second]) {
    model.run(model.setConnected$, true);
    model.transition({ type: "target-lost", error: null });
  }
  expect(first.read(first.controls$)).toMatchObject({
    canCreate: true,
    showEmptyCreate: true,
  });
  expect(second.read(second.controls$)).toMatchObject({
    canCreate: false,
    emptyScoped: true,
    showEmptyCreate: false,
  });
  first.run(first.setTabAction$, { type: "create" });
  expect(first.read(first.controls$).canMutateTabs).toBe(false);
  expect(second.read(second.controls$).canMutateTabs).toBe(true);
  first.run(first.setTabAction$, null);
  first.transition({
    type: "failed",
    error: { kind: "frame", message: "Synthetic stream failure" },
  });
  expect(first.read(first.controls$)).toMatchObject({
    canMutateTabs: true,
    canCreate: false,
    recovery: true,
    showEmptyCreate: false,
  });
  first.run(first.configure$, { interactive: false, scoped: false });
  first.transition({ type: "streaming" });
  expect(first.read(first.controls$).canMutateTabs).toBe(false);
  expect(first.read(first.controls$).canCreate).toBe(false);
  expect(second.read(second.controls$).canMutateTabs).toBe(true);
});

it("distinguishes retained selection, external loss and disconnected transport", () => {
  const model = createViewerModel();
  model.run(model.configure$, { interactive: true, scoped: false });
  model.run(model.setConnected$, true);
  const targets = [{ id: "page-a", title: "A" }];
  updateModel(model, { targets });
  model.transition({ type: "select", targetId: "page-a", paused: false });
  model.update({ navigation: navigation("https://one.invalid/") });
  model.transition({ type: "streaming" });
  model.transition({ type: "paused" });
  expect(model.getSnapshot()).toMatchObject({
    status: "paused",
    selectedTargetId: "page-a",
    navigation: null,
  });
  model.transition({
    type: "target-lost",
    error: { kind: "target-unavailable", message: "Synthetic target loss" },
  });
  expect(model.getSnapshot()).toMatchObject({
    selectedTargetId: null,
    status: "unavailable",
    targets,
    navigation: null,
  });
  expect(model.read(model.controls$).canCreate).toBe(false);
  model.transition({ type: "select", targetId: "page-a", paused: false });
  model.transition({
    type: "disconnected",
    established: true,
    error: { kind: "connection", message: "Synthetic disconnect" },
  });
  expect(model.getSnapshot()).toMatchObject({
    selectedTargetId: "page-a",
    status: "disconnected",
  });
  expect(model.read(model.controls$).canMutateTabs).toBe(false);
  model.run(model.setTabAction$, { type: "close", targetId: "page-a" });
  model.transition({ type: "reset" });
  expect(model.getSnapshot()).toMatchObject({
    status: "connecting",
    targets: [],
    selectedTargetId: null,
    error: null,
    navigation: null,
  });
  expect(model.read(model.tabAction$)).toBeNull();
});

it("isolates viewer commands, drafts and reconnects, including stale runtime cleanup", () => {
  const first = createViewerModel();
  const second = createViewerModel();
  first.update({
    navigation: navigation("https://one.invalid/"),
  });
  first.transition({ type: "streaming" });
  second.update({
    navigation: navigation("https://two.invalid/"),
  });
  second.transition({ type: "streaming" });
  const actions = () => ({
    select: vi.fn(),
    navigate: vi.fn(),
    createTab: vi.fn(),
    closeTab: vi.fn(),
  });
  const original = actions();
  const replacement = actions();
  const other = actions();
  first.run(first.bind$, original);
  second.run(second.bind$, other);
  first.run(first.createTab$);
  first.run(first.closeTab$, "page-a");
  expect(original.createTab).toHaveBeenCalledOnce();
  expect(original.closeTab).toHaveBeenCalledWith("page-a");
  expect(other.createTab).not.toHaveBeenCalled();
  first.run(first.setTabAction$, { type: "create" });
  expect(second.read(second.tabAction$)).toBeNull();
  first.run(first.focusAddress$);
  first.run(first.editAddress$, "  https://draft.invalid/  ");
  expect(second.read(second.address$)).toBe("https://two.invalid/");
  first.run(first.submitAddress$);
  expect(original.navigate).toHaveBeenCalledWith({
    url: "https://draft.invalid/",
  });
  expect(other.navigate).not.toHaveBeenCalled();
  first.run(first.reconnect$);
  expect(first.read(first.revision$)).toBe(1);
  expect(second.read(second.revision$)).toBe(0);
  first.run(first.bind$, replacement);
  expect(first.read(first.tabAction$)).toBeNull();
  first.run(first.unbind$, original);
  first.run(first.select$, "replacement-page");
  expect(replacement.select).toHaveBeenCalledWith("replacement-page");
  expect(original.select).not.toHaveBeenCalled();
  first.run(first.unbind$, replacement);
  first.run(first.navigate$, "reload");
  expect(replacement.navigate).not.toHaveBeenCalled();
  expect(second.getSnapshot().status).toBe("streaming");
});

it("preserves an active address draft and releases completed drafts on URL identity changes", () => {
  const model = createViewerModel();
  const initial = navigation("https://one.invalid/");
  model.update({ navigation: initial });
  model.run(model.focusAddress$);
  model.run(model.editAddress$, "https://draft.invalid/");
  model.update({ navigation: navigation("https://two.invalid/") });
  expect(model.read(model.address$)).toBe("https://draft.invalid/");
  model.run(model.blurAddress$);
  model.update({ navigation: navigation("https://three.invalid/") });
  expect(model.read(model.address$)).toBe("https://three.invalid/");
  model.update({ navigation: initial });
  expect(model.read(model.address$)).toBe(initial.url);
  model.run(model.focusAddress$);
  model.run(model.editAddress$, "https://another-draft.invalid/");
  model.run(model.blurAddress$);
  model.update({ navigation: null });
  expect(model.read(model.address$)).toBe("");
  model.update({ navigation: initial });
  expect(model.read(model.address$)).toBe(initial.url);
});

it("keeps applied demo connections independent from invalid drafts and sibling actions", () => {
  const model = createDemoModel();
  const activation = browserUse();
  const other = { id: "other", setup: vi.fn() };
  model.run(model.edit$, 1, "endpoint", "wss://first.invalid/browser");
  model.run(model.edit$, 1, "windowDraft", "0");
  model.run(model.setExtension$, 1, activation, true);
  model.run(model.setExtension$, 1, other, true);
  model.run(model.connect$, 1);
  model.run(model.add$);
  model.run(model.edit$, 2, "endpoint", "wss://second.invalid/browser");
  model.run(model.connect$, 2);
  const [first, second] = model.read(model.panels$);
  const connectedPanels = model.read(model.panels$);
  model.run(model.setAppearance$, "dark");
  expect(model.read(model.appearance$)).toBe("dark");
  expect(model.read(model.panels$)).toBe(connectedPanels);
  expect(first?.connection).toEqual({
    cdpUrl: "wss://first.invalid/browser",
    windowId: 0,
    extensions: [activation, other],
    generation: 1,
  });
  expect(second?.connection?.extensions).toEqual([]);
  model.run(model.setExtension$, 1, activation, false);
  expect(model.read(model.panels$)[0]?.extensions).toEqual([other]);
  expect(model.read(model.panels$)[0]?.connection).toBe(first?.connection);
  model.run(model.edit$, 1, "endpoint", "not a valid endpoint");
  model.run(model.connect$, 1);
  expect(model.read(model.panels$)[0]?.connection).toBe(first?.connection);
  expect(model.read(model.panels$)[0]?.error).toBe("endpoint");
  model.run(model.reconnect$, 1);
  expect(model.read(model.panels$)[0]?.connection).toEqual({
    ...first?.connection,
    generation: 2,
  });
  expect(model.read(model.panels$)[1]).toBe(second);
  model.run(model.edit$, 1, "endpoint", "wss://first.invalid/browser");
  model.run(model.connect$, 1);
  expect(model.read(model.panels$)[0]?.connection).toEqual({
    ...first?.connection,
    extensions: [other],
    generation: 3,
  });
  expect(first?.connection?.extensions).toEqual([activation, other]);
  model.run(model.remove$, 1);
  expect(model.read(model.panels$)).toEqual([second]);
  model.run(model.add$);
  expect(model.read(model.panels$).map((item) => item.id)).toEqual([2, 3]);
  model.run(model.disconnect$, 2);
  expect(model.read(model.panels$)[0]?.connection).toBeNull();
  const another = createDemoModel();
  expect(another.read(another.appearance$)).toBe("system");
  expect(another.read(another.panels$)[0]).toMatchObject({
    id: 1,
    endpoint: "",
    extensions: [],
    connection: null,
  });
});
