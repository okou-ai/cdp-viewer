import { expect, it, vi } from "vitest";
import { createDemoModel } from "../../demo/model";
import { createViewerModel } from "../../src/viewer/model";

const navigation = (url: string) => ({
  url,
  canGoBack: false,
  canGoForward: false,
});

it("isolates viewer commands, drafts and reconnects, including stale runtime cleanup", () => {
  const first = createViewerModel();
  const second = createViewerModel();
  first.update({
    navigation: navigation("https://one.invalid/"),
    status: "streaming",
  });
  second.update({
    navigation: navigation("https://two.invalid/"),
    status: "streaming",
  });
  const original = { select: vi.fn(), navigate: vi.fn() };
  const replacement = { select: vi.fn(), navigate: vi.fn() };
  const other = { select: vi.fn(), navigate: vi.fn() };
  first.run(first.bind$, original);
  second.run(second.bind$, other);
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
  model.run(model.edit$, 1, "endpoint", "wss://first.invalid/browser");
  model.run(model.edit$, 1, "windowDraft", "0");
  model.run(model.connect$, 1);
  model.run(model.add$);
  model.run(model.edit$, 2, "endpoint", "wss://second.invalid/browser");
  model.run(model.connect$, 2);
  const [first, second] = model.read(model.panels$);
  expect(first?.connection).toEqual({
    cdpUrl: "wss://first.invalid/browser",
    windowId: 0,
    generation: 1,
  });
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
  model.run(model.remove$, 1);
  expect(model.read(model.panels$)).toEqual([second]);
  model.run(model.add$);
  expect(model.read(model.panels$).map((item) => item.id)).toEqual([2, 3]);
  model.run(model.disconnect$, 2);
  expect(model.read(model.panels$)[0]?.connection).toBeNull();
  const another = createDemoModel();
  expect(another.read(another.panels$)[0]).toMatchObject({
    id: 1,
    endpoint: "",
    connection: null,
  });
});
