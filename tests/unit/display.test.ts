import { afterEach, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser, fakeRaster } from "./wire";
import type { WindowSizeSync } from "../../src/index";

const controllers: ViewerController[] = [];
afterEach(() =>
  controllers.splice(0).forEach((controller) => controller.close()),
);

function mount(
  browser: FakeBrowser,
  mode: WindowSizeSync = "off",
  windowId?: number,
  requestTimeout?: number,
  onPaint?: () => void,
) {
  const model = createViewerModel();
  const controller = new ViewerController(
    model,
    {
      push: (data, painted, _failed, accept) => {
        const raster = fakeRaster(data);
        if (!accept || accept(raster)) {
          painted(raster);
          onPaint?.();
        }
      },
      reset() {},
      invalidate() {},
      dispose() {},
    },
    {
      url: "wss://fixture.invalid",
      socketFactory: browser.factory,
      interactive: true,
      ...(windowId === undefined ? {} : { windowId }),
      ...(requestTimeout === undefined ? {} : { requestTimeout }),
    },
  );
  controllers.push(controller);
  controller.measureDisplay({ width: 640, height: 480, dpr: 2 });
  controller.setWindowSizeSync(mode);
  controller.start();
  return { controller, model };
}
const resizes = (browser: FakeBrowser) =>
  browser.sockets
    .flatMap((socket) => socket.commands)
    .filter((command) => command.method === "Browser.setContentsSize");
const emulations = (browser: FakeBrowser) =>
  browser.sockets
    .flatMap((socket) => socket.commands)
    .filter(
      (command) => command.method === "Emulation.setDeviceMetricsOverride",
    );

it.each([
  ["off", "Page.getLayoutMetrics", "Page.frameResized"],
  ["initial", "Page.getLayoutMetrics", "Page.frameResized"],
  ["live", "Page.getLayoutMetrics", "Page.frameResized"],
  ["off", "Page.stopScreencast", "Page.frameResized"],
  ["initial", "Page.stopScreencast", "Page.frameResized"],
  ["live", "Page.stopScreencast", "Page.frameResized"],
  ["off", "Page.getLayoutMetrics", "Runtime.executionContextsCleared"],
] as const)(
  "reprepares %s sync when %s is invalidated by %s before a display write",
  async (mode, boundary, event) => {
    const browser = new FakeBrowser();
    browser.browserZoom = 1.25;
    const { controller, model } = mount(browser, "off", 0);
    await vi.waitFor(() => expect(controller.input).not.toBeNull());
    const input = controller.input!,
      socket = browser.sockets[0]!;
    socket.holdReplyMethod = boundary;
    if (mode === "off") controller.syncDisplay();
    else controller.setWindowSizeSync(mode);
    await vi.waitFor(() => expect(socket.heldReplies).toHaveLength(1));
    browser.browserZoom = 0.8;
    socket.emit(event, {}, input.sessionId);
    socket.holdReplyMethod = null;
    const held = socket.heldReplies.shift()!;
    socket.reply(held.command, held.result);
    await vi.waitFor(() => expect(emulations(browser)).toHaveLength(1));
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    // Retire the stale preparation rather than briefly applying its old units.
    expect(emulations(browser)[0]!.params).toMatchObject({
      width: 512,
      height: 384,
      deviceScaleFactor: 2.5,
      scale: 2.5,
    });
    expect(resizes(browser)).toHaveLength(1);
    expect(resizes(browser)[0]!.params).toEqual({
      windowId: 0,
      width: 1280,
      height: 960,
    });
    expect(model.getSnapshot().error).toBeNull();
    input.pointer("mouseMoved", { x: 0.25, y: 0.5 }, {});
    await input.completion(input.owner!);
    expect(
      socket.commands
        .filter((command) => command.method === "Input.dispatchMouseEvent")
        .at(-1)?.params,
    ).toMatchObject({ x: 400, y: 600 });
    expect(
      socket.commands.filter(
        (command) => command.method === "Page.getLayoutMetrics",
      ),
    ).toHaveLength(3);
    expect(
      socket.commands.filter(
        (command) => command.method === "Page.startScreencast",
      ),
    ).toHaveLength(2);
    expect(
      socket.commands.filter(
        (command) => command.method === "Target.attachToTarget",
      ),
    ).toHaveLength(1);
  },
);

it("retains manual priority over measurements when invalidated preparation waits for a visible surface", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "live", 0);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  const input = controller.input!,
    socket = browser.sockets[0]!;
  socket.holdReplyMethod = "Page.getLayoutMetrics";
  controller.syncDisplay();
  await vi.waitFor(() => expect(socket.heldReplies).toHaveLength(1));
  controller.measureDisplay({ width: 800, height: 600, dpr: 2 });
  controller.measureDisplay(null);
  browser.browserZoom = 0.8;
  socket.emit("Page.frameResized", {}, input.sessionId);
  socket.holdReplyMethod = null;
  const held = socket.heldReplies.shift()!;
  socket.reply(held.command, held.result);
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      ready: false,
      pending: false,
    }),
  );
  controller.setWindowSizeSync("off");
  controller.measureDisplay({ width: 900, height: 700, dpr: 1.5 });
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  expect(resizes(browser)[1]!.params).toEqual({
    windowId: 0,
    width: 1350,
    height: 1050,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(model.getSnapshot().error).toBeNull();
  expect(controller.input).toBe(input);
});

it.each(
  (["off", "initial", "live"] as const).flatMap((mode) =>
    (["Page.getLayoutMetrics", "Page.stopScreencast"] as const).flatMap(
      (boundary) =>
        [false, true].map((offFirst) => [mode, boundary, offFirst] as const),
    ),
  ),
)(
  "retains manual intent from %s at %s with off-before-hidden=%s",
  async (mode, boundary, offFirst) => {
    const browser = new FakeBrowser();
    const { controller, model } = mount(browser, "off", 0);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const input = controller.input!;
    const socket = browser.sockets[0]!;
    socket.holdReplyMethod = boundary;
    controller.setWindowSizeSync(mode);
    controller.syncDisplay();
    await vi.waitFor(() => expect(socket.heldReplies).toHaveLength(1));
    if (offFirst) controller.setWindowSizeSync("off");
    controller.measureDisplay(null);
    if (!offFirst) controller.setWindowSizeSync("off");
    controller.measureDisplay({ width: 900, height: 700, dpr: 1.5 });
    socket.holdReplyMethod = null;
    const held = socket.heldReplies.shift()!;
    socket.reply(held.command, held.result);
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    expect(resizes(browser)[0]!.params).toEqual({
      windowId: 0,
      width: 1350,
      height: 1050,
    });
    expect(emulations(browser)).toHaveLength(1);
    expect(emulations(browser)[0]!.params).toMatchObject({
      width: 900,
      height: 700,
      deviceScaleFactor: 1.5,
    });
    controller.measureDisplay({ width: 1000, height: 800, dpr: 2 });
    expect(model.read(model.display$).pending).toBe(false);
    expect(resizes(browser)).toHaveLength(1);
    expect(controller.input).toBe(input);
    expect(model.getSnapshot().error).toBeNull();
    expect(
      socket.commands.filter(
        (command) => command.method === "Target.attachToTarget",
      ),
    ).toHaveLength(1);
  },
);

it("requires compatible painted pixels after native acknowledgements while retaining text and owned release", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const input = controller.input!,
    socket = browser.sockets[0]!;
  const pointers = () =>
    socket.commands.filter(
      (command) => command.method === "Input.dispatchMouseEvent",
    );
  input.pointer(
    "mousePressed",
    { x: 0.5, y: 0.5 },
    { button: "left", buttons: 1 },
  );
  await input.completion(input.owner!);
  expect(pointers()).toHaveLength(1);
  browser.holdFrames = true;
  controller.syncDisplay();
  await vi.waitFor(() =>
    expect(browser.windowSizes.get(0)).toEqual({ width: 1280, height: 960 }),
  );
  expect(model.read(model.display$)).toMatchObject({
    pending: true,
    pointerBlocked: true,
  });
  const reads = socket.commands.filter(
    (command) => command.method === "Page.getLayoutMetrics",
  ).length;
  input.pointer("mouseMoved", { x: 0.9, y: 0.9 }, {});
  input.pointer(
    "mousePressed",
    { x: 0.9, y: 0.9 },
    { button: "left", buttons: 1 },
  );
  input.pointer(
    "mouseReleased",
    { x: 0.9, y: 0.9 },
    { button: "left", buttons: 0 },
  );
  input.text("while waiting");
  await input.completion(input.owner!);
  expect(pointers()).toHaveLength(2);
  expect(pointers()[1]!.params).toMatchObject({
    type: "mouseReleased",
    x: 400,
    y: 300,
  });
  expect(
    socket.commands.filter(
      (command) => command.method === "Page.getLayoutMetrics",
    ),
  ).toHaveLength(reads);
  expect(
    socket.commands.find((command) => command.method === "Input.insertText")
      ?.params,
  ).toEqual({ text: "while waiting" });
  // New metadata does not make an old decoded raster a usable image.
  socket.emit(
    "Page.screencastFrame",
    {
      sessionId: 888,
      data: btoa(JSON.stringify({ width: 800, height: 600 })),
      metadata: { deviceWidth: 1280, deviceHeight: 960, pageScaleFactor: 1 },
    },
    input.sessionId,
  );
  await input.completion(input.owner!);
  expect(model.read(model.display$)).toMatchObject({
    pending: true,
    pointerBlocked: true,
  });
  socket.emit(
    "Page.screencastFrame",
    {
      sessionId: 889,
      data: btoa(JSON.stringify({ width: 1280, height: 958 })),
      metadata: { deviceWidth: 1280, deviceHeight: 960, pageScaleFactor: 1 },
    },
    input.sessionId,
  );
  expect(model.read(model.display$)).toMatchObject({
    pending: true,
    pointerBlocked: true,
  });
  // The inconsistent raster requests one fenced refresh. Release its frame,
  // rather than relying on now-obsolete frames from before that fence.
  await vi.waitFor(() =>
    expect(
      socket.commands.filter(
        (command) => command.method === "Page.startScreencast",
      ),
    ).toHaveLength(3),
  );
  for (const deliver of browser.heldFrames.splice(0)) deliver();
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: false,
    }),
  );
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {});
  await input.completion(input.owner!);
  expect(pointers()).toHaveLength(3);
  expect(pointers()[2]!.params).toMatchObject({ x: 640, y: 480 });
  expect(
    socket.commands.filter(
      (command) => command.method === "Page.getLayoutMetrics",
    ),
  ).toHaveLength(reads);
});

it("retires an awaiting-presentation transaction when its target is replaced", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  browser.targets[1]!.windowId = 0;
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  browser.holdFrames = true;
  controller.syncDisplay();
  await vi.waitFor(() => expect(browser.windowSizes.has(0)).toBe(true));
  expect(model.read(model.display$).pending).toBe(true);
  controller.select("page-b");
  browser.holdFrames = false;
  for (const deliver of browser.heldFrames.splice(0)) deliver();
  await vi.waitFor(() => expect(controller.input?.sessionId).toBe("session-2"));
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(model.getSnapshot().error).toBeNull();
});

it.each(["before", "after"] as const)(
  "refreshes a clipped static image observed %s the final acknowledgement and drains the latest live size",
  async (timing) => {
    const browser = new FakeBrowser();
    const painted = vi.fn();
    const { controller, model } = mount(
      browser,
      "initial",
      0,
      undefined,
      painted,
    );
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    const input = controller.input!,
      socket = browser.sockets[0]!;
    const starts = () =>
      socket.commands.filter(
        (command) => command.method === "Page.startScreencast",
      );
    const before = starts().length;
    browser.holdFrames = true;
    if (timing === "before") socket.holdReplyMethod = "Browser.setContentsSize";
    controller.measureDisplay({ width: 800, height: 600, dpr: 2 });
    controller.setWindowSizeSync("live");
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
    const paints = painted.mock.calls.length;
    socket.emit(
      "Page.screencastFrame",
      {
        sessionId: 888,
        data: btoa(JSON.stringify({ width: 1600, height: 960 })),
        metadata: { deviceWidth: 1600, deviceHeight: 1200, pageScaleFactor: 1 },
      },
      input.sessionId,
    );
    if (timing === "before") {
      socket.holdReplyMethod = null;
      const held = socket.heldReplies.shift()!;
      socket.reply(held.command, held.result);
    } else expect(painted).toHaveBeenCalledTimes(paints);
    await vi.waitFor(() => expect(starts()).toHaveLength(before + 1));
    expect(model.read(model.display$)).toMatchObject({
      pending: true,
      pointerBlocked: true,
    });
    expect(resizes(browser)).toHaveLength(2);
    input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {});
    input.text("while refreshing clipped pixels");
    await input.completion(input.owner!);
    expect(
      socket.commands.some(
        (command) => command.method === "Input.dispatchMouseEvent",
      ),
    ).toBe(false);
    expect(
      socket.commands.find((command) => command.method === "Input.insertText")
        ?.params,
    ).toEqual({ text: "while refreshing clipped pixels" });
    controller.measureDisplay({ width: 900, height: 650, dpr: 2 });
    const fresh = browser.heldFrames.pop()!;
    for (const deliver of browser.heldFrames.splice(0)) deliver();
    expect(model.read(model.display$).pointerBlocked).toBe(true);
    browser.holdFrames = false;
    fresh();
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(3));
    await vi.waitFor(() =>
      expect(model.read(model.display$)).toMatchObject({
        pending: false,
        pointerBlocked: false,
      }),
    );
    expect(resizes(browser)[2]!.params).toEqual({
      windowId: 0,
      width: 1800,
      height: 1300,
    });
    expect(starts()).toHaveLength(before + 1);
    expect(controller.input).toBe(input);
    expect(browser.sockets).toHaveLength(1);
    expect(
      socket.commands.filter(
        (command) => command.method === "Target.attachToTarget",
      ),
    ).toHaveLength(1);
    expect(model.getSnapshot().error).toBeNull();
  },
);

it("keeps the existing stream for stale metadata while a compatible static image is delayed", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  const input = controller.input!,
    socket = browser.sockets[0]!;
  browser.holdFrames = true;
  controller.measureDisplay({ width: 800, height: 600, dpr: 2 });
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  socket.emit(
    "Page.screencastFrame",
    {
      sessionId: 888,
      data: btoa(JSON.stringify({ width: 1280, height: 800 })),
      metadata: { deviceWidth: 1280, deviceHeight: 960, pageScaleFactor: 1 },
    },
    input.sessionId,
  );
  await input.completion(input.owner!);
  expect(model.read(model.display$)).toMatchObject({
    pending: true,
    pointerBlocked: true,
  });
  for (const deliver of browser.heldFrames.splice(0)) deliver();
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(
    socket.commands.filter(
      (command) => command.method === "Page.startScreencast",
    ),
  ).toHaveLength(1);
  expect(model.getSnapshot().error).toBeNull();
});

it.each([false, true])(
  "bounds persistent clipped images to one refresh and rollback with same-raster=%s",
  async (sameRaster) => {
    const browser = new FakeBrowser();
    const { controller, model } = mount(browser, "initial", 0, 100);
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    const socket = browser.sockets[0]!;
    const emit = socket.emit.bind(socket);
    vi.spyOn(socket, "emit").mockImplementation((method, params, sessionId) => {
      if (method === "Page.screencastFrame") {
        const frame = params as { metadata?: { deviceWidth: number } };
        if (frame.metadata)
          params = {
            ...params,
            data: btoa(
              JSON.stringify({ width: frame.metadata.deviceWidth, height: 1 }),
            ),
          };
      }
      emit(method, params, sessionId);
    });
    controller.measureDisplay(
      sameRaster
        ? { width: 320, height: 240, dpr: 4 }
        : { width: 800, height: 600, dpr: 2 },
    );
    controller.syncDisplay();
    await vi.waitFor(() =>
      expect(model.getSnapshot().error?.message).toContain(
        "recovery could not be confirmed",
      ),
    );
    expect(model.read(model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: true,
    });
    expect(resizes(browser)).toHaveLength(2);
    expect(
      socket.commands.filter(
        (command) => command.method === "Page.startScreencast",
      ),
    ).toHaveLength(3);
    expect(
      socket.commands.filter(
        (command) => command.method === "Emulation.clearDeviceMetricsOverride",
      ),
    ).toHaveLength(1);
  },
);

it("charges a conditional capture refresh to the original presentation budget", async () => {
  vi.useFakeTimers();
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "initial", 0, 1000);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(resizes(browser)).toHaveLength(1);
    expect(model.read(model.display$).pending).toBe(false);
    const input = controller.input!,
      socket = browser.sockets[0]!;
    browser.holdFrames = true;
    controller.measureDisplay({ width: 800, height: 600, dpr: 2 });
    controller.syncDisplay();
    await vi.advanceTimersByTimeAsync(150);
    expect(resizes(browser)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(600);
    socket.holdReplyMethod = "Page.stopScreencast";
    socket.emit(
      "Page.screencastFrame",
      {
        sessionId: 888,
        data: btoa(JSON.stringify({ width: 1600, height: 960 })),
        metadata: { deviceWidth: 1600, deviceHeight: 1200, pageScaleFactor: 1 },
      },
      input.sessionId,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.heldReplies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    socket.holdReplyMethod = null;
    const held = socket.heldReplies.shift()!;
    socket.reply(held.command, held.result);
    await vi.advanceTimersByTimeAsync(0);
    const rollbacks = () =>
      socket.commands.filter(
        (command) => command.method === "Emulation.clearDeviceMetricsOverride",
      );
    await vi.advanceTimersByTimeAsync(99);
    expect(rollbacks()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(rollbacks()).toHaveLength(1);
    for (const deliver of browser.heldFrames.splice(0)) deliver();
    await vi.advanceTimersByTimeAsync(0);
    expect(model.read(model.display$).pending).toBe(false);
    expect(model.getSnapshot().error?.message).toContain(
      "synchronized image did not arrive",
    );
  } finally {
    controller.close();
    vi.useRealTimers();
  }
});

it.each(["replace", "pause", "close"] as const)(
  "retires a clipped-image refresh on selection %s before its stop acknowledgement",
  async (action) => {
    const browser = new FakeBrowser();
    browser.targets.push({ id: "page-c", windowId: 0, title: "Replacement" });
    const { controller, model } = mount(browser, "initial", 0);
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    const input = controller.input!,
      socket = browser.sockets[0]!;
    browser.holdFrames = true;
    socket.holdReplyMethod = "Page.stopScreencast";
    controller.measureDisplay({ width: 800, height: 600, dpr: 2 });
    controller.syncDisplay();
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
    socket.emit(
      "Page.screencastFrame",
      {
        sessionId: 888,
        data: btoa(JSON.stringify({ width: 1600, height: 960 })),
        metadata: { deviceWidth: 1600, deviceHeight: 1200, pageScaleFactor: 1 },
      },
      input.sessionId,
    );
    await vi.waitFor(() => expect(socket.heldReplies).toHaveLength(1));
    if (action === "replace") controller.select("page-c");
    else if (action === "pause") controller.setPaused(true);
    else controller.close();
    browser.holdFrames = false;
    socket.holdReplyMethod = null;
    const held = socket.heldReplies.shift()!;
    socket.reply(held.command, held.result);
    for (const deliver of browser.heldFrames.splice(0)) deliver();
    await vi.waitFor(() =>
      expect(
        socket.commands.some(
          (command) =>
            command.method === "Target.detachFromTarget" &&
            command.params?.sessionId === input.sessionId,
        ),
      ).toBe(true),
    );
    expect(
      socket.commands.filter(
        (command) =>
          command.method === "Page.startScreencast" &&
          command.sessionId === input.sessionId,
      ),
    ).toHaveLength(1);
    expect(
      socket.commands.some(
        (command) =>
          command.method === "Page.createIsolatedWorld" &&
          command.sessionId === input.sessionId,
      ),
    ).toBe(false);
    if (action === "replace") {
      await vi.waitFor(() =>
        expect(controller.input?.sessionId).toBe("session-2"),
      );
      expect(model.getSnapshot().error).toBeNull();
    } else expect(controller.input).toBeNull();
  },
);

it("retains capture preferences and zoom while a sibling progresses through a clipped-image refresh", async () => {
  const browser = new FakeBrowser();
  browser.nativeDpr = 2;
  browser.browserZoom = 1.25;
  const a = mount(browser, "initial", 0);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(a.model.read(a.model.display$).pending).toBe(false),
  );
  const input = a.controller.input!,
    socket = browser.sockets[0]!;
  a.controller.setCapture({ quality: 37, maxWidth: 700, maxHeight: 500 });
  await vi.waitFor(() =>
    expect(
      socket.commands.filter(
        (command) => command.method === "Page.startScreencast",
      ),
    ).toHaveLength(2),
  );
  browser.holdFrames = true;
  socket.holdReplyMethod = "Page.stopScreencast";
  a.controller.measureDisplay({ width: 800, height: 600, dpr: 2 });
  a.controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  socket.emit(
    "Page.screencastFrame",
    {
      sessionId: 888,
      data: btoa(JSON.stringify({ width: 667, height: 400 })),
      metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1 },
    },
    input.sessionId,
  );
  await vi.waitFor(() => expect(socket.heldReplies).toHaveLength(1));
  a.controller.setCapture({ quality: 31, maxWidth: 650, maxHeight: 400 });
  browser.holdFrames = false;
  const b = mount(browser, "initial", 2);
  await vi.waitFor(() => expect(browser.windowSizes.has(2)).toBe(true));
  await vi.waitFor(() =>
    expect(b.model.read(b.model.display$).pending).toBe(false),
  );
  b.controller.input!.text("independent sibling");
  await b.controller.input!.completion(b.controller.input!.owner!);
  expect(
    browser.sockets[1]!.commands.some(
      (command) => command.method === "Input.insertText",
    ),
  ).toBe(true);
  expect(a.model.read(a.model.display$)).toMatchObject({
    pending: true,
    pointerBlocked: true,
  });
  socket.holdReplyMethod = null;
  const held = socket.heldReplies.shift()!;
  socket.reply(held.command, held.result);
  await vi.waitFor(() =>
    expect(a.model.read(a.model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: false,
    }),
  );
  const starts = socket.commands.filter(
    (command) => command.method === "Page.startScreencast",
  );
  expect(starts).toHaveLength(3);
  expect(starts[2]!.params).toEqual({
    format: "jpeg",
    quality: 31,
    maxWidth: 650,
    maxHeight: 400,
  });
  expect(
    emulations(browser).find((command) => command.sessionId === input.sessionId)
      ?.params,
  ).toMatchObject({ deviceScaleFactor: 1.6, scale: 0.8 });
  expect(a.controller.input).toBe(input);
  expect(a.model.getSnapshot().error).toBeNull();
  expect(b.model.getSnapshot().error).toBeNull();
});

it("does not await a nonexistent new image for an already presented manual size", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  browser.holdFrames = true;
  controller.syncDisplay();
  expect(model.read(model.display$).pending).toBe(true);
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: false,
    }),
  );
  expect(resizes(browser)).toHaveLength(1);
  expect(emulations(browser)).toHaveLength(1);
  expect(browser.heldFrames).toHaveLength(0);
  expect(model.getSnapshot().error).toBeNull();
});

it("keeps live updates bounded through delayed presentation and commits the newest size", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  browser.holdFrames = true;
  controller.setWindowSizeSync("live");
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  for (let index = 0; index < 100; index++)
    controller.measureDisplay({ width: 700 + index, height: 500, dpr: 2 });
  expect(resizes(browser)).toHaveLength(1);
  for (const deliver of browser.heldFrames.splice(0)) deliver();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  expect(resizes(browser)[1]!.params).toEqual({
    windowId: 0,
    width: 1598,
    height: 1000,
  });
  expect(model.read(model.display$)).toMatchObject({
    pending: true,
    pointerBlocked: true,
  });
  for (const deliver of browser.heldFrames.splice(0)) deliver();
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: false,
    }),
  );
  expect(resizes(browser)).toHaveLength(2);
});

it("bounds missing-image recovery and allows a deliberate retry without polling", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0, 35);
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  browser.holdFrames = true;
  controller.syncDisplay();
  await vi.waitFor(() =>
    expect(model.getSnapshot().error?.message).toContain(
      "recovery could not be confirmed",
    ),
  );
  expect(model.read(model.display$)).toMatchObject({
    pending: false,
    pointerBlocked: true,
  });
  expect(resizes(browser)).toHaveLength(1);
  expect(
    browser.sockets[0]!.commands.filter(
      (command) => command.method === "Emulation.clearDeviceMetricsOverride",
    ),
  ).toHaveLength(1);
  const before = browser.sockets[0]!.commands.length;
  controller.input!.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {});
  await controller.input!.completion(controller.input!.owner!);
  expect(browser.sockets[0]!.commands).toHaveLength(before);
  browser.holdFrames = false;
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: false,
    }),
  );
  expect(model.getSnapshot().error).toBeNull();
});

it("does not restore pre-invalidation geometry after an override is definitely rejected", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  controller.setWindowSizeSync("off");
  controller.measureDisplay({ width: 700, height: 500, dpr: 2 });
  browser.holdMethod = "Emulation.setDeviceMetricsOverride";
  controller.syncDisplay();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  const input = controller.input!,
    socket = browser.sockets[0]!;
  socket.emit("Page.frameResized", {}, input.sessionId);
  browser.holdMethod = null;
  socket.reject(browser.heldCommands[0]!.command);
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: true,
    }),
  );
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {});
  input.text("still owned");
  await input.completion(input.owner!);
  expect(
    socket.commands.some(
      (command) => command.method === "Input.dispatchMouseEvent",
    ),
  ).toBe(false);
  expect(
    socket.commands.some((command) => command.method === "Input.insertText"),
  ).toBe(true);
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: false,
    }),
  );
});

it("requires a post-write native capture when size and DPR change without changing raster dimensions", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  const input = controller.input!,
    socket = browser.sockets[0]!;
  browser.holdFrames = true;
  browser.frame(socket, input.sessionId);
  const old = browser.heldFrames.shift()!;
  controller.measureDisplay({ width: 320, height: 240, dpr: 4 });
  controller.syncDisplay();
  await vi.waitFor(() =>
    expect(
      socket.commands.filter(
        (command) => command.method === "Page.startScreencast",
      ),
    ).toHaveLength(3),
  );
  expect(resizes(browser)).toHaveLength(2);
  expect(resizes(browser)[1]!.params).toEqual(resizes(browser)[0]!.params);
  old();
  expect(model.read(model.display$)).toMatchObject({
    pending: true,
    pointerBlocked: true,
  });
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {});
  input.text("during a same-raster transition");
  await input.completion(input.owner!);
  expect(
    socket.commands.some(
      (command) => command.method === "Input.dispatchMouseEvent",
    ),
  ).toBe(false);
  const clock = socket.commands.find(
    (command) =>
      command.method === "Runtime.evaluate" &&
      command.params?.expression === "Date.now()",
  );
  expect(clock?.params).toMatchObject({ contextId: 42, returnByValue: true });
  expect(
    socket.commands.some(
      (command) =>
        command.method === "Page.createIsolatedWorld" &&
        command.params?.worldName === "cdp-viewer-display",
    ),
  ).toBe(true);
  for (const deliver of browser.heldFrames.splice(0)) deliver();
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: false,
    }),
  );
  old();
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {});
  await input.completion(input.owner!);
  expect(
    socket.commands
      .filter((command) => command.method === "Input.dispatchMouseEvent")
      .at(-1)?.params,
  ).toMatchObject({ x: 640, y: 480 });
  expect(
    socket.commands.filter(
      (command) => command.method === "Page.startScreencast",
    ),
  ).toHaveLength(3);
  expect(
    socket.commands.filter(
      (command) => command.method === "Target.attachToTarget",
    ),
  ).toHaveLength(1);
});

it("keeps viewing and text available when capture freshness cannot be confirmed", async () => {
  const browser = new FakeBrowser(),
    painted = vi.fn();
  const { controller, model } = mount(browser, "off", 0, 100, painted);
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  browser.unsupportedContentsSize = true;
  browser.unsupportedClock = true;
  controller.syncDisplay();
  await vi.waitFor(() =>
    expect(model.getSnapshot().error?.message).toContain(
      "recovery could not be confirmed",
    ),
  );
  expect(model.read(model.display$)).toMatchObject({
    pending: false,
    pointerBlocked: true,
  });
  const input = controller.input!,
    socket = browser.sockets[0]!,
    before = painted.mock.calls.length;
  browser.frame(socket, input.sessionId, 999, true);
  expect(painted).toHaveBeenCalledTimes(before + 1);
  expect(model.getSnapshot().status).toBe("streaming");
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {});
  input.text("viewing and text still work");
  await input.completion(input.owner!);
  expect(
    socket.commands.some(
      (command) => command.method === "Input.dispatchMouseEvent",
    ),
  ).toBe(false);
  expect(
    socket.commands.some((command) => command.method === "Input.insertText"),
  ).toBe(true);
  expect(
    socket.commands.filter(
      (command) =>
        command.method === "Runtime.evaluate" &&
        command.params?.expression === "Date.now()",
    ),
  ).toHaveLength(1);
  browser.unsupportedContentsSize = false;
  browser.unsupportedClock = false;
  controller.syncDisplay();
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: false,
    }),
  );
  expect(model.getSnapshot().error).toBeNull();
});

it("keeps the default browser untouched and manually synchronizes both layout and DPR in window zero", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  expect(resizes(browser)).toHaveLength(0);
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  expect(resizes(browser)[0]!.params).toEqual({
    windowId: 0,
    width: 1280,
    height: 960,
  });
  expect(emulations(browser)[0]).toMatchObject({
    params: {
      width: 640,
      height: 480,
      deviceScaleFactor: 2,
      scale: 2,
      dontSetVisibleSize: true,
      mobile: false,
    },
    sessionId: "session-1",
  });
  expect(model.getSnapshot().status).toBe("streaming");
  expect(browser.sockets).toHaveLength(1);
  expect(
    browser.sockets[0]!.commands.filter(
      (c) => c.method === "Target.attachToTarget",
    ),
  ).toHaveLength(1);
  expect(
    browser.sockets[0]!.commands.filter(
      (c) => c.method === "Page.stopScreencast",
    ),
  ).toHaveLength(1);
});

it("bounds live work to one running resize and one final desired geometry", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Browser.setContentsSize";
  const { controller, model } = mount(browser, "live", 0);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  for (let index = 0; index < 100; index++)
    controller.measureDisplay({ width: 700 + index, height: 500, dpr: 2 });
  expect(resizes(browser)).toHaveLength(1);
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  browser.resume(held.command, held.socket);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  expect(resizes(browser)[1]!.params).toEqual({
    windowId: 0,
    width: 1598,
    height: 1000,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(resizes(browser)).toHaveLength(2);
  expect(
    browser.sockets[0]!.commands.filter(
      (c) => c.method === "Page.startScreencast",
    ),
  ).toHaveLength(1);
});

it.each([1, 2])(
  "accounts for existing and changed browser zoom at native DPR %s",
  async (nativeDpr) => {
    const browser = new FakeBrowser();
    browser.nativeDpr = nativeDpr;
    browser.browserZoom = 1.25;
    const { controller, model } = mount(browser, "initial", 0);
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
    expect(resizes(browser)[0]!.params).toEqual({
      windowId: 0,
      width: 1280 / nativeDpr,
      height: 960 / nativeDpr,
    });
    expect(emulations(browser)[0]!.params).toMatchObject({
      width: 800,
      height: 600,
      deviceScaleFactor: 1.6,
      scale: 1.6 / nativeDpr,
    });
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    const verifyInput = async (zoom: number) => {
      await vi.waitFor(() => expect(controller.input).not.toBeNull());
      const socket = browser.sockets[0]!;
      const input = controller.input!;
      browser.frame(socket, input.sessionId);
      input.pointer("mouseMoved", { x: 0.25, y: 0.5 }, {});
      await vi.waitFor(() =>
        expect(
          socket.commands
            .filter((command) => command.method === "Input.dispatchMouseEvent")
            .at(-1)?.params,
        ).toMatchObject({
          type: "mouseMoved",
          x: 320 / nativeDpr / zoom,
          y: 480 / nativeDpr / zoom,
        }),
      );
      input.pointer(
        "mouseWheel",
        { x: 0.25, y: 0.5 },
        { deltaX: 0, deltaY: 120 },
      );
      await vi.waitFor(() => {
        const wheel = socket.commands
          .filter((command) => command.method === "Input.dispatchMouseEvent")
          .at(-1)?.params;
        expect(wheel?.type).toBe("mouseWheel");
        expect(wheel?.deltaY).toBeCloseTo(
          480 / nativeDpr / nativeDpr / zoom,
          8,
        );
      });
    };
    await verifyInput(1.25);
    browser.browserZoom = 0.8;
    controller.syncDisplay();
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
    expect(resizes(browser)[1]!.params).toEqual(resizes(browser)[0]!.params);
    expect(emulations(browser)[1]!.params).toMatchObject({
      width: 512,
      height: 384,
      deviceScaleFactor: 2.5,
      scale: 2.5 / nativeDpr,
    });
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    await verifyInput(0.8);
    expect(model.getSnapshot().error).toBeNull();
  },
);

it.each([false, true])(
  "keeps native zoom input correct with failed synchronization=%s",
  async (failSync) => {
    const browser = new FakeBrowser();
    browser.browserZoom = 1.25;
    browser.windowSizes.set(0, { width: 1000, height: 750 });
    browser.unsupportedContentsSize = failSync;
    const { controller, model } = mount(
      browser,
      failSync ? "initial" : "off",
      0,
    );
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    if (failSync)
      await vi.waitFor(() =>
        expect(model.getSnapshot().error?.kind).toBe("unsupported-capability"),
      );
    const socket = browser.sockets[0]!;
    const input = controller.input!;
    browser.frame(socket, input.sessionId);
    const events = () =>
      socket.commands.filter(
        (command) => command.method === "Input.dispatchMouseEvent",
      );
    const point = async (x: number) => {
      const previous = events().length;
      input.pointer("mouseMoved", { x: 0.25, y: 0.5 }, {});
      await vi.waitFor(() => {
        expect(events()).toHaveLength(previous + 1);
        expect(events().at(-1)?.params).toMatchObject({
          type: "mouseMoved",
          x,
        });
      });
    };
    await point(200);
    const metrics = () =>
      socket.commands.filter(
        (command) => command.method === "Page.getLayoutMetrics",
      ).length;
    const calibrated = metrics();
    await point(200);
    expect(metrics()).toBe(calibrated);
    browser.browserZoom = 0.8;
    socket.emit("Page.frameResized", {}, input.sessionId);
    browser.frame(socket, input.sessionId);
    await point(312.5);
    expect(metrics()).toBe(calibrated + 1);
    input.pointer("mouseWheel", { x: 0.25, y: 0.5 }, { deltaY: 120 });
    await vi.waitFor(() =>
      expect(
        socket.commands
          .filter((command) => command.method === "Input.dispatchMouseEvent")
          .at(-1)?.params,
      ).toMatchObject({ type: "mouseWheel", deltaY: 96 }),
    );
    expect(metrics()).toBe(calibrated + 1);
    expect(resizes(browser)).toHaveLength(failSync ? 1 : 0);
  },
);

it("initial mode restores density across tabs without fitting a resized local stage again", async () => {
  const browser = new FakeBrowser();
  browser.targets[1]!.windowId = 0;
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  controller.measureDisplay({ width: 900, height: 700, dpr: 1 });
  controller.select("page-b");
  await vi.waitFor(() => expect(emulations(browser)).toHaveLength(2));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(resizes(browser)).toHaveLength(1);
  expect(browser.windowSizes.get(0)).toEqual({ width: 1280, height: 960 });
  expect(emulations(browser).at(-1)!.params).toMatchObject({
    width: 640,
    height: 480,
    deviceScaleFactor: 2,
  });
  expect(model.getSnapshot().selectedTargetId).toBe("page-b");
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  expect(resizes(browser)[1]!.params).toEqual({
    windowId: 0,
    width: 900,
    height: 700,
  });
});

it.each(["off", "live"] as const)(
  "remembers an already presented fit when changing from %s to initial mode",
  async (mode) => {
    const browser = new FakeBrowser();
    browser.targets[1]!.windowId = 0;
    const { controller, model } = mount(browser, mode, 0);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    if (mode === "off") controller.syncDisplay();
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    controller.setWindowSizeSync("initial");
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    expect(resizes(browser)).toHaveLength(1);
    expect(emulations(browser)).toHaveLength(1);
    controller.measureDisplay({ width: 900, height: 700, dpr: 1 });
    controller.select("page-b");
    await vi.waitFor(() => expect(emulations(browser)).toHaveLength(2));
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    expect(resizes(browser)).toHaveLength(1);
    expect(browser.windowSizes.get(0)).toEqual({ width: 1280, height: 960 });
    expect(emulations(browser).at(-1)!.params).toMatchObject({
      width: 640,
      height: 480,
      deviceScaleFactor: 2,
    });
    expect(model.getSnapshot().error).toBeNull();
    expect(model.getSnapshot().selectedTargetId).toBe("page-b");
  },
);

it("retains current native bounds when restoring initial density and still enforces caps", async () => {
  const browser = new FakeBrowser();
  browser.nativeDpr = 2;
  browser.browserZoom = 0.8;
  browser.targets[1]!.windowId = 0;
  const { controller, model } = mount(browser, "initial", 0);
  controller.measureDisplay({ width: 641, height: 481, dpr: 2 });
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  const restore = async (target: string, count: number) => {
    controller.select(target);
    await vi.waitFor(() => expect(emulations(browser)).toHaveLength(count));
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
  };
  await restore("page-b", 2);
  expect(browser.windowSizes.get(0)).toEqual({ width: 641, height: 481 });
  expect(resizes(browser)).toHaveLength(1);
  browser.windowSizes.set(0, { width: 900, height: 700 });
  await restore("page-a", 3);
  expect(browser.windowSizes.get(0)).toEqual({ width: 900, height: 700 });
  expect(resizes(browser)).toHaveLength(1);
  browser.windowSizes.set(0, { width: 10000, height: 5000 });
  await restore("page-b", 4);
  const bounded = browser.windowSizes.get(0)!;
  expect(bounded.width * bounded.height * 4).toBeLessThanOrEqual(3840 * 2160);
  expect(bounded.width * 2).toBeLessThanOrEqual(4096);
  expect(bounded.height * 2).toBeLessThanOrEqual(4096);
  expect(resizes(browser)).toHaveLength(2);
  expect(model.getSnapshot().error).toBeNull();
});

it("preserves a queued manual sync when automatic synchronization is turned off", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  controller.measureDisplay({ width: 900, height: 700, dpr: 1 });
  controller.syncDisplay();
  controller.setWindowSizeSync("off");
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  expect(resizes(browser)[1]!.params).toEqual({
    windowId: 0,
    width: 900,
    height: 700,
  });
  expect(emulations(browser).at(-1)!.params).toMatchObject({
    width: 900,
    height: 700,
    deviceScaleFactor: 1,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  controller.measureDisplay({ width: 1000, height: 800, dpr: 2 });
  expect(model.read(model.display$).pending).toBe(false);
  expect(resizes(browser)).toHaveLength(2);
});

it("retains an active manual request through policy changes and fits the latest measured surface", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  browser.holdMethod = "Browser.getWindowForTarget";
  controller.syncDisplay();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.setWindowSizeSync("live");
  controller.measureDisplay({ width: 900, height: 700, dpr: 2 });
  controller.setWindowSizeSync("off");
  browser.holdMethod = null;
  const guard = browser.heldCommands[0]!;
  guard.socket.reply(guard.command, {
    windowId: 0,
    bounds: { windowState: "normal" },
  });
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  expect(resizes(browser)[0]!.params).toEqual({
    windowId: 0,
    width: 1800,
    height: 1400,
  });
  expect(emulations(browser).at(-1)!.params).toMatchObject({
    width: 900,
    height: 700,
    deviceScaleFactor: 2,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(model.getSnapshot().error).toBeNull();
});

it("clears queued busy state for a zero-area stage and resumes at the latest valid size", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  controller.setWindowSizeSync("live");
  controller.measureDisplay(null);
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      ready: false,
      pending: false,
    }),
  );
  expect(emulations(browser)).toHaveLength(0);
  expect(resizes(browser)).toHaveLength(0);
  controller.measureDisplay({ width: 900, height: 700, dpr: 1 });
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  expect(resizes(browser)[0]!.params).toEqual({
    windowId: 0,
    width: 900,
    height: 700,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      ready: true,
      pending: false,
    }),
  );
});

it.each(["Browser.getWindowForTarget", "Page.stopScreencast"])(
  "retains a manual sync while the surface becomes unavailable during %s",
  async (boundary) => {
    const browser = new FakeBrowser();
    const { controller, model } = mount(browser, "off", 0);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    browser.holdMethod = boundary;
    controller.syncDisplay();
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    controller.measureDisplay(null);
    browser.holdMethod = null;
    const held = browser.heldCommands[0]!;
    browser.resume(held.command, held.socket);
    await vi.waitFor(() =>
      expect(model.read(model.display$)).toMatchObject({
        ready: false,
        pending: false,
      }),
    );
    expect(emulations(browser)).toHaveLength(0);
    expect(resizes(browser)).toHaveLength(0);
    controller.measureDisplay({ width: 900, height: 700, dpr: 1.5 });
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
    expect(resizes(browser)[0]!.params).toEqual({
      windowId: 0,
      width: 1350,
      height: 1050,
    });
    expect(emulations(browser)[0]!.params).toMatchObject({
      width: 900,
      height: 700,
      deviceScaleFactor: 1.5,
    });
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    expect(model.getSnapshot().error).toBeNull();
  },
);

it("does not write after ownership is lost while a guard is pending", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  browser.holdMethod = "Browser.getWindowForTarget";
  controller.syncDisplay();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.setPaused(true);
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, {
    windowId: 0,
    bounds: { windowState: "normal" },
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(emulations(browser)).toHaveLength(0);
  expect(resizes(browser)).toHaveLength(0);
  expect(model.getSnapshot().status).toBe("paused");
});

it("contains unsupported display failures without leaking provider payloads or stopping viewing", async () => {
  const browser = new FakeBrowser();
  browser.unsupportedDisplay = true;
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() =>
    expect(model.getSnapshot().error?.kind).toBe("unsupported-capability"),
  );
  expect(model.getSnapshot().status).toBe("streaming");
  expect(model.getSnapshot().error?.request).toEqual({
    method: "Emulation.setDeviceMetricsOverride",
    code: -32601,
  });
  expect(JSON.stringify(model.getSnapshot())).not.toContain("private");
  expect(resizes(browser)).toHaveLength(0);
  controller.measureDisplay({ width: 700, height: 500, dpr: 2 });
  expect(emulations(browser)).toHaveLength(1);
  browser.unsupportedDisplay = false;
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() => expect(model.getSnapshot().error).toBeNull());
});

it.each([
  ["upgrade", "Page.stopScreencast"],
  ["upgrade", "Page.startScreencast"],
  ["refresh", "Page.stopScreencast"],
  ["refresh", "Page.startScreencast"],
] as const)(
  "retains preview and retry after %s loses an applied %s acknowledgement",
  async (stage, method) => {
    const browser = new FakeBrowser(),
      painted = vi.fn();
    const { controller, model } = mount(browser, "off", 0, 100, painted);
    await vi.waitFor(() => expect(controller.input).not.toBeNull());
    if (stage === "refresh") {
      controller.syncDisplay();
      await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
      await vi.waitFor(() =>
        expect(model.read(model.display$).pending).toBe(false),
      );
      // Keep the native raster identical while changing layout/density.
      controller.measureDisplay({ width: 320, height: 240, dpr: 4 });
    }
    const input = controller.input!,
      socket = browser.sockets[0]!;
    const before = socket.commands.length;
    socket.holdReplyMethod = method;
    controller.syncDisplay();
    await vi.waitFor(() => expect(socket.heldReplies).toHaveLength(1));
    socket.holdReplyMethod = null;
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    expect(model.getSnapshot().status).toBe("streaming");
    expect(model.getSnapshot().error?.kind).toBe("display");
    const transitions = socket.commands
      .slice(before)
      .filter(
        (command) =>
          command.method === "Page.stopScreencast" ||
          command.method === "Page.startScreencast",
      );
    expect(transitions.at(-1)?.method).toBe("Page.startScreencast");
    expect(transitions.length).toBeLessThanOrEqual(stage === "upgrade" ? 4 : 6);
    for (const [index, command] of transitions.entries())
      if (command.method === "Page.startScreencast")
        expect(transitions[index - 1]?.method).toBe("Page.stopScreencast");
    expect(
      transitions.every((command) => command.sessionId === input.sessionId),
    ).toBe(true);
    expect(
      transitions.find((command) => command.method === "Page.startScreencast")
        ?.params,
    ).toMatchObject(
      stage === "upgrade" && method === "Page.stopScreencast"
        ? { maxWidth: 1920, maxHeight: 1080 }
        : { maxWidth: 4096, maxHeight: 4096 },
    );
    if (stage === "upgrade")
      expect(transitions.at(-1)?.params).toMatchObject({
        maxWidth: 1920,
        maxHeight: 1080,
      });
    // Completing the original response cannot change the restored stream or owner.
    const held = socket.heldReplies.shift()!;
    socket.reply(held.command, held.result);
    input.text("after capture recovery");
    await input.completion(input.owner!);
    expect(controller.input).toBe(input);
    expect(
      socket.commands.some((command) => command.method === "Input.insertText"),
    ).toBe(true);
    const paints = painted.mock.calls.length;
    controller.measureDisplay({ width: 640, height: 480, dpr: 2 });
    controller.syncDisplay();
    await vi.waitFor(() => expect(model.getSnapshot().error).toBeNull());
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    expect(painted.mock.calls.length).toBeGreaterThan(paints);
    expect(
      socket.commands.filter(
        (command) => command.method === "Target.attachToTarget",
      ),
    ).toHaveLength(1);
  },
);

it("keeps the running preview when stopping capture is definitely rejected", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const input = controller.input!,
    socket = browser.sockets[0]!;
  browser.holdMethod = "Page.stopScreencast";
  controller.syncDisplay();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  browser.holdMethod = null;
  socket.reject(browser.heldCommands[0]!.command, -32000);
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(model.getSnapshot().status).toBe("streaming");
  expect(
    socket.commands.filter(
      (command) => command.method === "Page.startScreencast",
    ),
  ).toHaveLength(1);
  expect(emulations(browser)).toHaveLength(0);
  expect(controller.input).toBe(input);
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() => expect(model.getSnapshot().error).toBeNull());
});

it("does not restart a retired session after its capture restoration stop completes", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0, 100);
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const sessionId = controller.input!.sessionId,
    socket = browser.sockets[0]!;
  socket.holdReplyMethod = "Page.startScreencast";
  controller.syncDisplay();
  await vi.waitFor(() => expect(socket.heldReplies).toHaveLength(1));
  socket.holdReplyMethod = null;
  browser.holdMethod = "Page.stopScreencast";
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.setPaused(true);
  browser.holdMethod = null;
  const restoration = browser.heldCommands[0]!;
  browser.resume(restoration.command, restoration.socket);
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(model.getSnapshot().status).toBe("paused");
  controller.setPaused(false);
  await vi.waitFor(() => expect(controller.input?.sessionId).toBe("session-2"));
  const late = socket.heldReplies.shift()!;
  socket.reply(late.command, late.result);
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(model.getSnapshot().error).toBeNull();
  expect(
    socket.commands.filter(
      (command) =>
        command.method === "Page.startScreencast" &&
        command.sessionId === sessionId,
    ),
  ).toHaveLength(2);
  expect(controller.input?.sessionId).toBe("session-2");
});

it.each([false, true])(
  "releases exceptional display metric objects when the selected owner is retired=%s",
  async (retired) => {
    const browser = new FakeBrowser();
    const { controller, model } = mount(browser, "off", 0);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    browser.holdMethod = "Runtime.evaluate";
    controller.syncDisplay();
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const held = browser.heldCommands[0]!;
    if (retired) controller.setPaused(true);
    browser.holdMethod = null;
    held.socket.reply(held.command, {
      result: { type: "object", objectId: "display-result" },
      exceptionDetails: {
        text: "synthetic display metrics failure",
        lineNumber: 0,
        columnNumber: 0,
        exception: { type: "object", objectId: "display-exception" },
      },
    });
    await vi.waitFor(() =>
      expect(
        held.socket.commands.filter(
          (command) => command.method === "Runtime.releaseObject",
        ),
      ).toEqual([
        expect.objectContaining({
          params: { objectId: "display-result" },
          sessionId: held.command.sessionId,
        }),
        expect.objectContaining({
          params: { objectId: "display-exception" },
          sessionId: held.command.sessionId,
        }),
      ]),
    );
    expect(emulations(browser)).toHaveLength(0);
    expect(resizes(browser)).toHaveLength(0);
    if (retired) {
      expect(model.getSnapshot().status).toBe("paused");
      expect(model.getSnapshot().error).toBeNull();
    } else {
      expect(model.getSnapshot().status).toBe("streaming");
      expect(model.getSnapshot().error?.message).toBe(
        "The page display metrics are unavailable.",
      );
      controller.syncDisplay();
      await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
      await vi.waitFor(() => expect(model.getSnapshot().error).toBeNull());
    }
  },
);

it("retains a newer policy request when the preceding operation finishes rolling back", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  browser.unsupportedContentsSize = true;
  browser.holdMethod = "Emulation.clearDeviceMetricsOverride";
  controller.syncDisplay();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  expect(resizes(browser)).toHaveLength(1);
  controller.setWindowSizeSync("initial");
  controller.measureDisplay({ width: 900, height: 700, dpr: 1.5 });
  browser.unsupportedContentsSize = false;
  browser.holdMethod = null;
  const rollback = browser.heldCommands[0]!;
  browser.resume(rollback.command, rollback.socket);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  expect(resizes(browser)[1]!.params).toEqual({
    windowId: 0,
    width: 1350,
    height: 1050,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(model.getSnapshot().error).toBeNull();
});

it("keeps the latest initial measurement while the first guard is pending", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Runtime.evaluate";
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.measureDisplay({ width: 700, height: 500, dpr: 2 });
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, {
    result: { value: { width: 800, height: 600, dpr: 1 } },
  });
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  expect(resizes(browser)[0]!.params).toEqual({
    windowId: 0,
    width: 1400,
    height: 1000,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
});

it("makes live progress with the latest size without requiring a quiet measurement interval", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Runtime.evaluate";
  const { controller, model } = mount(browser, "live", 0);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  for (let index = 0; index < 100; index++)
    controller.measureDisplay({ width: 700 + index, height: 500, dpr: 2 });
  // Keep later guards held: the first completed guard must still commit the newest size.
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, {
    result: { value: { width: 800, height: 600, dpr: 1 } },
  });
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  expect(resizes(browser)[0]!.params).toEqual({
    windowId: 0,
    width: 1598,
    height: 1000,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
});

it("requires a normal native window and recovers on a deliberate retry", async () => {
  const browser = new FakeBrowser();
  browser.windowState = "maximized";
  const { controller, model } = mount(browser, "live", 0);
  await vi.waitFor(() =>
    expect(model.getSnapshot().error?.message).toContain(
      "Restore the browser window",
    ),
  );
  expect(emulations(browser)).toHaveLength(0);
  expect(resizes(browser)).toHaveLength(0);
  expect(model.getSnapshot().status).toBe("streaming");
  browser.windowState = "normal";
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
});

it("retires partial emulation when native content sizing is unsupported", async () => {
  const browser = new FakeBrowser();
  browser.unsupportedContentsSize = true;
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() =>
    expect(model.getSnapshot().error?.kind).toBe("unsupported-capability"),
  );
  expect(
    browser.sockets[0]!.commands.filter(
      (command) => command.method === "Emulation.clearDeviceMetricsOverride",
    ),
  ).toHaveLength(1);
  expect(model.getSnapshot().status).toBe("streaming");
  expect(model.getSnapshot().error?.request).toEqual({
    method: "Browser.setContentsSize",
    code: -32601,
  });
  expect(model.read(model.display$).pending).toBe(false);
  browser.unsupportedContentsSize = false;
  controller.syncDisplay();
  await vi.waitFor(() =>
    expect(browser.windowSizes.get(0)).toEqual({ width: 1280, height: 960 }),
  );
});

it("suspends new pointer gestures while an applied override awaits acknowledgement", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  const socket = browser.sockets[0]!;
  const input = controller.input!;
  socket.holdReplyMethod = "Emulation.setDeviceMetricsOverride";
  controller.syncDisplay();
  await vi.waitFor(() => expect(socket.heldReplies).toHaveLength(1));
  input.pointer("mouseMoved", { x: 0.25, y: 0.5 }, {});
  input.text("pending text");
  await input.completion(input.owner!);
  expect(
    socket.commands.filter(
      (command) => command.method === "Input.dispatchMouseEvent",
    ),
  ).toHaveLength(0);
  expect(model.read(model.display$)).toMatchObject({
    pointerBlocked: true,
    pending: true,
  });
  const held = socket.heldReplies[0]!;
  socket.holdReplyMethod = null;
  socket.reply(held.command, held.result);
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pointerBlocked: false,
      pending: false,
    }),
  );
  input.pointer("mouseMoved", { x: 0.25, y: 0.5 }, {});
  await input.completion(input.owner!);
  expect(
    socket.commands
      .filter((command) => command.method === "Input.dispatchMouseEvent")
      .at(-1)?.params,
  ).toMatchObject({ x: 320, y: 480 });
});

it.each([false, true])(
  "preserves previously adapted=%s calibration after a definite override rejection",
  async (adapted) => {
    const browser = new FakeBrowser();
    browser.browserZoom = 1.25;
    browser.windowSizes.set(0, { width: 1000, height: 750 });
    const { controller, model } = mount(browser, "off", 0);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    if (adapted) {
      controller.syncDisplay();
      await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
      await vi.waitFor(() =>
        expect(model.read(model.display$).pending).toBe(false),
      );
    }
    const socket = browser.sockets[0]!;
    browser.holdMethod = "Emulation.setDeviceMetricsOverride";
    controller.measureDisplay({ width: 900, height: 700, dpr: 2 });
    controller.syncDisplay();
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    expect(model.read(model.display$).pointerBlocked).toBe(true);
    browser.holdMethod = null;
    const held = browser.heldCommands[0]!;
    socket.reject(held.command);
    await vi.waitFor(() => expect(model.getSnapshot().error).not.toBeNull());
    expect(model.read(model.display$)).toMatchObject({
      pointerBlocked: false,
      pending: false,
    });
    const input = controller.input!;
    browser.frame(socket, input.sessionId);
    input.pointer("mouseMoved", { x: 0.25, y: 0.5 }, {});
    await input.completion(input.owner!);
    expect(
      socket.commands
        .filter((command) => command.method === "Input.dispatchMouseEvent")
        .at(-1)?.params,
    ).toMatchObject(adapted ? { x: 256, y: 384 } : { x: 200, y: 300 });
    expect(
      socket.commands.filter(
        (command) => command.method === "Emulation.clearDeviceMetricsOverride",
      ),
    ).toHaveLength(0);
  },
);

it("restores native geometry after an applied override's reply times out and ignores its late acknowledgement", async () => {
  const browser = new FakeBrowser();
  browser.browserZoom = 1.25;
  browser.windowSizes.set(0, { width: 1000, height: 750 });
  const { controller, model } = mount(browser, "off", 0, 100);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  const socket = browser.sockets[0]!;
  socket.holdReplyMethod = "Emulation.setDeviceMetricsOverride";
  controller.syncDisplay();
  await vi.waitFor(() => expect(socket.heldReplies).toHaveLength(1));
  await vi.waitFor(() =>
    expect(model.getSnapshot().error?.kind).toBe("display"),
  );
  expect(
    socket.commands.filter(
      (command) => command.method === "Emulation.clearDeviceMetricsOverride",
    ),
  ).toHaveLength(1);
  expect(model.getSnapshot().status).toBe("streaming");
  expect(model.read(model.display$).pending).toBe(false);
  expect(resizes(browser)).toHaveLength(0);
  const held = socket.heldReplies[0]!;
  socket.holdReplyMethod = null;
  socket.reply(held.command, held.result);
  controller.input!.pointer("mouseMoved", { x: 0.25, y: 0.5 }, {});
  await vi.waitFor(() =>
    expect(
      socket.commands
        .filter((command) => command.method === "Input.dispatchMouseEvent")
        .at(-1)?.params,
    ).toMatchObject({ x: 200, y: 300 }),
  );
  expect(emulations(browser)).toHaveLength(1);
  expect(resizes(browser)).toHaveLength(0);
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() => expect(model.getSnapshot().error).toBeNull());
});

it.each([false, true])(
  "suspends uncertain pointer geometry after a restoration reply times out with an owned button=%s",
  async (heldButton) => {
    const browser = new FakeBrowser();
    browser.browserZoom = 1.25;
    browser.windowSizes.set(0, { width: 1000, height: 750 });
    browser.unsupportedContentsSize = true;
    const { controller, model } = mount(browser, "off", 0, 100);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const socket = browser.sockets[0]!;
    const input = controller.input!;
    if (heldButton) {
      input.pointer(
        "mousePressed",
        { x: 0.25, y: 0.5 },
        {
          button: "left",
          buttons: 1,
          clickCount: 1,
        },
      );
      await vi.waitFor(() =>
        expect(
          socket.commands.some(
            (command) => command.method === "Input.dispatchMouseEvent",
          ),
        ).toBe(true),
      );
    }
    socket.holdReplyMethod = "Emulation.clearDeviceMetricsOverride";
    controller.syncDisplay();
    await vi.waitFor(() =>
      expect(model.getSnapshot().error?.message).toBe(
        "Display recovery could not be confirmed. Try synchronizing again.",
      ),
    );
    expect(socket.heldReplies).toHaveLength(1);
    expect(model.getSnapshot().status).toBe("streaming");
    expect(model.read(model.display$).pending).toBe(false);
    const layoutReads = () =>
      socket.commands.filter(
        (command) => command.method === "Page.getLayoutMetrics",
      ).length;
    const before = layoutReads();
    input.pointer("mouseMoved", { x: 0.25, y: 0.5 }, {});
    if (heldButton)
      input.pointer(
        "mouseReleased",
        { x: 0.9, y: 0.9 },
        {
          button: "left",
          buttons: 0,
        },
      );
    input.text("text remains usable");
    await vi.waitFor(() =>
      expect(
        socket.commands.some(
          (command) => command.method === "Input.insertText",
        ),
      ).toBe(true),
    );
    const pointers = () =>
      socket.commands.filter(
        (command) => command.method === "Input.dispatchMouseEvent",
      );
    expect(pointers()).toHaveLength(heldButton ? 2 : 0);
    expect(layoutReads()).toBe(before);
    if (heldButton)
      expect(pointers().at(-1)?.params).toEqual({
        type: "mouseReleased",
        x: 200,
        y: 300,
        button: "left",
        buttons: 0,
      });
    browser.unsupportedContentsSize = false;
    socket.holdReplyMethod = null;
    const held = socket.heldReplies[0]!;
    socket.reply(held.command, held.result);
    controller.syncDisplay();
    await vi.waitFor(() => expect(model.getSnapshot().error).toBeNull());
    input.pointer("mouseMoved", { x: 0.25, y: 0.5 }, {});
    await vi.waitFor(() =>
      expect(pointers().at(-1)?.params).toMatchObject({ x: 256, y: 384 }),
    );
    input.blur();
    expect(
      pointers().filter((command) => command.params?.type === "mouseReleased"),
    ).toHaveLength(heldButton ? 1 : 0);
  },
);

it("drops an automatic update disabled during capture preparation", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  browser.holdMethod = "Page.stopScreencast";
  controller.setWindowSizeSync("live");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.setWindowSizeSync("off");
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  browser.resume(held.command, held.socket);
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(emulations(browser)).toHaveLength(0);
  expect(resizes(browser)).toHaveLength(0);
  expect(model.getSnapshot().status).toBe("streaming");
  expect(model.getSnapshot().error).toBeNull();
});

it("retires a previous request key when restoration is unconfirmed so a policy change can recover", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "initial", 0, 100);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  controller.setWindowSizeSync("off");
  browser.unsupportedContentsSize = true;
  const socket = browser.sockets[0]!;
  socket.holdReplyMethod = "Emulation.clearDeviceMetricsOverride";
  controller.measureDisplay({ width: 700, height: 500, dpr: 2 });
  controller.syncDisplay();
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pointerBlocked: true,
      pending: false,
    }),
  );
  expect(emulations(browser)).toHaveLength(2);
  browser.unsupportedContentsSize = false;
  socket.holdReplyMethod = null;
  const held = socket.heldReplies[0]!;
  socket.reply(held.command, held.result);
  controller.measureDisplay({ width: 640, height: 480, dpr: 2 });
  controller.setWindowSizeSync("live");
  await vi.waitFor(() => expect(emulations(browser)).toHaveLength(3));
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: false,
    }),
  );
  expect(model.getSnapshot().error).toBeNull();
});

it("constrains physical edges and area while preserving requested DPR and aspect ratio", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  controller.measureDisplay({ width: 10000, height: 5000, dpr: 3 });
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  const dimensions = resizes(browser)[0]!.params!;
  const width = Number(dimensions.width),
    height = Number(dimensions.height);
  expect(width).toBeLessThanOrEqual(4096);
  expect(height).toBeLessThanOrEqual(4096);
  expect(width * height).toBeLessThanOrEqual(3840 * 2160);
  expect(Math.abs(width / height - 2)).toBeLessThan(0.01);
  expect(emulations(browser)[0]!.params?.deviceScaleFactor).toBe(3);
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(model.getSnapshot().error).toBeNull();
});

it("lets a sibling window synchronize while another owner's write is held", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Browser.setContentsSize";
  const a = mount(browser, "live", 0);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  browser.holdMethod = null;
  const b = mount(browser, "live", 2);
  await vi.waitFor(() =>
    expect(browser.windowSizes.get(2)).toEqual({ width: 1280, height: 960 }),
  );
  expect(b.model.getSnapshot().status).toBe("streaming");
  a.controller.close();
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command);
  expect(b.model.getSnapshot().status).toBe("streaming");
  expect(browser.sockets[1]!.readyState).toBe(1);
});

it("refuses density that exceeds the physical budget even at minimum logical dimensions", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  controller.measureDisplay({ width: 640, height: 480, dpr: 10000 });
  controller.syncDisplay();
  await vi.waitFor(() =>
    expect(model.getSnapshot().error?.message).toContain("density cannot fit"),
  );
  expect(resizes(browser)).toHaveLength(0);
  expect(emulations(browser)).toHaveLength(0);
  expect(model.getSnapshot().status).toBe("streaming");
});
