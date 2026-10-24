import { afterEach, expect, it, vi } from "vitest";
import { CdpFault } from "../../src/cdp/errors";
import type { FrameSink } from "../../src/render/canvas";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { fakeRaster, FakeBrowser } from "./wire";
import type { InputTransition } from "../../src/input/lifecycle";

const controllers: ViewerController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.close());
  vi.useRealTimers();
});

function mount(
  browser: FakeBrowser,
  transport: "shared" | "split",
  windowId = 0,
  onInputReset?: (reason: InputTransition) => void,
) {
  const model = createViewerModel();
  const sink = {
    push: vi.fn<FrameSink["push"]>((data, paint) => paint(fakeRaster(data))),
    reset: vi.fn(),
    invalidate: vi.fn(),
    dispose: vi.fn(),
  };
  const controller = new ViewerController(model, sink, {
    url: "wss://fixture.invalid/",
    interactive: true,
    windowId,
    transport,
    socketFactory: browser.factory,
    ...(onInputReset ? { onInputReset } : {}),
  });
  controllers.push(controller);
  controller.start();
  const frameSocket = () => browser.sockets[transport === "split" ? 1 : 0]!;
  const frameSession = () =>
    frameSocket().commands.find(
      (command) => command.method === "Page.startScreencast",
    )!.sessionId!;
  const failImage = () => {
    vi.mocked(sink.push).mockImplementationOnce((_data, _paint, failed) =>
      failed(new CdpFault("frame", "Synthetic image failure.")),
    );
    browser.frame(frameSocket(), frameSession());
  };
  return { model, sink, controller, frameSocket, frameSession, failImage };
}

async function until(condition: () => boolean) {
  for (let turn = 0; turn < 250; turn++) {
    if (condition()) return;
    await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error("Expected owned protocol boundary was not reached.");
}

const starts = (browser: FakeBrowser) =>
  browser.sockets
    .flatMap((socket) => socket.commands)
    .filter((command) => command.method === "Page.startScreencast");

for (const transport of ["shared", "split"] as const) {
  it.each(["before-reply", "after-reply"])(
    `${transport}: cancels current and future display image waiters when calibration fails %s`,
    async (phase) => {
      vi.useFakeTimers();
      const browser = new FakeBrowser();
      const f = mount(browser, transport);
      await until(() => f.model.getSnapshot().status === "streaming");
      browser.holdFrames = true;
      if (phase === "before-reply")
        f.frameSocket().holdReplyMethod = "Page.startScreencast";
      f.controller.measureDisplay({ width: 640, height: 480, dpr: 1 });
      f.controller.setWindowSizeSync("initial");
      await until(() => browser.heldFrames.length > 0);
      expect(f.model.read(f.model.display$).pending).toBe(true);
      vi.mocked(f.sink.push).mockImplementationOnce((_data, _paint, failed) =>
        failed(new CdpFault("frame", "Synthetic calibration image failure.")),
      );
      browser.heldFrames.shift()!();
      await until(() => f.model.getSnapshot().status === "error");
      if (phase === "before-reply") {
        const socket = f.frameSocket();
        socket.holdReplyMethod = null;
        for (const reply of socket.heldReplies.splice(0))
          socket.reply(reply.command, reply.result);
      }
      await until(() => f.model.read(f.model.controls$).canRetryImage);
      // All native effects have settled without advancing the impossible image wait's deadline.
      expect(f.model.read(f.model.display$).pending).toBe(false);
      expect(f.controller.input).toBeNull();
      const beforeRetry = starts(browser).length;
      browser.holdFrames = false;
      f.controller.measureDisplay({ width: 720, height: 420, dpr: 1 });
      await vi.advanceTimersByTimeAsync(151);
      const socket = f.frameSocket();
      socket.holdReplyMethod = "Page.startScreencast";
      const sizing = () =>
        browser.sockets
          .flatMap((wire) => wire.commands)
          .filter(
            (command) =>
              command.method === "Emulation.setDeviceMetricsOverride",
          ).length;
      const beforeSizing = sizing();
      f.controller.retryImage();
      await until(() => f.model.getSnapshot().status === "streaming");
      expect(starts(browser)).toHaveLength(beforeRetry + 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(sizing()).toBe(beforeSizing);
      socket.holdReplyMethod = null;
      for (const reply of socket.heldReplies.splice(0))
        socket.reply(reply.command, reply.result);
      await until(
        () =>
          browser.windowSizes.get(0)?.width === 720 &&
          browser.windowSizes.get(0)?.height === 420,
      );
      expect(f.controller.input).not.toBeNull();
    },
  );

  it.each(["select", "pause"])(
    `${transport}: retains a positive original stop receipt after %s retires its active owner`,
    async (boundary) => {
      vi.useFakeTimers();
      const browser = new FakeBrowser();
      const f = mount(browser, transport);
      await until(() => f.model.getSnapshot().status === "streaming");
      const originalSession = f.controller.input!.sessionId;
      browser.holdMethod = "Page.stopScreencast";
      f.failImage();
      await until(() => browser.heldCommands.length === 1);
      const stop = browser.heldCommands.shift()!;
      if (boundary === "select") f.controller.select("page-a");
      else {
        f.controller.setPaused(true);
        f.controller.setPaused(false);
      }
      browser.holdMethod = null;
      stop.socket.reply(stop.command);
      if (boundary === "pause") {
        await until(() => f.model.read(f.model.controls$).canRetryImage);
        f.controller.retryImage();
      }
      await until(() => f.model.getSnapshot().status === "streaming");
      expect(f.controller.input!.sessionId).not.toBe(originalSession);
      expect(starts(browser)).toHaveLength(2);
      expect(browser.sockets).toHaveLength(transport === "split" ? 2 : 1);
    },
  );

  it(`${transport}: confirms original stop, coalesces retry and requires current paint without replacing sessions`, async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    const f = mount(browser, transport);
    await until(() => f.model.getSnapshot().status === "streaming");
    const input = f.controller.input!;
    const oldOwner = input.owner;
    const oldPaint = vi.mocked(f.sink.push).mock.calls[0]![1];
    const originalStart = starts(browser)[0]!;
    const originalSockets = [...browser.sockets];
    browser.holdMethod = "Page.stopScreencast";
    f.failImage();
    await until(() => browser.heldCommands.length === 1);
    expect(f.controller.input).toBeNull();
    expect(input.owner).not.toBe(oldOwner);
    expect(f.model.read(f.model.controls$).canRetryImage).toBe(false);
    f.controller.retryImage();
    f.controller.retryImage();
    expect(starts(browser)).toHaveLength(1);
    browser.holdMethod = null;
    const stop = browser.heldCommands.shift()!;
    expect(stop.command.method).toBe("Page.stopScreencast");
    browser.resume(stop.command, stop.socket);
    await until(() => f.model.read(f.model.controls$).canRetryImage);
    f.controller.setCapture({ quality: 45 });
    expect(starts(browser)).toHaveLength(1);
    browser.holdFrames = true;
    f.controller.retryImage();
    f.controller.retryImage();
    await until(() => browser.heldFrames.length === 1);
    expect(starts(browser)).toHaveLength(2);
    expect(starts(browser)[1]).toMatchObject({
      sessionId: originalStart.sessionId,
      params: { quality: 45 },
    });
    expect(f.model.getSnapshot().status).toBe("connecting");
    expect(f.controller.input).toBeNull();
    oldPaint({ width: 800, height: 600 });
    const pushes = vi.mocked(f.sink.push).mock.calls.length;
    f.frameSocket().emit(
      "Page.screencastFrame",
      {
        sessionId: 991,
        data: btoa(JSON.stringify({ width: 800, height: 600 })),
        metadata: { timestamp: 1 },
      },
      f.frameSession(),
    );
    expect(vi.mocked(f.sink.push)).toHaveBeenCalledTimes(pushes);
    expect(f.controller.input).toBeNull();
    browser.heldFrames.shift()!();
    await until(() => f.model.getSnapshot().status === "streaming");
    expect(f.controller.input).toBe(input);
    expect(browser.sockets).toEqual(originalSockets);
    expect(
      browser.sockets
        .flatMap((socket) => socket.commands)
        .some(
          (command) =>
            command.method === "Target.detachFromTarget" ||
            command.method === "Page.navigate" ||
            command.method === "Page.reload" ||
            command.method.startsWith("Emulation.") ||
            command.method === "Browser.setContentsSize",
        ),
    ).toBe(false);
  });

  it(`${transport}: a first-paint deadline recovers without accepting its held original frame`, async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    browser.holdFrames = true;
    const f = mount(browser, transport);
    await until(() => browser.heldFrames.length === 1);
    await vi.advanceTimersByTimeAsync(10_001);
    await until(() => f.model.read(f.model.controls$).canRetryImage);
    expect(f.model.getSnapshot()).toMatchObject({
      status: "error",
      error: { kind: "frame" },
      selectedTargetId: "page-a",
    });
    f.controller.retryImage();
    await until(() => browser.heldFrames.length === 2);
    browser.heldFrames.shift()!();
    expect(f.controller.input).toBeNull();
    expect(f.model.getSnapshot().status).toBe("connecting");
    browser.heldFrames.shift()!();
    await until(() => f.model.getSnapshot().status === "streaming");
    expect(browser.sockets).toHaveLength(transport === "split" ? 2 : 1);
  });

  it.each(["rejected", "timed-out"])(
    `${transport}: %s stop cannot authorize another capture`,
    async (outcome) => {
      vi.useFakeTimers();
      const browser = new FakeBrowser();
      const f = mount(browser, transport);
      await until(() => f.model.getSnapshot().status === "streaming");
      browser.holdMethod = "Page.stopScreencast";
      f.failImage();
      await until(() => browser.heldCommands.length === 1);
      const stop = browser.heldCommands[0]!;
      if (outcome === "rejected") stop.socket.reject(stop.command, -32000);
      else await vi.advanceTimersByTimeAsync(10_001);
      await until(
        () => f.model.read(f.model.imageRecovery$)?.phase === "blocked",
      );
      expect(f.model.read(f.model.controls$).showImageRetry).toBe(false);
      f.controller.retryImage();
      stop.socket.reply(stop.command);
      await vi.advanceTimersByTimeAsync(0);
      expect(starts(browser)).toHaveLength(1);
      expect(f.controller.input).toBeNull();
    },
  );

  it(`${transport}: waits for original pressed-key cleanup before image retry`, async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    const f = mount(browser, transport);
    await until(() => f.model.getSnapshot().status === "streaming");
    const input = f.controller.input!;
    input.key({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
    await input.completion(input.owner!);
    browser.holdMethod = "Input.dispatchKeyEvent";
    f.failImage();
    await until(() => browser.heldCommands.length === 1);
    expect(browser.heldCommands[0]!.command.params?.type).toBe("keyUp");
    expect(f.model.read(f.model.controls$).canRetryImage).toBe(false);
    f.controller.retryImage();
    expect(starts(browser)).toHaveLength(1);
    browser.holdMethod = null;
    const held = browser.heldCommands.shift()!;
    browser.resume(held.command, held.socket);
    await until(() => f.model.read(f.model.controls$).canRetryImage);
    f.controller.retryImage();
    await until(() => f.model.getSnapshot().status === "streaming");
    expect(f.controller.input).toBe(input);
  });

  it(`${transport}: pause retires valid sessions and later explicit retry freshly attaches without new sockets`, async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    const f = mount(browser, transport);
    await until(() => f.model.getSnapshot().status === "streaming");
    const old = f.controller.input!.sessionId;
    f.failImage();
    await until(() => f.model.read(f.model.controls$).canRetryImage);
    f.controller.setPaused(true);
    f.controller.retryImage();
    expect(starts(browser)).toHaveLength(1);
    f.controller.setPaused(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts(browser)).toHaveLength(1);
    expect(f.model.getSnapshot().status).toBe("error");
    f.controller.retryImage();
    await until(() => f.model.getSnapshot().status === "streaming");
    expect(f.controller.input!.sessionId).not.toBe(old);
    expect(browser.sockets).toHaveLength(transport === "split" ? 2 : 1);
  });
}

it.each(["close", "move", "unmount", "socket"])(
  "does not restore a held retry after %s",
  async (boundary) => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    const f = mount(browser, "split");
    await until(() => f.model.getSnapshot().status === "streaming");
    f.failImage();
    await until(() => f.model.read(f.model.controls$).canRetryImage);
    browser.holdMethod = "Runtime.evaluate";
    f.controller.retryImage();
    await until(() => browser.heldCommands.length > 0);
    if (boundary === "close") {
      browser.targets = browser.targets.filter(
        (target) => target.id !== "page-a",
      );
      browser.sockets[0]!.emit("Target.targetDestroyed", {
        targetId: "page-a",
      });
    } else if (boundary === "move") {
      browser.targets[0]!.windowId = 2;
      await vi.advanceTimersByTimeAsync(2001);
    } else if (boundary === "unmount") f.controller.close();
    else browser.sockets[1]!.close();
    browser.holdMethod = null;
    for (const held of browser.heldCommands)
      browser.resume(held.command, held.socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts(browser)).toHaveLength(1);
    expect(f.controller.input).toBeNull();
  },
);

it("keeps a sibling independent and requires reconnect after rejected input cleanup", async () => {
  vi.useFakeTimers();
  const browser = new FakeBrowser();
  const a = mount(browser, "shared", 0);
  const b = mount(browser, "shared", 2);
  await until(
    () =>
      a.model.getSnapshot().status === "streaming" &&
      b.model.getSnapshot().status === "streaming",
  );
  const input = a.controller.input!;
  input.key({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
  await input.completion(input.owner!);
  browser.holdMethod = "Input.dispatchKeyEvent";
  a.failImage();
  await until(() => browser.heldCommands.length === 1);
  const release = browser.heldCommands[0]!;
  browser.holdMethod = null;
  release.socket.reject(release.command, -32000);
  await until(() => a.model.read(a.model.imageRecovery$)?.phase === "blocked");
  a.controller.retryImage();
  expect(b.model.getSnapshot().status).toBe("streaming");
  b.controller.input!.text("sibling still usable");
  await b.controller.input!.completion(b.controller.input!.owner!);
  expect(browser.sockets).toHaveLength(2);
  expect(starts(browser)).toHaveLength(2);
});

it("keeps an original input reset callback from suspending a replacement selection", async () => {
  vi.useFakeTimers();
  const browser = new FakeBrowser();
  browser.targets[1]!.windowId = 0;
  let replace = false;
  const f = mount(browser, "shared", 0, (reason) => {
    if (reason === "failed" && replace) {
      replace = false;
      f.controller.select("page-b");
    }
  });
  await until(() => f.model.getSnapshot().status === "streaming");
  f.controller.measureDisplay({ width: 640, height: 480, dpr: 1 });
  replace = true;
  f.failImage();
  await until(
    () =>
      f.model.getSnapshot().status === "streaming" &&
      f.model.getSnapshot().selectedTargetId === "page-b",
  );
  expect(f.controller.input).not.toBeNull();
  expect(f.model.read(f.model.display$).ready).toBe(true);
  expect(f.model.read(f.model.imageRecovery$)).toBeNull();
});

it("does not start an obsolete retry after a publication selects a new target", async () => {
  vi.useFakeTimers();
  const browser = new FakeBrowser();
  browser.targets[1]!.windowId = 0;
  const f = mount(browser, "shared");
  await until(() => f.model.getSnapshot().status === "streaming");
  f.failImage();
  await until(() => f.model.read(f.model.controls$).canRetryImage);
  const stop = f.model.subscribe(() => {
    if (
      f.model.getSnapshot().status === "connecting" &&
      f.model.read(f.model.imageRecovery$)?.phase === "retrying"
    )
      f.controller.select("page-b");
  });
  f.controller.retryImage();
  await until(() => f.model.getSnapshot().status === "streaming");
  stop();
  expect(f.model.getSnapshot().selectedTargetId).toBe("page-b");
  expect(starts(browser)).toHaveLength(2);
});

it("requires confirmed freshness and never substitutes old frames when the native clock is unsupported", async () => {
  vi.useFakeTimers();
  const browser = new FakeBrowser();
  const f = mount(browser, "shared");
  await until(() => f.model.getSnapshot().status === "streaming");
  f.failImage();
  await until(() => f.model.read(f.model.controls$).canRetryImage);
  browser.unsupportedClock = true;
  f.controller.retryImage();
  await until(() => f.model.read(f.model.imageRecovery$)?.phase === "blocked");
  expect(starts(browser)).toHaveLength(1);
  expect(f.controller.input).toBeNull();
  expect(f.model.getSnapshot()).toMatchObject({
    status: "error",
    error: { kind: "display" },
  });
});

it("settles an uncertain retry start with a positive stop before permitting another explicit attempt", async () => {
  vi.useFakeTimers();
  const browser = new FakeBrowser();
  const f = mount(browser, "shared");
  await until(() => f.model.getSnapshot().status === "streaming");
  f.failImage();
  await until(() => f.model.read(f.model.controls$).canRetryImage);
  browser.holdCommand = (command) =>
    command.method === "Page.startScreencast" ||
    command.method === "Page.stopScreencast";
  f.controller.retryImage();
  await until(() => browser.heldCommands.length === 1);
  await vi.advanceTimersByTimeAsync(10_001);
  await until(() => browser.heldCommands.length === 2);
  expect(starts(browser)).toHaveLength(2);
  expect(f.model.read(f.model.controls$).canRetryImage).toBe(false);
  f.controller.retryImage();
  browser.holdCommand = null;
  const heldStop = browser.heldCommands.find(
    (held) => held.command.method === "Page.stopScreencast",
  )!;
  browser.resume(heldStop.command, heldStop.socket);
  await until(() => f.model.read(f.model.controls$).canRetryImage);
  expect(starts(browser)).toHaveLength(2);
  f.controller.retryImage();
  await until(() => f.model.getSnapshot().status === "streaming");
  expect(starts(browser)).toHaveLength(3);
});
