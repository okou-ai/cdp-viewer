import { afterEach, expect, it, vi } from "vitest";
import {
  captureSettings,
  capturePreferences,
  defaultCapture,
} from "../../src/viewer/capture";
import type { FrameSink } from "../../src/render/canvas";
import type { Viewport } from "../../src/display/geometry";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import type { ViewerCaptureOptions } from "../../src/viewer/types";
import { FakeBrowser, fakeRaster } from "./wire";

const controllers: ViewerController[] = [];
afterEach(() =>
  controllers.splice(0).forEach((controller) => controller.close()),
);

it("retains independent defaults and accepts zero quality and dimension boundaries", () => {
  expect(captureSettings()).toEqual(defaultCapture);
  expect(captureSettings({})).toEqual(defaultCapture);
  expect(captureSettings({ quality: 0 })).toEqual({
    ...defaultCapture,
    quality: 0,
  });
  expect(captureSettings({ maxWidth: 1280 })).toEqual({
    ...defaultCapture,
    maxWidth: 1280,
  });
  expect(
    captureSettings({ quality: 100, maxWidth: 1, maxHeight: 4096 }),
  ).toEqual({ quality: 100, maxWidth: 1, maxHeight: 4096 });
});

it.each([
  { quality: -1 },
  { quality: 101 },
  { quality: 0.5 },
  { quality: NaN },
  { maxWidth: 0 },
  { maxWidth: 4097 },
  { maxWidth: Infinity },
  { maxHeight: -1 },
  { maxHeight: 4097 },
  { maxHeight: 1.5 },
])("rejects out-of-range capture values: %j", (value) => {
  expect(() => captureSettings(value)).toThrowError(/capture\./);
});

it.each([
  null,
  [],
  false,
  { quality: null },
  { quality: "50" },
  { maxWidth: "1280" },
])("rejects malformed JavaScript settings: %j", (value) => {
  expect(() => captureSettings(value as ViewerCaptureOptions)).toThrowError(
    /capture/,
  );
});

function mount(
  browser = new FakeBrowser(),
  capture?: ViewerCaptureOptions,
  windowId = 0,
) {
  const model = createViewerModel();
  const resetInput = vi.fn();
  const rasters: Viewport[] = [];
  const sink = {
    push: vi.fn<FrameSink["push"]>((data, painted, _failed, accept) => {
      const raster = fakeRaster(data);
      if (!accept || accept(raster)) {
        rasters.push(raster);
        painted(raster);
      }
    }),
    invalidate: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
  const controller = new ViewerController(model, sink, {
    url: "wss://fixture.invalid/",
    socketFactory: browser.factory,
    windowId,
    interactive: true,
    onInputReset: resetInput,
    ...(capture === undefined ? {} : { capture }),
  });
  controllers.push(controller);
  controller.start();
  return { browser, model, sink, controller, resetInput, rasters };
}

it("preserves ordinary and adapted defaults unless individual bounds are supplied", () => {
  expect(captureSettings(capturePreferences(), true)).toEqual({
    quality: 70,
    maxWidth: 4096,
    maxHeight: 4096,
  });
  expect(captureSettings(capturePreferences({ quality: 50 }), true)).toEqual({
    quality: 50,
    maxWidth: 4096,
    maxHeight: 4096,
  });
  expect(captureSettings(capturePreferences({ maxWidth: 1280 }), true)).toEqual(
    { quality: 70, maxWidth: 1280, maxHeight: 4096 },
  );
  expect(captureSettings(capturePreferences({}), false)).toEqual(
    defaultCapture,
  );
});

it("accepts bounded adapted frames and retains input mapping without repeating native sizing", async () => {
  const { browser, controller, model, rasters } = mount(undefined, {
    maxWidth: 320,
    maxHeight: 240,
  });
  controller.measureDisplay({ width: 640, height: 480, dpr: 2 });
  controller.setWindowSizeSync("live");
  await vi.waitFor(() =>
    expect(browser.windowSizes.get(0)).toEqual({ width: 1280, height: 960 }),
  );
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(rasters.at(-1)).toEqual({ width: 320, height: 240 });
  const input = controller.input!;
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, { buttons: 0 });
  const socket = browser.sockets[0]!;
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent"),
    ).toHaveLength(1),
  );
  const position = socket.commands.find(
    (c) => c.method === "Input.dispatchMouseEvent",
  )!.params;
  const count = socket.commands.length;
  controller.setCapture({ quality: 50, maxWidth: 640, maxHeight: 360 });
  await vi.waitFor(() =>
    expect(rasters.at(-1)).toEqual({ width: 480, height: 360 }),
  );
  expect(controller.input).toBe(input);
  expect(model.read(model.display$).pointerBlocked).toBe(false);
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, { buttons: 0 });
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent"),
    ).toHaveLength(2),
  );
  expect(
    socket.commands
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .at(-1)!.params,
  ).toEqual(position);
  expect(
    socket.commands
      .slice(count)
      .filter(
        (c) =>
          c.method === "Browser.setContentsSize" ||
          c.method.startsWith("Emulation."),
      ),
  ).toHaveLength(0);
});

it("rejects invalid initial settings before opening and starts when they are corrected", async () => {
  const { browser, controller, model } = mount(undefined, { quality: -1 });
  expect(browser.sockets).toHaveLength(0);
  expect(model.getSnapshot()).toMatchObject({
    status: "error",
    error: { kind: "configuration" },
  });
  controller.setCapture({ quality: 0 });
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  expect(browser.sockets).toHaveLength(1);
  expect(
    browser.sockets[0]!.commands.find(
      (c) => c.method === "Page.startScreencast",
    )?.params,
  ).toEqual({ format: "jpeg", ...defaultCapture, quality: 0 });
});

it("reconfigures only capture while preserving selected input and rejecting invalid updates", async () => {
  const { browser, controller, model, sink, resetInput } = mount();
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const input = controller.input;
  const socket = browser.sockets[0]!;
  const selected = model.getSnapshot().selectedTargetId;
  const before = socket.commands.length;
  sink.reset.mockClear();
  resetInput.mockClear();
  controller.setCapture({ maxWidth: 1280, maxHeight: 720 });
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Page.startScreencast"),
    ).toHaveLength(2),
  );
  expect(controller.input).toBe(input);
  expect(model.getSnapshot().selectedTargetId).toBe(selected);
  expect(resetInput).not.toHaveBeenCalled();
  expect(sink.reset).not.toHaveBeenCalled();
  expect(sink.invalidate).toHaveBeenCalledOnce();
  expect(socket.commands.slice(before).map((c) => c.method)).toEqual([
    "Page.stopScreencast",
    "Page.startScreencast",
    "Page.screencastFrameAck",
  ]);
  expect(browser.sockets).toHaveLength(1);
  const count = socket.commands.length;
  controller.setCapture({ quality: 70, maxWidth: 1280, maxHeight: 720 });
  expect(socket.commands).toHaveLength(count);
  controller.setCapture({ maxWidth: 0 });
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    error: { kind: "configuration" },
  });
  const error = model.getSnapshot().error;
  controller.setCapture({ maxWidth: 0 });
  expect(model.getSnapshot().error).toBe(error);
  expect(controller.input).toBe(input);
  expect(socket.commands).toHaveLength(count);
  controller.setCapture({ maxWidth: 1280, maxHeight: 720 });
  expect(model.getSnapshot().error).toBeNull();
  expect(socket.commands).toHaveLength(count);
});

it("coalesces pending capture settings and continues acknowledging discarded frames", async () => {
  const { browser, controller, sink } = mount();
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const socket = browser.sockets[0]!;
  const initial = socket.commands.find(
    (c) => c.method === "Page.startScreencast",
  )!;
  const paints = sink.push.mock.calls.length;
  browser.holdMethod = "Page.stopScreencast";
  controller.setCapture({ quality: 50 });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  for (let width = 1000; width < 1050; width++)
    controller.setCapture({ maxWidth: width });
  browser.frame(socket, initial.sessionId!, 912);
  expect(sink.push).toHaveBeenCalledTimes(paints);
  expect(socket.commands.at(-1)).toMatchObject({
    method: "Page.screencastFrameAck",
    params: { sessionId: 912 },
    sessionId: initial.sessionId,
  });
  const stop = browser.heldCommands[0]!;
  browser.holdMethod = null;
  stop.socket.reply(stop.command);
  await vi.waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Page.startScreencast"),
    ).toHaveLength(2),
  );
  expect(
    socket.commands.filter((c) => c.method === "Page.startScreencast").at(-1),
  ).toMatchObject({
    sessionId: initial.sessionId,
    params: { ...defaultCapture, maxWidth: 1049 },
  });
});

it("uses the latest capture during attachment and applies paused changes on resume", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Page.enable";
  const { controller } = mount(browser);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.setCapture({ quality: 80 });
  browser.holdMethod = null;
  const enable = browser.heldCommands[0]!;
  enable.socket.reply(enable.command);
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const socket = browser.sockets[0]!;
  expect(
    socket.commands.find((c) => c.method === "Page.startScreencast")?.params
      ?.quality,
  ).toBe(80);
  controller.setPaused(true);
  const starts = socket.commands.filter(
    (c) => c.method === "Page.startScreencast",
  ).length;
  controller.setCapture({ maxWidth: 960, maxHeight: 540 });
  expect(
    socket.commands.filter((c) => c.method === "Page.startScreencast"),
  ).toHaveLength(starts);
  controller.setPaused(false);
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  expect(
    socket.commands.filter((c) => c.method === "Page.startScreencast").at(-1)
      ?.params,
  ).toEqual({ format: "jpeg", quality: 70, maxWidth: 960, maxHeight: 540 });
});

it("does not restart a replaced session after a held stop reply", async () => {
  const { browser, controller, model } = mount(undefined, undefined, undefined);
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const socket = browser.sockets[0]!;
  const oldSession = socket.commands.find(
    (c) => c.method === "Page.startScreencast",
  )!.sessionId;
  browser.holdMethod = "Page.stopScreencast";
  controller.setCapture({ quality: 45 });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  // The scoped fixture adds a second target in the same real window.
  browser.targets.push({ id: "page-next", windowId: 0, title: "Next" });
  socket.emit("Target.targetCreated", {});
  await vi.waitFor(() =>
    expect(model.getSnapshot().targets.some((t) => t.id === "page-next")).toBe(
      true,
    ),
  );
  controller.select("page-next");
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command);
  await vi.waitFor(() =>
    expect(
      socket.commands.some(
        (c) =>
          c.method === "Target.detachFromTarget" &&
          c.params?.sessionId === oldSession,
      ),
    ).toBe(true),
  );
  expect(
    socket.commands.filter(
      (c) => c.method === "Page.startScreencast" && c.sessionId === oldSession,
    ),
  ).toHaveLength(1);
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    selectedTargetId: "page-next",
  });
});

it("isolates capture updates and teardown between different-window viewers", async () => {
  const browser = new FakeBrowser();
  const a = mount(browser, undefined, 0);
  const b = mount(browser, undefined, 2);
  await vi.waitFor(() => {
    expect(a.controller.input).not.toBeNull();
    expect(b.controller.input).not.toBeNull();
  });
  const bInput = b.controller.input;
  const bSocket = browser.sockets[1]!;
  const commands = bSocket.commands.length;
  a.controller.setCapture({ quality: 50 });
  await vi.waitFor(() =>
    expect(
      browser.sockets[0]!.commands.filter(
        (c) => c.method === "Page.startScreencast",
      ),
    ).toHaveLength(2),
  );
  a.controller.close();
  expect(b.controller.input).toBe(bInput);
  expect(bSocket.commands).toHaveLength(commands);
  expect(bSocket.readyState).toBe(1);
});

it("retains an invalid live configuration diagnostic when the initial frame becomes ready", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Page.startScreencast";
  const { controller, model } = mount(browser);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.setCapture({ quality: -1 });
  const held = browser.heldCommands[0]!;
  browser.holdMethod = null;
  held.socket.reply(held.command);
  browser.frame(held.socket, held.command.sessionId!);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  expect(model.getSnapshot().error?.kind).toBe("configuration");
  controller.setCapture();
  expect(model.getSnapshot().error).toBeNull();
});
