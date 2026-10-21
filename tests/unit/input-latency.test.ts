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
    { push: (_data, painted) => painted(), reset() {}, dispose() {} },
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

it("collects adjacent native text while the running batch's focus guard is pending", async () => {
  const { browser, socket, input } = await mount();
  browser.holdMethod = "Runtime.callFunctionOn";
  input.text("a");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.text("bc");
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, focusResult());
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((command) => command.method === "Input.insertText")
        .map((command) => command.params?.text),
    ).toEqual(["abc"]),
  );
});

it("collects text while window membership is still being verified", async () => {
  const { browser, socket, input } = await mount(0);
  browser.holdMethod = "Browser.getWindowForTarget";
  input.text("a");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.text("bc");
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, { windowId: 0 });
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((command) => command.method === "Input.insertText")
        .map((command) => command.params?.text),
    ).toEqual(["abc"]),
  );
});

it("starts a new text batch once the previous payload was sent", async () => {
  const { browser, socket, input } = await mount();
  browser.holdMethod = "Input.insertText";
  input.text("a");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.text("bc");
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command);
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((command) => command.method === "Input.insertText")
        .map((command) => command.params?.text),
    ).toEqual(["a", "bc"]),
  );
});

it("seals text before sending and never merges across a key boundary", async () => {
  const { browser, socket, input } = await mount();
  browser.holdMethod = "Input.insertText";
  input.text("a");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.key({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
  input.text("bc");
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command);
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((command) => command.method.startsWith("Input."))
        .map((command) => [command.method, command.params?.text]),
    ).toEqual([
      ["Input.insertText", "a"],
      ["Input.dispatchKeyEvent", undefined],
      ["Input.insertText", "bc"],
    ]),
  );
});

it("does not merge a preflight batch across an intervening queued key", async () => {
  const { browser, socket, input } = await mount();
  browser.holdMethod = "Runtime.callFunctionOn";
  input.text("a");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.key({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
  input.text("bc");
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, focusResult());
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((command) => command.method.startsWith("Input."))
        .map((command) => [command.method, command.params?.text]),
    ).toEqual([
      ["Input.insertText", "a"],
      ["Input.dispatchKeyEvent", undefined],
      ["Input.insertText", "bc"],
    ]),
  );
});

it("keeps collecting text bounded and discards the entire old-owner batch", async () => {
  const { browser, socket, input } = await mount();
  browser.holdMethod = "Runtime.callFunctionOn";
  input.text("a".repeat(64 * 1024));
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.text("b");
  input.blur();
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, focusResult());
  input.focus();
  input.text("new owner");
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((command) => command.method === "Input.insertText")
        .map((command) => command.params?.text),
    ).toEqual(["new owner"]),
  );
});

it("does not let an optional caret response block later verified input", async () => {
  const { browser, socket, input, caret, model } = await mount();
  browser.holdMethod = "Input.dispatchKeyEvent";
  input.key({ type: "rawKeyDown", key: "Backspace", code: "Backspace" });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  browser.holdMethod = "Runtime.callFunctionOn";
  const key = browser.heldCommands[0]!;
  key.socket.reply(key.command);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  browser.holdMethod = null;
  input.text("after caret");
  await vi.waitFor(() =>
    expect(
      socket.commands.find((command) => command.method === "Input.insertText")
        ?.params?.text,
    ).toBe("after caret"),
  );
  input.blur();
  const stale = browser.heldCommands[1]!;
  stale.socket.reply(stale.command, focusResult(400));
  input.focus();
  input.text("recovered");
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((command) => command.method === "Input.insertText")
        .length,
    ).toBe(2),
  );
  expect(caret).toHaveBeenCalledTimes(2);
  expect(caret.mock.calls.every(([point]) => point.x === 10 / 800)).toBe(true);
  expect(model.getSnapshot().error).toBeNull();
});

it("ignores an old caret after a new focus handoff within the same owner", async () => {
  const { browser, socket, input, caret } = await mount();
  const owner = input.owner;
  browser.holdMethod = "Input.dispatchKeyEvent";
  input.key({ type: "rawKeyDown", key: "Backspace", code: "Backspace" });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  browser.holdMethod = "Runtime.callFunctionOn";
  const key = browser.heldCommands[0]!;
  key.socket.reply(key.command);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  browser.holdMethod = null;
  input.focus();
  await vi.waitFor(() => expect(caret).toHaveBeenCalledTimes(2));
  expect(input.owner).toBe(owner);
  const stale = browser.heldCommands[1]!;
  stale.socket.reply(stale.command, focusResult(400));
  input.text("latest focus");
  await vi.waitFor(() =>
    expect(
      socket.commands.find((command) => command.method === "Input.insertText")
        ?.params?.text,
    ).toBe("latest focus"),
  );
  expect(caret).toHaveBeenCalledTimes(2);
  expect(caret.mock.calls.every(([point]) => point.x === 10 / 800)).toBe(true);
});

it("bounds each batch while text is collected during preflight", async () => {
  const { browser, socket, input } = await mount();
  browser.holdMethod = "Runtime.callFunctionOn";
  input.text("a".repeat(64 * 1024 - 1));
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.text("bc");
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, focusResult());
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((command) => command.method === "Input.insertText")
        .map((command) => String(command.params?.text).length),
    ).toEqual([64 * 1024 - 1, 2]),
  );
});

it("keeps only one caret read and the newest requested refresh", async () => {
  const { browser, socket, input, caret } = await mount();
  browser.holdMethod = "Input.dispatchKeyEvent";
  input.key({ type: "rawKeyDown", key: "Backspace", code: "Backspace" });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  browser.holdMethod = "Runtime.callFunctionOn";
  const key = browser.heldCommands[0]!;
  key.socket.reply(key.command);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  browser.holdMethod = null;
  const before = socket.commands.length;
  input.key({ type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft" });
  input.key({ type: "rawKeyDown", key: "ArrowRight", code: "ArrowRight" });
  await vi.waitFor(() =>
    expect(
      socket.commands.filter(
        (command) => command.method === "Input.dispatchKeyEvent",
      ),
    ).toHaveLength(3),
  );
  const held = browser.heldCommands[1]!;
  held.socket.reply(held.command, focusResult(400));
  await vi.waitFor(() => expect(caret).toHaveBeenCalledTimes(2));
  expect(
    socket.commands
      .slice(before)
      .filter((command) => command.method === "Runtime.callFunctionOn"),
  ).toHaveLength(3); // Two write guards, then one newest optional read.
  expect(caret.mock.calls.every(([point]) => point.x === 10 / 800)).toBe(true);
});

it("does not clear a newer navigation error when optional geometry succeeds", async () => {
  const { browser, input, caret, model } = await mount();
  browser.holdMethod = "Input.dispatchKeyEvent";
  input.key({ type: "rawKeyDown", key: "Backspace", code: "Backspace" });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  browser.holdMethod = "Runtime.callFunctionOn";
  const key = browser.heldCommands[0]!;
  key.socket.reply(key.command);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  input.navigate({ url: "invalid" });
  const error = model.getSnapshot().error;
  expect(error?.message).toContain("absolute http:// or https://");
  browser.holdMethod = null;
  const held = browser.heldCommands[1]!;
  held.socket.reply(held.command, focusResult());
  await vi.waitFor(() => expect(caret).toHaveBeenCalledTimes(2));
  expect(model.getSnapshot().error).toEqual(error);
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
  const adapter = new NativeInput(canvas, proxy, () => input);
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
