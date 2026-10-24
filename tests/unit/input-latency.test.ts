import { afterEach, expect, it, vi } from "vitest";
import { NativeInput } from "../../src/input/native";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";

const controllers: ViewerController[] = [];
const adapters: NativeInput[] = [];
afterEach(() => {
  adapters.splice(0).forEach((input) => input.dispose());
  controllers.splice(0).forEach((controller) => controller.close());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function focusResult(x = 10) {
  return {
    result: {
      value: {
        editable: true,
        supported: true,
        x,
        y: 20,
        width: 800,
        height: 600,
        offsetX: 0,
        offsetY: 0,
      },
    },
  };
}

async function mount(windowId?: number) {
  const browser = new FakeBrowser();
  const model = createViewerModel();
  const caret = vi.fn();
  const controller = new ViewerController(
    model,
    {
      push: (_data, painted) => painted({ width: 800, height: 600 }),
      invalidate() {},
      reset() {},
      dispose() {},
    },
    {
      url: "wss://fixture.invalid/",
      socketFactory: browser.factory,
      interactive: true,
      onCaret: caret,
      ...(windowId === undefined ? {} : { windowId }),
    },
  );
  controllers.push(controller);
  controller.start();
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const input = controller.input!;
  input.focus();
  await vi.waitFor(() => expect(caret).toHaveBeenCalledOnce());
  const socket = browser.sockets[0]!;
  return { browser, socket, input, caret, model };
}

it("sends native text while optional caret metadata is still pending", async () => {
  const { browser, socket, input } = await mount();
  browser.holdMethod = "Runtime.evaluate";
  input.focus();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.text("a");
  input.text("bc");
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((c) => c.method === "Input.insertText")
        .map((c) => c.params?.text)
        .join(""),
    ).toBe("abc"),
  );
  expect(
    socket.commands.some((c) => c.method === "Runtime.callFunctionOn"),
  ).toBe(false);
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, focusResult());
});

it("preserves distinct text commits behind pending pointer preparation", async () => {
  const { browser, socket, input } = await mount(0);
  socket.emit("Page.frameResized", {}, input.sessionId);
  browser.holdMethod = "Page.getLayoutMetrics";
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, { buttons: 0 });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.text("a");
  input.text("bc");
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, {
    cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
  });
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((c) => c.method === "Input.insertText")
        .map((c) => c.params?.text),
    ).toEqual(["a", "bc"]),
  );
});

it("sends later immutable text payloads without waiting for earlier acknowledgements", async () => {
  const { browser, socket, input } = await mount();
  browser.holdMethod = "Input.insertText";
  input.text("a");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.text("bc");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  expect(
    socket.commands
      .filter((c) => c.method === "Input.insertText")
      .map((c) => c.params?.text),
  ).toEqual(["a", "bc"]);
  browser.holdMethod = null;
  for (const held of browser.heldCommands) held.socket.reply(held.command);
});

it("preserves text/key send order while input acknowledgements are held", async () => {
  const { browser, socket, input } = await mount();
  browser.holdMethod = "Input.insertText";
  input.text("a");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.key({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
  input.text("bc");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  expect(
    socket.commands
      .filter((c) => c.method.startsWith("Input."))
      .map((c) => [c.method, c.params?.text]),
  ).toEqual([
    ["Input.insertText", "a"],
    ["Input.dispatchKeyEvent", undefined],
    ["Input.insertText", "bc"],
  ]);
  browser.holdMethod = null;
  for (const held of browser.heldCommands) held.socket.reply(held.command);
});

it("does not merge a preflight text batch across a queued key", async () => {
  const { browser, socket, input } = await mount(0);
  socket.emit("Page.frameResized", {}, input.sessionId);
  browser.holdMethod = "Page.getLayoutMetrics";
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, { buttons: 0 });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.text("a");
  input.key({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
  input.text("bc");
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, {
    cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
  });
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((c) => c.method.startsWith("Input."))
        .map((c) => [c.method, c.params?.text]),
    ).toEqual([
      ["Input.dispatchMouseEvent", undefined],
      ["Input.insertText", "a"],
      ["Input.dispatchKeyEvent", undefined],
      ["Input.insertText", "bc"],
    ]),
  );
});

it("discards queued old-owner text while retaining the per-payload bound", async () => {
  const { browser, socket, input } = await mount(0);
  socket.emit("Page.frameResized", {}, input.sessionId);
  browser.holdMethod = "Page.getLayoutMetrics";
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, { buttons: 0 });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.text("a".repeat(64 * 1024));
  input.text("b");
  input.blur();
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, {
    cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
  });
  input.focus();
  input.text("new owner");
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((c) => c.method === "Input.insertText")
        .map((c) => c.params?.text),
    ).toEqual(["new owner"]),
  );
});

it("keeps commits bounded and separate during scoped preparation", async () => {
  const { browser, socket, input } = await mount(0);
  socket.emit("Page.frameResized", {}, input.sessionId);
  browser.holdMethod = "Page.getLayoutMetrics";
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, { buttons: 0 });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.text("a".repeat(64 * 1024 - 1));
  input.text("bc");
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, {
    cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
  });
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((c) => c.method === "Input.insertText")
        .map((c) => String(c.params?.text).length),
    ).toEqual([64 * 1024 - 1, 2]),
  );
});

it("bounds in-flight writes and recovers after old replies settle without replay", async () => {
  const { browser, socket, input, model } = await mount();
  vi.useFakeTimers();
  browser.holdMethod = "Input.insertText";
  for (let index = 0; index < 64; index++) {
    input.text("a");
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(browser.heldCommands).toHaveLength(64);
  input.text("overflow");
  expect(model.getSnapshot().error?.kind).toBe("input");
  browser.holdMethod = null;
  for (const held of browser.heldCommands) held.socket.reply(held.command);
  await vi.advanceTimersByTimeAsync(0);
  input.text("recovered");
  await vi.advanceTimersByTimeAsync(0);
  expect(
    socket.commands
      .filter((c) => c.method === "Input.insertText")
      .map((c) => c.params?.text),
  ).toEqual([...Array<string>(64).fill("a"), "recovered"]);
  expect(model.getSnapshot().error).toBeNull();
  vi.useRealTimers();
});

it("keeps one optional caret read and applies only the newest requested refresh", async () => {
  const { browser, socket, input, caret } = await mount();
  browser.holdMethod = "Runtime.evaluate";
  input.focus();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  const before = socket.commands.length;
  input.key({ type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft" });
  input.key({ type: "rawKeyDown", key: "ArrowRight", code: "ArrowRight" });
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Input.dispatchKeyEvent"),
    ).toHaveLength(2),
  );
  expect(browser.heldCommands).toHaveLength(1);
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, focusResult(400));
  await vi.waitFor(() => expect(caret).toHaveBeenCalledTimes(2));
  expect(
    socket.commands
      .slice(before)
      .filter((c) => c.method === "Runtime.evaluate"),
  ).toHaveLength(1);
  expect(caret.mock.calls.every(([point]) => point.x === 10 / 800)).toBe(true);
});

it("discards stale caret metadata across blur and refocus", async () => {
  const { browser, input, caret } = await mount();
  browser.holdMethod = "Runtime.evaluate";
  input.focus();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.blur();
  input.focus();
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, focusResult(400));
  await vi.waitFor(() => expect(caret).toHaveBeenCalledTimes(2));
  expect(caret.mock.calls.every(([point]) => point.x === 10 / 800)).toBe(true);
});

it("does not clear a newer navigation error when optional geometry succeeds", async () => {
  const { browser, input, caret, model } = await mount();
  browser.holdMethod = "Runtime.evaluate";
  input.focus();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.navigate({ url: "invalid" });
  const error = model.getSnapshot().error;
  expect(error?.message).toContain("Enter a page address");
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, focusResult());
  await vi.waitFor(() => expect(caret).toHaveBeenCalledTimes(2));
  expect(model.getSnapshot().error).toEqual(error);
});

it("forwards printable keys natively and commits composition once through text", async () => {
  const { input, socket } = await mount();
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  const proxy = document.createElement("textarea");
  stage.append(canvas, proxy);
  document.body.append(stage);
  adapters.push(new NativeInput(canvas, proxy, () => input, vi.fn()));
  proxy.focus();
  expect(
    proxy.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        keyCode: 65,
        bubbles: true,
        cancelable: true,
      }),
    ),
  ).toBe(false);
  proxy.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "a",
      code: "KeyA",
      keyCode: 65,
      bubbles: true,
      cancelable: true,
    }),
  );
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Input.dispatchKeyEvent"),
    ).toHaveLength(2),
  );
  expect(
    socket.commands
      .filter((c) => c.method === "Input.dispatchKeyEvent")
      .map((c) => c.params),
  ).toEqual([
    expect.objectContaining({ type: "keyDown", key: "a", text: "a" }),
    expect.objectContaining({ type: "keyUp", key: "a" }),
  ]);
  proxy.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "F2",
      code: "F2",
      keyCode: 113,
      bubbles: true,
      cancelable: true,
    }),
  );
  proxy.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "F2",
      code: "F2",
      keyCode: 113,
      bubbles: true,
      cancelable: true,
    }),
  );
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Input.dispatchKeyEvent"),
    ).toHaveLength(4),
  );
  expect(
    socket.commands
      .filter((c) => c.method === "Input.dispatchKeyEvent")
      .slice(-2)
      .map((c) => c.params),
  ).toEqual([
    expect.objectContaining({ type: "rawKeyDown", key: "F2", code: "F2" }),
    expect.objectContaining({ type: "keyUp", key: "F2", code: "F2" }),
  ]);
  proxy.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  proxy.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Process",
      keyCode: 229,
      isComposing: true,
      bubbles: true,
    }),
  );
  proxy.value = "中";
  // Happy DOM does not populate CompositionEvent.data from its constructor.
  const end = new Event("compositionend", { bubbles: true });
  Object.defineProperty(end, "data", { value: "中" });
  proxy.dispatchEvent(end);
  proxy.dispatchEvent(
    new InputEvent("input", {
      data: "中",
      inputType: "insertCompositionText",
      bubbles: true,
    }),
  );
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((c) => c.method === "Input.insertText")
        .map((c) => c.params?.text),
    ).toEqual(["中"]),
  );
  expect(
    socket.commands.filter((c) => c.method === "Input.dispatchKeyEvent"),
  ).toHaveLength(4);
});

it("supersedes a pending hover move at the press position while retaining drag movement", async () => {
  const { input } = await mount();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  const proxy = document.createElement("textarea");
  canvas.width = 800;
  canvas.height = 600;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 600),
  );
  stage.setPointerCapture = vi.fn();
  stage.hasPointerCapture = vi.fn(() => false);
  stage.append(canvas, proxy);
  document.body.append(stage);
  const adapter = new NativeInput(canvas, proxy, () => input, vi.fn());
  adapters.push(adapter);
  const pointer = vi.spyOn(input, "pointer");
  const event = { bubbles: true, pointerType: "mouse", pointerId: 1 };
  canvas.dispatchEvent(
    new PointerEvent("pointermove", { ...event, clientX: 100, clientY: 100 }),
  );
  canvas.dispatchEvent(
    new PointerEvent("pointerdown", { ...event, clientX: 100, clientY: 100 }),
  );
  expect(frames.size).toBe(0);
  canvas.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      clientX: 100,
      clientY: 100,
      button: 0,
      buttons: 1,
    }),
  );
  canvas.dispatchEvent(
    new PointerEvent("pointermove", {
      ...event,
      clientX: 200,
      clientY: 100,
      buttons: 1,
    }),
  );
  canvas.dispatchEvent(new PointerEvent("pointerup", event));
  expect(pointer.mock.calls.map(([type]) => type)).toEqual([
    "mousePressed",
    "mouseMoved",
  ]);
  expect(pointer.mock.calls[1]?.[1]).toEqual({ x: 0.25, y: 1 / 6 });
});
