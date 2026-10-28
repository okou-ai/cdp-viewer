import { afterEach, expect, it, vi } from "vitest";
import {
  captureSettings,
  capturePreferences,
  defaultCapture,
} from "../../src/viewer/capture";
import type { FrameSink } from "../../src/render/canvas";
import type { DisplaySize, Viewport } from "../../src/display/geometry";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import type { ViewerCaptureOptions } from "../../src/viewer/types";
import { FakeBrowser, fakeRaster } from "./wire";

const controllers: ViewerController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.close());
  vi.useRealTimers();
});

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
  ).toEqual({ format: "webp", quality: 100, maxWidth: 1, maxHeight: 4096 });
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
  { format: "png" },
  { format: "avif" },
  { format: "WEBP" },
  { format: "" },
  { format: null },
  { format: 70 },
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
  size?: DisplaySize,
  transport: "shared" | "split" = "shared",
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
    transport,
    onInputReset: resetInput,
    ...(capture === undefined ? {} : { capture }),
  });
  controllers.push(controller);
  if (size) controller.measureDisplay(size);
  controller.start();
  return { browser, model, sink, controller, resetInput, rasters };
}

it.each(["webp", "jpeg"] as const)(
  "normalizes explicit %s without losing quality or automatic axes",
  (format) => {
    expect(captureSettings({ format })).toEqual({ ...defaultCapture, format });
    expect(capturePreferences({ format, quality: 0, maxHeight: 720 })).toEqual({
      format,
      quality: 0,
      maxHeight: 720,
    });
  },
);

it.each(["shared", "split"] as const)(
  "switches codecs without replacing %s input, sessions or connections",
  async (transport) => {
    const preferences = { quality: 45, maxWidth: 1234 };
    const { browser, controller, model, sink, resetInput } = mount(
      undefined,
      { ...preferences, format: "jpeg" },
      0,
      undefined,
      transport,
    );
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const starts = () =>
      browser.sockets.flatMap((socket) =>
        socket.commands.filter((c) => c.method === "Page.startScreencast"),
      );
    const input = controller.input!;
    const selected = model.getSnapshot().selectedTargetId;
    const sockets = [...browser.sockets];
    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.params).toMatchObject({
      ...preferences,
      format: "jpeg",
    });
    sink.reset.mockClear();
    resetInput.mockClear();
    controller.setCapture({ ...preferences, format: "webp" });
    await vi.waitFor(() => expect(starts()).toHaveLength(2));
    expect(starts()[1]).toMatchObject({
      sessionId: starts()[0]!.sessionId,
      params: { ...preferences, format: "webp" },
    });
    expect(controller.input).toBe(input);
    expect(model.getSnapshot().selectedTargetId).toBe(selected);
    expect(browser.sockets).toEqual(sockets);
    expect(sink.reset).not.toHaveBeenCalled();
    expect(resetInput).not.toHaveBeenCalled();
    input.text("after codec switch");
    await input.completion(input.owner!);
    expect(browser.sockets[0]!.commands).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "after codec switch" },
      }),
    );
    controller.setCapture({
      ...preferences,
      format: "png",
    } as unknown as ViewerCaptureOptions);
    expect(model.getSnapshot().error?.kind).toBe("configuration");
    expect(starts()).toHaveLength(2);
    expect(controller.input).toBe(input);
    controller.setCapture(preferences);
    expect(model.getSnapshot().error).toBeNull();
    expect(starts()).toHaveLength(2);
    controller.setCapture({ ...preferences, format: "jpeg" });
    await vi.waitFor(() => expect(starts()).toHaveLength(3));
    expect(starts()[2]!.params).toMatchObject({
      ...preferences,
      format: "jpeg",
    });
    expect(controller.input).toBe(input);
  },
);

it("sizes omitted axes from the physical surface and honors independent fixed bounds", () => {
  const size = { width: 640, height: 480, dpr: 2 };
  expect(captureSettings(capturePreferences(), size)).toEqual({
    format: "webp",
    quality: 70,
    maxWidth: 1280,
    maxHeight: 960,
  });
  expect(captureSettings(capturePreferences({ quality: 50 }), size)).toEqual({
    format: "webp",
    quality: 50,
    maxWidth: 1280,
    maxHeight: 960,
  });
  expect(captureSettings(capturePreferences({ maxWidth: 320 }), size)).toEqual({
    format: "webp",
    quality: 70,
    maxWidth: 320,
    maxHeight: 960,
  });
  expect(captureSettings({ maxHeight: 240 }, size)).toEqual({
    format: "webp",
    quality: 70,
    maxWidth: 1280,
    maxHeight: 240,
  });
});

it.each([
  { maxWidth: 3840, maxHeight: 2160 },
  { maxWidth: 2160, maxHeight: 3840 },
  { maxWidth: 4096, maxHeight: 2025 },
  { maxWidth: 2025, maxHeight: 4096 },
])("accepts fixed bounds at the common pixel ceiling: %j", (capture) => {
  expect(captureSettings(capture)).toEqual({
    format: "webp",
    quality: 70,
    ...capture,
  });
});

it.each([
  { maxWidth: 4096, maxHeight: 4096 },
  { maxWidth: 4096, maxHeight: 2026 },
  { maxWidth: 2026, maxHeight: 4096 },
  { maxWidth: 3840, maxHeight: 2161 },
])("rejects fixed bounds above the common pixel ceiling: %j", (capture) => {
  expect(() => captureSettings(capture)).toThrowError(
    /must not exceed 8294400 pixels/,
  );
});

it.each([
  [
    "width",
    "shared",
    { maxWidth: 4096 },
    { width: 640, height: 2100 },
    { width: 640, height: 3000 },
    { width: 640, height: 1000 },
    { maxWidth: 4096, maxHeight: 2025 },
    { maxWidth: 4096, maxHeight: 1000 },
  ],
  [
    "height",
    "split",
    { maxHeight: 4096 },
    { width: 2100, height: 640 },
    { width: 3000, height: 640 },
    { width: 1000, height: 640 },
    { maxWidth: 2025, maxHeight: 4096 },
    { maxWidth: 1000, maxHeight: 4096 },
  ],
] as const)(
  "keeps fixed %s and fits its automatic counterpart across %s measurements",
  async (
    _axis,
    transport,
    capture,
    initial,
    larger,
    smaller,
    capped,
    final,
  ) => {
    vi.useFakeTimers();
    const { browser, controller, model } = mount(
      undefined,
      capture,
      0,
      { ...initial, dpr: 1 },
      transport,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(model.getSnapshot().status).toBe("streaming");
    const input = controller.input;
    const starts = () =>
      browser.sockets.flatMap((socket) =>
        socket.commands.filter((c) => c.method === "Page.startScreencast"),
      );
    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.params).toMatchObject(capped);
    controller.measureDisplay({ ...larger, dpr: 1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(starts()).toHaveLength(1);
    controller.measureDisplay({ ...smaller, dpr: 1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(starts()).toHaveLength(2);
    expect(starts()[1]!.params).toMatchObject(final);
    expect(starts()[1]!.sessionId).toBe(starts()[0]!.sessionId);
    expect(controller.input).toBe(input);
    expect(model.getSnapshot().error).toBeNull();
  },
);

it.each([
  [{ width: 960, height: 540, dpr: 1 }, 960, 540],
  [{ width: 960, height: 540, dpr: 2 }, 1920, 1080],
  [{ width: 640, height: 480, dpr: 1.25 }, 800, 600],
  [{ width: 640, height: 480, dpr: 0.8 }, 512, 384],
  [{ width: 1920, height: 1080, dpr: 4 }, 3840, 2160],
  [{ width: 4000, height: 200, dpr: 2 }, 4096, 204],
] as const)("bounds physical pixel demand for %j", (size, width, height) => {
  expect(captureSettings(undefined, size)).toEqual({
    format: "webp",
    quality: 70,
    maxWidth: width,
    maxHeight: height,
  });
});

it.each(["shared", "split"] as const)(
  "uses automatic defaults and density-only changes without replacing %s owners",
  async (transport) => {
    const { browser, controller, resetInput } = mount(
      undefined,
      undefined,
      0,
      { width: 640, height: 480, dpr: 1.25 },
      transport,
    );
    await vi.waitFor(() => expect(controller.input).not.toBeNull());
    const input = controller.input;
    const sockets = browser.sockets.length;
    const starts = () =>
      browser.sockets.flatMap((s) =>
        s.commands.filter((c) => c.method === "Page.startScreencast"),
      );
    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.params).toMatchObject({
      quality: 70,
      maxWidth: 800,
      maxHeight: 600,
    });
    resetInput.mockClear();
    controller.measureDisplay({ width: 640, height: 480, dpr: 2 });
    await vi.waitFor(() => expect(starts()).toHaveLength(2));
    expect(starts()[1]).toMatchObject({
      sessionId: starts()[0]!.sessionId,
      params: { maxWidth: 1280, maxHeight: 960 },
    });
    expect(controller.input).toBe(input);
    expect(resetInput).not.toHaveBeenCalled();
    expect(browser.sockets).toHaveLength(sockets);
    expect(
      browser.sockets.flatMap((s) =>
        s.commands.filter(
          (c) =>
            c.method.startsWith("Emulation.") ||
            c.method === "Browser.setContentsSize" ||
            c.method === "Target.detachFromTarget",
        ),
      ),
    ).toHaveLength(0);
  },
);

it("settles a resize burst once and ignores equivalent rerenders", async () => {
  vi.useFakeTimers();
  const { browser, controller, model } = mount(undefined, undefined, 0, {
    width: 640,
    height: 480,
    dpr: 1,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(model.getSnapshot().status).toBe("streaming");
  const socket = browser.sockets[0]!;
  const starts = () =>
    socket.commands.filter((c) => c.method === "Page.startScreencast");
  for (let index = 0; index < 50; index++) {
    controller.measureDisplay({ width: 700 + index, height: 480, dpr: 1 });
    // Committed status changes repeat props while the surface timer is pending.
    controller.setCapture({});
    await vi.advanceTimersByTimeAsync(10);
  }
  expect(starts()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(189);
  expect(starts()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(starts()).toHaveLength(2);
  expect(starts().at(-1)!.params).toMatchObject({
    maxWidth: 749,
    maxHeight: 480,
  });
  const count = starts().length;
  for (let index = 0; index < 20; index++)
    controller.measureDisplay({ width: 749, height: 480, dpr: 1 });
  await vi.advanceTimersByTimeAsync(300);
  expect(starts()).toHaveLength(count);
});

it.each(["shared", "split"] as const)(
  "bounds continuous resize demand without a quiet interval on %s transport",
  async (transport) => {
    vi.useFakeTimers();
    const { browser, controller, model } = mount(
      undefined,
      undefined,
      0,
      { width: 640, height: 480, dpr: 1 },
      transport,
    );
    await vi.advanceTimersByTimeAsync(0);
    const input = controller.input;
    const starts = () =>
      browser.sockets.flatMap((socket) =>
        socket.commands.filter(
          (command) => command.method === "Page.startScreencast",
        ),
      );
    for (let index = 0; index < 125; index++) {
      controller.measureDisplay({ width: 700 + index, height: 480, dpr: 1 });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(starts()).toHaveLength(2);
    expect(starts()[1]!.params).toMatchObject({
      maxWidth: 799,
      maxHeight: 480,
    });
    await vi.advanceTimersByTimeAsync(189);
    expect(starts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts()).toHaveLength(3);
    expect(starts()[2]!.params).toMatchObject({
      maxWidth: 824,
      maxHeight: 480,
    });
    expect(controller.input).toBe(input);
    expect(model.getSnapshot().status).toBe("streaming");
    expect(model.getSnapshot().error).toBeNull();
  },
);

it("cancels return-to-current demand without letting equivalent bounds postpone settlement", async () => {
  vi.useFakeTimers();
  const { browser, controller } = mount(undefined, undefined, 0, {
    width: 640,
    height: 480,
    dpr: 1,
  });
  await vi.advanceTimersByTimeAsync(0);
  const starts = () =>
    browser.sockets[0]!.commands.filter(
      (command) => command.method === "Page.startScreencast",
    );
  controller.measureDisplay({ width: 800, height: 480, dpr: 1 });
  await vi.advanceTimersByTimeAsync(100);
  controller.measureDisplay({ width: 640, height: 480, dpr: 1 });
  await vi.advanceTimersByTimeAsync(300);
  expect(starts()).toHaveLength(1);
  controller.measureDisplay({ width: 800, height: 480, dpr: 1 });
  for (let index = 1; index <= 9; index++) {
    await vi.advanceTimersByTimeAsync(20);
    controller.measureDisplay({ width: 800 + index / 10, height: 480, dpr: 1 });
  }
  expect(starts()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20);
  expect(starts()).toHaveLength(2);
  expect(starts()[1]!.params).toMatchObject({ maxWidth: 800, maxHeight: 480 });
});

it("applies explicit preferences immediately and retires pending automatic work", async () => {
  vi.useFakeTimers();
  const { browser, controller } = mount(undefined, undefined, 0, {
    width: 640,
    height: 480,
    dpr: 1,
  });
  await vi.advanceTimersByTimeAsync(0);
  const input = controller.input;
  const starts = () =>
    browser.sockets[0]!.commands.filter(
      (command) => command.method === "Page.startScreencast",
    );
  controller.measureDisplay({ width: 800, height: 600, dpr: 1 });
  await vi.advanceTimersByTimeAsync(100);
  controller.setCapture({ quality: 50 });
  await vi.advanceTimersByTimeAsync(0);
  expect(starts()).toHaveLength(2);
  expect(starts()[1]!.params).toMatchObject({
    quality: 50,
    maxWidth: 800,
    maxHeight: 600,
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(starts()).toHaveLength(2);
  expect(controller.input).toBe(input);
});

it("retains valid bounds across unavailable surfaces and cancels retired measurement work", async () => {
  vi.useFakeTimers();
  const { browser, controller, model } = mount(undefined, undefined, 0, {
    width: 640,
    height: 480,
    dpr: 1,
  });
  await vi.advanceTimersByTimeAsync(0);
  const socket = browser.sockets[0]!;
  const starts = () =>
    socket.commands.filter((c) => c.method === "Page.startScreencast");
  for (const size of [
    null,
    { width: 0, height: 480, dpr: 1 },
    { width: 800, height: 600, dpr: NaN },
    { width: Infinity, height: 600, dpr: 2 },
  ])
    controller.measureDisplay(size);
  await vi.advanceTimersByTimeAsync(300);
  expect(starts()).toHaveLength(1);
  controller.measureDisplay({ width: 800, height: 600, dpr: 2 });
  controller.measureDisplay(null);
  controller.syncDisplay();
  await vi.advanceTimersByTimeAsync(300);
  expect(starts()).toHaveLength(1);
  controller.setPaused(true);
  controller.measureDisplay({ width: 900, height: 700, dpr: 2 });
  await vi.advanceTimersByTimeAsync(300);
  expect(starts()).toHaveLength(1);
  controller.setPaused(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(model.getSnapshot().status).toBe("streaming");
  expect(starts()).toHaveLength(2);
  expect(starts()[1]!.params).toMatchObject({
    maxWidth: 1800,
    maxHeight: 1400,
  });
  controller.measureDisplay({ width: 1100, height: 700, dpr: 2 });
  controller.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(starts()).toHaveLength(2);
});

it("spaces actual capture starts after a delayed stop while retaining the latest measurement", async () => {
  vi.useFakeTimers();
  const { browser, controller } = mount(undefined, undefined, 0, {
    width: 640,
    height: 480,
    dpr: 1,
  });
  await vi.advanceTimersByTimeAsync(0);
  const socket = browser.sockets[0]!;
  const starts = () =>
    socket.commands.filter((c) => c.method === "Page.startScreencast");
  browser.holdMethod = "Page.stopScreencast";
  controller.measureDisplay({ width: 800, height: 600, dpr: 1 });
  await vi.advanceTimersByTimeAsync(200);
  expect(browser.heldCommands).toHaveLength(1);
  controller.measureDisplay({ width: 900, height: 600, dpr: 1 });
  await vi.advanceTimersByTimeAsync(150);
  controller.measureDisplay({ width: 910, height: 600, dpr: 1 });
  await vi.advanceTimersByTimeAsync(70);
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  browser.resume(held.command, held.socket);
  await vi.advanceTimersByTimeAsync(0);
  expect(starts()).toHaveLength(2);
  expect(starts()[1]!.params).toMatchObject({ maxWidth: 800, maxHeight: 600 });
  await vi.advanceTimersByTimeAsync(149);
  expect(starts()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(starts()).toHaveLength(3);
  expect(starts()[2]!.params).toMatchObject({ maxWidth: 910, maxHeight: 600 });
});

it("reschedules reverted bounds when an earlier native restart was already dispatched", async () => {
  vi.useFakeTimers();
  const { browser, controller, model } = mount(undefined, undefined, 0, {
    width: 640,
    height: 480,
    dpr: 1,
  });
  await vi.advanceTimersByTimeAsync(0);
  const input = controller.input;
  const socket = browser.sockets[0]!;
  const starts = () =>
    socket.commands.filter(
      (command) => command.method === "Page.startScreencast",
    );
  browser.holdMethod = "Page.stopScreencast";
  controller.measureDisplay({ width: 800, height: 600, dpr: 1 });
  await vi.advanceTimersByTimeAsync(200);
  expect(browser.heldCommands).toHaveLength(1);
  controller.measureDisplay({ width: 640, height: 480, dpr: 1 });
  await vi.advanceTimersByTimeAsync(200);
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  browser.resume(held.command, held.socket);
  await vi.advanceTimersByTimeAsync(0);
  expect(starts()).toHaveLength(2);
  expect(starts()[1]!.params).toMatchObject({ maxWidth: 800, maxHeight: 600 });
  await vi.advanceTimersByTimeAsync(199);
  expect(starts()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(starts()).toHaveLength(3);
  expect(starts()[2]!.params).toMatchObject({ maxWidth: 640, maxHeight: 480 });
  expect(controller.input).toBe(input);
  expect(model.getSnapshot().status).toBe("streaming");
  expect(model.getSnapshot().error).toBeNull();
});

it("restores automatic axes after removing fixed bounds using the latest surface", async () => {
  const { browser, controller } = mount(undefined, { maxWidth: 320 }, 0, {
    width: 640,
    height: 480,
    dpr: 1,
  });
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const starts = () =>
    browser.sockets[0]!.commands.filter(
      (c) => c.method === "Page.startScreencast",
    );
  expect(starts()[0]!.params).toMatchObject({
    maxWidth: 320,
    maxHeight: 480,
  });
  controller.measureDisplay({ width: 800, height: 600, dpr: 1.25 });
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
  expect(starts()[1]!.params).toMatchObject({
    maxWidth: 320,
    maxHeight: 750,
  });
  controller.setCapture();
  await vi.waitFor(() => expect(starts()).toHaveLength(3));
  expect(starts()[2]!.params).toMatchObject({
    maxWidth: 1000,
    maxHeight: 750,
  });
});

it("defers automatic image changes through a native write and applies the latest surface afterward", async () => {
  const { browser, controller, model } = mount(undefined, undefined, 0, {
    width: 640,
    height: 480,
    dpr: 1,
  });
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const socket = browser.sockets[0]!;
  const starts = () =>
    socket.commands.filter((c) => c.method === "Page.startScreencast");
  const input = controller.input;
  browser.holdMethod = "Browser.setContentsSize";
  controller.setWindowSizeSync("live");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  for (let width = 700; width < 750; width++)
    controller.measureDisplay({ width, height: 500, dpr: 1 });
  // The initial stream and native acquisition preceded the held display write.
  expect(starts()).toHaveLength(2);
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  browser.resume(held.command, held.socket);
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  await vi.waitFor(() => expect(starts()).toHaveLength(3));
  expect(starts()[2]!.params).toMatchObject({
    maxWidth: 749,
    maxHeight: 500,
  });
  expect(
    socket.commands.filter((c) => c.method === "Browser.setContentsSize"),
  ).toHaveLength(2);
  expect(controller.input).toBe(input);
  expect(model.getSnapshot().error).toBeNull();
});

it.each(["shared", "split"] as const)(
  "applies pending automatic bounds before waiting for static resized pixels on %s transport",
  async (transport) => {
    const { browser, controller, model, rasters } = mount(
      undefined,
      undefined,
      0,
      { width: 1024, height: 270, dpr: 2 },
      transport,
    );
    await vi.waitFor(() => expect(controller.input).not.toBeNull());
    controller.setWindowSizeSync("live");
    await vi.waitFor(() =>
      expect(model.read(model.display$)).toMatchObject({
        pending: false,
        pointerBlocked: false,
      }),
    );
    const input = controller.input!;
    const sockets = [...browser.sockets];
    const starts = () =>
      browser.sockets.flatMap((socket) =>
        socket.commands.filter(
          (command) => command.method === "Page.startScreencast",
        ),
      );
    const before = starts().length;
    expect(starts().at(-1)?.params).toMatchObject({
      maxWidth: 2048,
      maxHeight: 540,
    });
    // The native write is acknowledged without a new static frame. Capture
    // preferences must not wait for the very presentation they need to produce.
    browser.holdFrames = true;
    browser.holdMethod = "Page.startScreencast";
    controller.measureDisplay({ width: 818, height: 353, dpr: 2 });
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const held = browser.heldCommands.shift()!;
    expect(held.command).toMatchObject({
      method: "Page.startScreencast",
      params: { maxWidth: 1636, maxHeight: 706 },
    });
    expect(model.read(model.display$)).toMatchObject({
      pending: true,
      pointerBlocked: true,
    });
    browser.holdFrames = false;
    browser.holdMethod = null;
    browser.resume(held.command, held.socket);
    await vi.waitFor(() =>
      expect(model.read(model.display$)).toMatchObject({
        pending: false,
        pointerBlocked: false,
      }),
    );
    expect(rasters.at(-1)).toEqual({ width: 1636, height: 706 });
    expect(starts()).toHaveLength(before + 1);
    expect(controller.input).toBe(input);
    expect(browser.sockets).toEqual(sockets);
    expect(model.getSnapshot().error).toBeNull();
  },
);

it("requires fresh pixels when automatic bounds hide a native resize behind an identical raster", async () => {
  const { browser, controller, model, sink } = mount(undefined, undefined, 0, {
    width: 640,
    height: 480,
    dpr: 1,
  });
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const input = controller.input!,
    socket = browser.sockets[0]!;
  let paints = sink.push.mock.calls.length;
  const reply = socket.reply.bind(socket);
  const nativeWrite = vi
    .spyOn(socket, "reply")
    .mockImplementation((command, result) => {
      if (command.method === "Emulation.setDeviceMetricsOverride") {
        nativeWrite.mockRestore();
        // Acquire native geometry normally, then hold only presentation work.
        paints = sink.push.mock.calls.length;
        browser.holdFrames = true;
        browser.holdMethod = "Page.startScreencast";
      }
      reply(command, result);
    });
  controller.setWindowSizeSync("live");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  // Both the old800x600 page and the new640x480 page fit this640x480 raster.
  // New target-size metadata cannot make the old screenshot's pixels current.
  socket.emit(
    "Page.screencastFrame",
    {
      sessionId: 911,
      data: btoa(JSON.stringify({ width: 640, height: 480 })),
      metadata: {
        deviceWidth: 640,
        deviceHeight: 480,
        pageScaleFactor: 1,
        timestamp: 1_799_999_999,
      },
    },
    input.sessionId,
  );
  expect(sink.push).toHaveBeenCalledTimes(paints);
  expect(model.read(model.display$)).toMatchObject({
    pending: true,
    pointerBlocked: true,
  });
  expect(socket.commands.at(-1)).toMatchObject({
    method: "Page.screencastFrameAck",
    params: { sessionId: 911 },
    sessionId: input.sessionId,
  });
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {});
  input.text("still owned");
  await input.completion(input.owner!);
  expect(
    socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent"),
  ).toHaveLength(0);
  expect(socket.commands.some((c) => c.method === "Input.insertText")).toBe(
    true,
  );
  browser.holdFrames = false;
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  browser.resume(held.command, held.socket);
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      pending: false,
      pointerBlocked: false,
    }),
  );
  expect(controller.input).toBe(input);
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {});
  await input.completion(input.owner!);
  expect(
    socket.commands
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .at(-1)?.params,
  ).toMatchObject({ x: 320, y: 240 });
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

it.each([{ quality: -1 }, { maxWidth: 4096, maxHeight: 4096 }])(
  "rejects invalid initial settings before opening and starts after correction: %j",
  async (capture) => {
    const { browser, controller, model } = mount(undefined, capture);
    expect(browser.sockets).toHaveLength(0);
    expect(model.getSnapshot()).toMatchObject({
      status: "error",
      error: { kind: "configuration" },
    });
    controller.setCapture({ quality: 0 });
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    expect(browser.sockets).toHaveLength(1);
    expect(
      browser.sockets[0]!.commands.find(
        (c) => c.method === "Page.startScreencast",
      )?.params,
    ).toEqual({
      ...defaultCapture,
      quality: 0,
      sendLastFrame: true,
    });
  },
);

it.each([{ maxWidth: 0 }, { maxWidth: 4096, maxHeight: 4096 }])(
  "preserves selected input and the last capture after an invalid runtime update: %j",
  async (invalid) => {
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
    controller.setCapture(invalid);
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      error: { kind: "configuration" },
    });
    const error = model.getSnapshot().error;
    controller.setCapture(invalid);
    expect(model.getSnapshot().error).toBe(error);
    expect(controller.input).toBe(input);
    expect(socket.commands).toHaveLength(count);
    controller.setCapture({ maxWidth: 1280, maxHeight: 720 });
    expect(model.getSnapshot().error).toBeNull();
    expect(socket.commands).toHaveLength(count);
  },
);

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
  ).toEqual({
    format: "webp",
    quality: 70,
    maxWidth: 960,
    maxHeight: 540,
    sendLastFrame: true,
  });
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
