import { afterEach, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";

const controllers: ViewerController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.close());
});

async function mount(windowId?: number, holdPaint = false) {
  const browser = new FakeBrowser();
  const model = createViewerModel();
  const paints: (() => void)[] = [];
  const caret = vi.fn();
  const controller = new ViewerController(
    model,
    {
      push: (_data, paint) => {
        const done = () => paint({ width: 800, height: 600 });
        paints.push(done);
        if (!holdPaint) done();
      },
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
  await vi.waitFor(() => expect(paints).toHaveLength(1));
  if (holdPaint) paints[0]!();
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const input = controller.input!;
  input.focus();
  await vi.waitFor(() => expect(caret).toHaveBeenCalledOnce());
  const socket = browser.sockets[0]!;
  const sessionId = socket.commands.find(
    (command) => command.method === "Page.startScreencast",
  )!.sessionId!;
  const frame = (metadata: unknown) =>
    socket.emit(
      "Page.screencastFrame",
      { sessionId: 99, data: "aW1hZ2U=", metadata },
      sessionId,
    );
  return {
    browser,
    model,
    controller,
    input,
    socket,
    sessionId,
    paints,
    frame,
  };
}

const metadata = { deviceWidth: 1000, deviceHeight: 700, pageScaleFactor: 2 };
const point = { x: 0.5, y: 0.5 };

it("uses the painted frame's scaled viewport without a pointer layout round trip", async () => {
  const { browser, input, socket, frame } = await mount();
  frame(metadata);
  browser.holdMethod = "Page.getLayoutMetrics";
  input.pointer("mouseMoved", point, { buttons: 0 });
  await vi.waitFor(() =>
    expect(
      socket.commands.find(
        (command) => command.method === "Input.dispatchMouseEvent",
      ),
    ).toMatchObject({ params: { x: 250, y: 175 } }),
  );
  expect(browser.heldCommands).toHaveLength(0);
});

it("retains displayed geometry until its replacement actually paints", async () => {
  const { input, socket, frame, paints } = await mount(undefined, true);
  frame(metadata);
  paints[1]!();
  frame({ ...metadata, deviceWidth: 1600 });
  input.pointer("mouseMoved", point, { buttons: 0 });
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent"),
    ).toHaveLength(1),
  );
  expect(
    socket.commands.find((c) => c.method === "Input.dispatchMouseEvent")?.params
      ?.x,
  ).toBe(250);
  paints[2]!();
  input.pointer("mouseMoved", point, { buttons: 0 });
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent"),
    ).toHaveLength(2),
  );
  expect(
    socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent")[1]
      ?.params?.x,
  ).toBe(400);
});

it("rejects a late pre-resize paint and falls back to fresh layout", async () => {
  const { input, socket, frame, paints, sessionId } = await mount(
    undefined,
    true,
  );
  frame(metadata);
  paints[1]!();
  frame(metadata);
  socket.emit("Page.frameResized", {}, sessionId);
  paints[2]!();
  input.pointer("mouseMoved", point, { buttons: 0 });
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent"),
    ).toHaveLength(1),
  );
  expect(
    socket.commands.find((c) => c.method === "Input.dispatchMouseEvent")
      ?.params,
  ).toMatchObject({ x: 400, y: 300 });
  expect(
    socket.commands.some((c) => c.method === "Page.getLayoutMetrics"),
  ).toBe(true);
});

it.each([undefined, { ...metadata, pageScaleFactor: 0 }])(
  "falls back when the painted replacement lacks usable geometry: %j",
  async (invalid) => {
    const { input, socket, frame } = await mount();
    frame(metadata);
    frame(invalid);
    input.pointer("mouseMoved", point, { buttons: 0 });
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent"),
      ).toHaveLength(1),
    );
    expect(
      socket.commands.find((c) => c.method === "Input.dispatchMouseEvent")
        ?.params,
    ).toMatchObject({ x: 400, y: 300 });
  },
);

it("sends scoped text and keys while background membership is pending", async () => {
  const { browser, input, socket } = await mount(0);
  browser.holdMethod = "Browser.getWindowForTarget";
  socket.emit("Target.targetInfoChanged", {});
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  const before = socket.commands.length;
  input.text("a");
  input.key({ type: "rawKeyDown", key: "Backspace", code: "Backspace" });
  input.key({ type: "keyUp", key: "Backspace", code: "Backspace" });
  input.text("bc");
  await vi.waitFor(() =>
    expect(
      socket.commands
        .slice(before)
        .filter((c) => c.method.startsWith("Input."))
        .map((c) => [c.method, c.params?.text]),
    ).toEqual([
      ["Input.insertText", "a"],
      ["Input.dispatchKeyEvent", undefined],
      ["Input.dispatchKeyEvent", undefined],
      ["Input.insertText", "bc"],
    ]),
  );
  expect(
    socket.commands
      .slice(before)
      .some((c) => c.method === "Runtime.callFunctionOn"),
  ).toBe(false);
  expect(
    socket.commands
      .slice(before)
      .some((c) => c.method === "Browser.getWindowForTarget"),
  ).toBe(false);
  browser.holdMethod = null;
  for (const held of browser.heldCommands)
    held.socket.reply(held.command, {
      windowId: held.command.params?.targetId === "page-a" ? 0 : 2,
    });
});

it.each(["moved", "failed"])(
  "cancels unsent input after background scope is %s",
  async (outcome) => {
    const { browser, input, socket, model, controller } = await mount(0);
    browser.holdMethod = "Page.getLayoutMetrics";
    input.pointer("mouseMoved", point, { buttons: 0 });
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    input.text("queued old owner");
    if (outcome === "moved") browser.targets[0]!.windowId = 2;
    else browser.unsupportedWindows = true;
    socket.emit("Target.targetInfoChanged", {});
    await vi.waitFor(() => expect(controller.input).toBeNull());
    expect(model.getSnapshot()).toMatchObject({
      status: "unavailable",
      selectedTargetId: null,
    });
    input.text("after detected loss");
    const held = browser.heldCommands[0]!;
    browser.holdMethod = null;
    held.socket.reply(held.command, {
      cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
    });
    await vi.waitFor(() =>
      expect(
        socket.commands.some((c) => c.method === "Target.detachFromTarget"),
      ).toBe(true),
    );
    expect(socket.commands.some((c) => c.method.startsWith("Input."))).toBe(
      false,
    );
  },
);

it("revalidates geometry invalidated while layout preparation is pending", async () => {
  const { browser, input, socket, sessionId } = await mount(0);
  browser.holdMethod = "Page.getLayoutMetrics";
  input.pointer("mouseMoved", point, { buttons: 0 });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  socket.emit("Page.frameResized", {}, sessionId);
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, {
    cssVisualViewport: { clientWidth: 1000, clientHeight: 700 },
  });
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent"),
    ).toHaveLength(1),
  );
  expect(
    socket.commands.find((c) => c.method === "Input.dispatchMouseEvent")
      ?.params,
  ).toMatchObject({ x: 400, y: 300 });
});

it("discards an invalidated fallback mapping without blocking current text or later pointer input", async () => {
  const { browser, input, socket, frame, sessionId, model } = await mount(0);
  frame(metadata);
  browser.holdMethod = "Browser.getWindowForTarget";
  input.pointer("mouseWheel", point, { deltaY: 120 });
  input.text("current document text");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  socket.emit("Page.frameResized", {}, sessionId);
  browser.holdMethod = "Page.getLayoutMetrics";
  const guard = browser.heldCommands[0]!;
  guard.socket.reply(guard.command, { windowId: 0 });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  const layout = browser.heldCommands[1]!;
  expect(layout.command.method).toBe("Page.getLayoutMetrics");
  socket.emit("Page.frameResized", {}, sessionId);
  browser.holdMethod = null;
  layout.socket.reply(layout.command, {
    cssVisualViewport: { clientWidth: 1111, clientHeight: 777, zoom: 1.25 },
  });
  await vi.waitFor(() =>
    expect(
      socket.commands.find((command) => command.method === "Input.insertText"),
    ).toMatchObject({ params: { text: "current document text" } }),
  );
  const pointers = () =>
    socket.commands.filter(
      (command) => command.method === "Input.dispatchMouseEvent",
    );
  expect(pointers()).toHaveLength(0);
  expect(model.getSnapshot().error).toBeNull();
  input.pointer("mouseWheel", point, { deltaY: 120 });
  await vi.waitFor(() => expect(pointers()).toHaveLength(1));
  expect(pointers()[0]!.params).toMatchObject({ x: 400, y: 300, deltaY: 120 });
});

it("coalesces unsent wheels while earlier acknowledgements remain pending", async () => {
  const { browser, input, socket, model } = await mount();
  browser.holdMethod = "Input.dispatchMouseEvent";
  input.pointer("mouseWheel", point, { deltaY: 5 });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  for (let i = 0; i < 100; i++)
    input.pointer("mouseWheel", point, { deltaY: 5 });
  expect(model.getSnapshot().error).toBeNull();
  const held = browser.heldCommands[0]!;
  expect(held.command.params?.deltaY).toBe(5);
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((c) => c.method === "Input.dispatchMouseEvent")
        .map((c) => c.params?.deltaY),
    ).toEqual([5, 5, 495]),
  );
  expect(held.command.params?.deltaY).toBe(5);
  browser.holdMethod = null;
  for (const pending of browser.heldCommands)
    pending.socket.reply(pending.command);
});

it("keeps wheel reversals, positions, modifiers and key barriers separate", async () => {
  const { browser, input, socket } = await mount();
  browser.holdMethod = "Input.dispatchMouseEvent";
  input.pointer("mouseWheel", point, { deltaY: 1 });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  input.pointer("mouseWheel", point, { deltaY: 2 });
  input.pointer("mouseWheel", point, { deltaY: -3 });
  input.pointer("mouseWheel", { x: 0.4, y: 0.5 }, { deltaY: -4 });
  input.pointer("mouseWheel", point, { deltaY: -5, modifiers: 2 });
  input.key({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
  input.pointer("mouseWheel", point, { deltaY: -6, modifiers: 2 });
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command);
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((c) => c.method === "Input.dispatchMouseEvent")
        .map((c) => c.params?.deltaY),
    ).toEqual([1, 2, -3, -4, -5, -6]),
  );
});

it.each(["Page.frameNavigated", "Runtime.executionContextsCleared"])(
  "does not restore pre-document geometry from a late paint after %s",
  async (method) => {
    const { input, socket, frame, paints, sessionId } = await mount(
      undefined,
      true,
    );
    frame(metadata);
    paints[1]!();
    frame(metadata);
    socket.emit(method, { frame: { id: "replacement" } }, sessionId);
    paints[2]!();
    input.pointer("mouseMoved", point, { buttons: 0 });
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent"),
      ).toHaveLength(1),
    );
    expect(
      socket.commands.find((c) => c.method === "Input.dispatchMouseEvent")
        ?.params,
    ).toMatchObject({ x: 400, y: 300 });
  },
);

it.each([NaN, Infinity])(
  "rejects non-finite wheel intent without a remote write: %s",
  async (deltaY) => {
    const { input, socket, model } = await mount();
    input.pointer("mouseWheel", point, { deltaY });
    expect(model.getSnapshot().error?.kind).toBe("input");
    expect(
      socket.commands.some((c) => c.method === "Input.dispatchMouseEvent"),
    ).toBe(false);
  },
);

it("starts frames during input initialization without enabling input early", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Page.getFrameTree";
  const model = createViewerModel();
  const paint = vi.fn(
    (
      _data: string,
      done: (raster: { width: number; height: number }) => void,
    ) => done({ width: 800, height: 600 }),
  );
  const controller = new ViewerController(
    model,
    { push: paint, reset() {}, dispose() {} },
    {
      url: "wss://fixture.invalid/",
      socketFactory: browser.factory,
      interactive: true,
    },
  );
  controllers.push(controller);
  controller.start();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  await vi.waitFor(() => expect(paint).toHaveBeenCalledOnce());
  expect(controller.input).toBeNull();
  expect(model.getSnapshot().status).toBe("connecting");
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command, { frameTree: { frame: { id: "main" } } });
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  expect(model.getSnapshot().status).toBe("streaming");
});
