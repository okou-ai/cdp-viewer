import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";
import { browserUse } from "../../src/extensions/browser-use";
import type { ExtensionContext } from "../../src/extensions/types";
import type { FrameSink } from "../../src/render/canvas";
import { CdpFault } from "../../src/cdp/errors";

const controllers: ViewerController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((c) => c.close());
  vi.useRealTimers();
});

function mount(
  browser: FakeBrowser,
  windowId?: number,
  requestTimeout?: number,
  interactive = false,
) {
  const model = createViewerModel();
  const sink = {
    push: vi.fn<FrameSink["push"]>(
      (
        _data: string,
        paint: (raster: { width: number; height: number }) => void,
      ) => paint({ width: 800, height: 600 }),
    ),
    reset: vi.fn(),
    invalidate: vi.fn(),
    dispose: vi.fn(),
  };
  const controller = new ViewerController(model, sink, {
    url: "wss://fixture.invalid/?token=private-endpoint",
    socketFactory: browser.factory,
    interactive,
    ...(windowId === undefined ? {} : { windowId }),
    ...(requestTimeout === undefined ? {} : { requestTimeout }),
  });
  controllers.push(controller);
  controller.start();
  return { controller, model, sink };
}

describe("viewer lifecycle", () => {
  it("retains only the outgoing image through rapid switches and waits for the current paint", async () => {
    const browser = new FakeBrowser();
    const { controller, model, sink } = mount(browser);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const resets = sink.reset.mock.calls.length;
    sink.push.mockImplementation(() => {});
    sink.push.mockClear();
    controller.select("page-b");
    expect(model.read(model.controls$).loadingPreview).toBe(true);
    expect(controller.input).toBeNull();
    expect(sink.reset).toHaveBeenCalledTimes(resets);
    expect(sink.invalidate).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledOnce());
    const oldPaint = sink.push.mock.calls[0]![1];
    controller.select("page-a");
    expect(model.read(model.controls$).loadingPreview).toBe(true);
    expect(sink.reset).toHaveBeenCalledTimes(resets);
    expect(sink.invalidate).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledTimes(2));
    oldPaint({ width: 800, height: 600 });
    expect(model.getSnapshot().status).toBe("connecting");
    expect(model.read(model.controls$).loadingPreview).toBe(true);
    sink.push.mock.calls[1]![1]({ width: 800, height: 600 });
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "page-a",
    });
    expect(model.read(model.controls$).loadingPreview).toBe(false);
  });

  it.each([
    "pause",
    "loss",
    "scope",
    "failure",
    "disconnect",
    "dispose",
  ] as const)("clears a retained loading image on %s", async (boundary) => {
    const browser = new FakeBrowser();
    browser.targets[1]!.windowId = 0;
    const { controller, model, sink } = mount(browser, 0);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    browser.holdFrames = true;
    controller.select("page-b");
    await vi.waitFor(() => expect(browser.heldFrames).toHaveLength(1));
    expect(model.read(model.controls$).loadingPreview).toBe(true);
    const resets = sink.reset.mock.calls.length;
    if (boundary === "pause") controller.setPaused(true);
    else if (boundary === "dispose") controller.close();
    else if (boundary === "disconnect") browser.sockets[0]!.close();
    else if (boundary === "scope") {
      browser.unsupportedWindows = true;
      browser.sockets[0]!.emit("Target.targetInfoChanged", {});
      await vi.waitFor(() =>
        expect(model.read(model.controls$).loadingPreview).toBe(false),
      );
    } else if (boundary === "loss") {
      browser.targets = browser.targets.filter((t) => t.id !== "page-b");
      browser.sockets[0]!.emit("Target.targetDestroyed", {
        targetId: "page-b",
      });
    } else {
      sink.push.mockImplementationOnce((_data, _paint, failed) =>
        failed(new CdpFault("frame", "Synthetic decode failure")),
      );
      browser.heldFrames.shift()!();
    }
    expect(model.read(model.controls$).loadingPreview).toBe(false);
    expect(sink.reset.mock.calls.length).toBeGreaterThan(resets);
    expect(controller.input).toBeNull();
  });

  it("acknowledges older capture readbacks without replacing newer pixels and resets ordering per selection", async () => {
    const browser = new FakeBrowser();
    const { controller, model, sink } = mount(browser);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const socket = browser.sockets[0]!;
    sink.push.mockClear();
    socket.emit(
      "Page.screencastFrame",
      { sessionId: 501, data: "newer", metadata: { timestamp: 2 } },
      "session-1",
    );
    socket.emit(
      "Page.screencastFrame",
      { sessionId: 502, data: "older", metadata: { timestamp: 1 } },
      "session-1",
    );
    expect(sink.push.mock.calls.map(([data]) => data)).toEqual(["newer"]);
    expect(
      socket.commands
        .filter((command) => command.method === "Page.screencastFrameAck")
        .slice(-2)
        .map((command) => command.params?.sessionId),
    ).toEqual([501, 502]);
    socket.emit(
      "Page.screencastFrame",
      { sessionId: 503, data: "without-time", metadata: {} },
      "session-1",
    );
    expect(sink.push).toHaveBeenLastCalledWith(
      "without-time",
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    controller.select("page-b");
    await vi.waitFor(() =>
      expect(model.getSnapshot().selectedTargetId).toBe("page-b"),
    );
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    socket.emit(
      "Page.screencastFrame",
      { sessionId: 504, data: "replacement", metadata: { timestamp: 0.5 } },
      "session-2",
    );
    expect(sink.push).toHaveBeenLastCalledWith(
      "replacement",
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("follows Browser Use activation and preserves the stream on activation echoes", async () => {
    const browser = new FakeBrowser();
    const { controller, model } = mount(browser);
    controller.setExtensions([browserUse()]);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const socket = browser.sockets[0]!;
    socket.emit("BrowserUse.activeTargetChanged", { targetId: "page-b" });
    await vi.waitFor(() =>
      expect(model.getSnapshot()).toMatchObject({
        status: "streaming",
        selectedTargetId: "page-b",
      }),
    );
    const commands = socket.commands.length;
    socket.emit("BrowserUse.activeTargetChanged", { targetId: "page-b" });
    expect(socket.commands).toHaveLength(commands);
    expect(
      socket.commands.filter(
        (command) => command.method === "Target.attachToTarget",
      ),
    ).toHaveLength(2);
  });

  it("keeps the latest activation when it reselects the current target", async () => {
    const browser = new FakeBrowser();
    const { controller, model } = mount(browser);
    let context!: ExtensionContext;
    controller.setExtensions([
      {
        id: "custom",
        setup: (owner) => {
          context = owner;
        },
      },
    ]);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    browser.holdMethod = "Target.getTargetInfo";
    const pending = context.requestTargetSelection("page-b");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    expect(await context.requestTargetSelection("page-a")).toBe(false);
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command, {
      targetInfo: { targetId: "page-b", type: "page" },
    });
    expect(await pending).toBe(false);
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "page-a",
    });
    expect(
      held.socket.commands.filter(
        (command) => command.method === "Target.attachToTarget",
      ),
    ).toHaveLength(1);
  });

  it("follows each window's activation independently with a shared Browser Use adapter", async () => {
    const browser = new FakeBrowser();
    browser.targets.push(
      { id: "next-a", windowId: 0, title: "Next A" },
      { id: "next-b", windowId: 2, title: "Next B" },
    );
    const a = mount(browser, 0);
    const b = mount(browser, 2);
    const adapter = browserUse();
    a.controller.setExtensions([adapter]);
    b.controller.setExtensions([adapter]);
    await vi.waitFor(() => {
      expect(a.model.getSnapshot().status).toBe("streaming");
      expect(b.model.getSnapshot().status).toBe("streaming");
    });
    for (const targetId of ["next-a", "next-b"]) {
      for (const socket of browser.sockets)
        socket.emit("BrowserUse.activeTargetChanged", { targetId });
      await vi.waitFor(() => {
        expect(a.model.getSnapshot()).toMatchObject({
          status: "streaming",
          selectedTargetId: "next-a",
        });
        expect(b.model.getSnapshot()).toMatchObject({
          status: "streaming",
          selectedTargetId: targetId === "next-a" ? "page-b" : "next-b",
        });
      });
    }
  });

  it("finishes adapter cleanup before replacing its configuration on the same connection", async () => {
    const browser = new FakeBrowser();
    const { controller, model } = mount(browser);
    let finish!: () => void;
    const retiring = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cleanup = vi.fn(() => retiring);
    const setup = vi.fn((_context: ExtensionContext) =>
      Promise.resolve(cleanup),
    );
    const replacement = vi.fn();
    controller.setExtensions([{ id: "custom", setup }]);
    await vi.waitFor(() => expect(setup).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    controller.setExtensions([
      { id: "custom", key: "updated", setup: replacement },
    ]);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(setup.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(replacement).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(replacement).toHaveBeenCalledOnce());
    expect(browser.sockets).toHaveLength(1);
    expect(model.getSnapshot().status).toBe("streaming");
  });

  it("keeps displayed tab order when discovery reorders and updates targets", async () => {
    const browser = new FakeBrowser();
    const { model } = mount(browser);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    browser.targets = [
      { id: "page-c", windowId: 0, title: "New page" },
      { ...browser.targets[1]!, title: "Updated title" },
      browser.targets[0]!,
    ];
    browser.sockets[0]!.emit("Target.targetInfoChanged", {});
    await vi.waitFor(() => expect(model.getSnapshot().targets).toHaveLength(3));
    expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
      "page-a",
      "page-b",
      "page-c",
    ]);
    expect(model.getSnapshot().targets[1]!.title).toBe("Updated title");
  });
  it("ignores an obsolete discovery error after explicit close selects its neighbour", async () => {
    const browser = new FakeBrowser();
    browser.targets[1]!.windowId = 0;
    const { controller, model } = mount(browser, 0, undefined, true);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const socket = browser.sockets[0]!;
    browser.holdMethod = "Browser.getWindowForTarget";
    socket.emit("Target.targetInfoChanged", {});
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
    browser.holdMethod = null;
    controller.closeTab("page-a");
    await vi.waitFor(() =>
      expect(model.getSnapshot()).toMatchObject({
        status: "streaming",
        selectedTargetId: "page-b",
      }),
    );
    const before = socket.commands.filter(
      (command) => command.method === "Target.getTargets",
    ).length;
    for (const held of browser.heldCommands) {
      if (held.command.params?.targetId === "page-a")
        held.socket.reject(held.command, -32000);
      else held.socket.reply(held.command, { windowId: 0, bounds: {} });
    }
    await vi.waitFor(() =>
      expect(
        socket.commands.filter(
          (command) => command.method === "Target.getTargets",
        ).length,
      ).toBeGreaterThan(before),
    );
    await vi.waitFor(() =>
      expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
        "page-b",
      ]),
    );
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "page-b",
    });
  });
  it("reports an unsupported streaming capability without exposing provider errors", async () => {
    const browser = new FakeBrowser();
    browser.unsupportedStream = true;
    const { model } = mount(browser);
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe("error"));
    expect(model.getSnapshot().error).toEqual({
      kind: "unsupported-capability",
      message: "The browser does not support a required CDP viewer command.",
      request: { method: "Page.startScreencast", code: -32601 },
    });
  });
  it("keeps window zero scoped, acknowledges numeric frame IDs in the owning session", async () => {
    const browser = new FakeBrowser();
    const { model } = mount(browser, 0);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    expect(model.getSnapshot().targets.map((t) => t.id)).toEqual(["page-a"]);
    const ack = browser.sockets[0]!.commands.find(
      (c) => c.method === "Page.screencastFrameAck",
    );
    expect(ack).toMatchObject({
      params: { sessionId: 73 },
      sessionId: "session-1",
    });
  });

  it("does not call window APIs in unscoped mode, even when unsupported", async () => {
    const browser = new FakeBrowser();
    browser.unsupportedWindows = true;
    const { model } = mount(browser);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    expect(model.getSnapshot().targets).toHaveLength(2);
    expect(
      browser.sockets[0]!.commands.some((c) =>
        c.method.startsWith("Browser.getWindow"),
      ),
    ).toBe(false);
  });

  it("never exposes other windows after unsupported or absent scoped mapping", async () => {
    const browser = new FakeBrowser();
    browser.unsupportedWindows = true;
    const unsupported = mount(browser, 0);
    await vi.waitFor(() =>
      expect(unsupported.model.getSnapshot().status).toBe("unavailable"),
    );
    expect(unsupported.model.getSnapshot().targets).toEqual([]);
    expect(unsupported.model.getSnapshot().error?.kind).toBe(
      "unsupported-capability",
    );
    expect(JSON.stringify(unsupported.model.getSnapshot())).not.toContain(
      "private",
    );
    expect(unsupported.model.getSnapshot().error?.request).toEqual({
      method: "Browser.getWindowForTarget",
      code: -32601,
    });
    browser.unsupportedWindows = false;
    const missing = mount(browser, 99);
    await vi.waitFor(() =>
      expect(missing.model.getSnapshot().status).toBe("unavailable"),
    );
    expect(missing.model.getSnapshot().targets).toEqual([]);
    missing.controller.setPaused(true);
    expect(missing.model.getSnapshot().status).toBe("unavailable");
    expect(
      browser.sockets
        .flatMap((s) => s.commands)
        .some((c) =>
          ["Target.activateTarget", "Target.attachToTarget"].includes(c.method),
        ),
    ).toBe(false);
  });

  it("detects movement without a target event and clears the previous stream", async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    const { model, sink } = mount(browser, 0);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const resets = sink.reset.mock.calls.length;
    browser.targets[0]!.windowId = 2;
    await vi.advanceTimersByTimeAsync(2000);
    expect(model.getSnapshot()).toMatchObject({
      status: "unavailable",
      selectedTargetId: null,
      targets: [],
    });
    expect(sink.reset.mock.calls.length).toBeGreaterThan(resets);
    expect(
      browser.sockets[0]!.commands.some(
        (c) => c.method === "Target.detachFromTarget",
      ),
    ).toBe(true);
  });

  it("leaves a closed selection unavailable until explicit recovery", async () => {
    const browser = new FakeBrowser();
    const { model } = mount(browser);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    browser.targets = browser.targets.filter((t) => t.id !== "page-a");
    browser.sockets[0]!.emit("Target.targetDestroyed", { targetId: "page-a" });
    await vi.waitFor(() =>
      expect(model.getSnapshot().targets.map((t) => t.id)).toEqual(["page-b"]),
    );
    expect(model.getSnapshot()).toMatchObject({
      status: "unavailable",
      selectedTargetId: null,
    });
    expect(
      browser.sockets[0]!.commands.filter(
        (c) => c.method === "Target.attachToTarget",
      ),
    ).toHaveLength(1);
  });

  it("releases a superseded attach response without painting or selecting it", async () => {
    const browser = new FakeBrowser();
    browser.holdAttach = true;
    const { controller, model, sink } = mount(browser);
    await vi.waitFor(() => expect(browser.held).toHaveLength(1));
    browser.holdAttach = false;
    controller.select("page-b");
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const count = sink.push.mock.calls.length;
    const held = browser.held[0]!;
    held.socket.reply(held.command, { sessionId: held.sessionId });
    await vi.waitFor(() =>
      expect(
        held.socket.commands.some(
          (c) =>
            c.method === "Target.detachFromTarget" &&
            c.params?.sessionId === held.sessionId,
        ),
      ).toBe(true),
    );
    browser.frame(held.socket, held.sessionId);
    expect(model.getSnapshot().selectedTargetId).toBe("page-b");
    expect(sink.push.mock.calls.length).toBe(count);
  });

  it("rechecks window membership when a target moves during activation", async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    browser.holdMethod = "Target.activateTarget";
    const { model, sink } = mount(browser, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.heldCommands).toHaveLength(1);
    browser.targets[0]!.windowId = 2;
    const activation = browser.heldCommands[0]!;
    activation.socket.reply(activation.command);
    await vi.advanceTimersByTimeAsync(0);
    expect(model.getSnapshot()).toMatchObject({
      status: "error",
      error: { kind: "scope" },
    });
    expect(sink.push).not.toHaveBeenCalled();
    expect(
      activation.socket.commands.some(
        (command) => command.method === "Target.attachToTarget",
      ),
    ).toBe(false);
  });

  it.each(["moved", "failed"])(
    "rejects an attached session whose post-attach scope is %s",
    async (outcome) => {
      const browser = new FakeBrowser();
      browser.holdAttach = true;
      const { controller, model, sink } = mount(browser, 0, undefined, true);
      await vi.waitFor(() => expect(browser.held).toHaveLength(1));
      if (outcome === "moved") browser.targets[0]!.windowId = 2;
      else browser.unsupportedWindows = true;
      const attached = browser.held[0]!;
      attached.socket.reply(attached.command, {
        sessionId: attached.sessionId,
      });
      await vi.waitFor(() => expect(model.getSnapshot().status).toBe("error"));
      expect(controller.input).toBeNull();
      expect(sink.push).not.toHaveBeenCalled();
      expect(
        attached.socket.commands.some(
          (c) =>
            c.method === "Target.detachFromTarget" &&
            c.params?.sessionId === attached.sessionId,
        ),
      ).toBe(true);
      expect(
        attached.socket.commands.some(
          (c) =>
            c.sessionId === attached.sessionId &&
            [
              "Page.enable",
              "Page.startScreencast",
              "Page.getFrameTree",
            ].includes(c.method),
        ),
      ).toBe(false);
    },
  );

  it("does not enable an obsolete session after post-attach verification returns", async () => {
    const browser = new FakeBrowser();
    browser.holdAttach = true;
    const { controller, model } = mount(browser, 0, undefined, true);
    await vi.waitFor(() => expect(browser.held).toHaveLength(1));
    const old = browser.held[0]!;
    browser.holdAttach = false;
    browser.holdMethod = "Browser.getWindowForTarget";
    old.socket.reply(old.command, { sessionId: old.sessionId });
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    browser.holdMethod = null;
    controller.setPaused(true);
    controller.setPaused(false);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const check = browser.heldCommands[0]!;
    check.socket.reply(check.command, { windowId: 0 });
    await Promise.resolve();
    expect(
      old.socket.commands.some(
        (c) => c.sessionId === old.sessionId && c.method === "Page.enable",
      ),
    ).toBe(false);
    expect(controller.input).not.toBeNull();
  });

  it("does not attach a stale selection after its activation completes", async () => {
    const browser = new FakeBrowser();
    browser.holdMethod = "Target.activateTarget";
    const { controller, model } = mount(browser);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    expect(
      browser.sockets[0]!.commands.some(
        (command) => command.method === "Target.attachToTarget",
      ),
    ).toBe(false);
    browser.holdMethod = null;
    controller.select("page-b");
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const old = browser.heldCommands[0]!;
    old.socket.reply(old.command);
    await Promise.resolve();
    expect(model.getSnapshot().selectedTargetId).toBe("page-b");
    expect(
      browser.sockets[0]!.commands.filter(
        (command) => command.method === "Target.attachToTarget",
      ).map((command) => command.params?.targetId),
    ).toEqual(["page-b"]);
  });

  it("reports activation failure without attaching or exposing provider errors", async () => {
    const browser = new FakeBrowser();
    browser.holdMethod = "Target.activateTarget";
    const { model } = mount(browser);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const activation = browser.heldCommands[0]!;
    activation.socket.reject(activation.command);
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe("error"));
    expect(model.getSnapshot().error).toEqual({
      kind: "unsupported-capability",
      message: "The browser does not support a required CDP viewer command.",
      request: { method: "Target.activateTarget", code: -32601 },
    });
    expect(
      activation.socket.commands.some(
        (command) => command.method === "Target.attachToTarget",
      ),
    ).toBe(false);
  });

  it("releases an attach that arrives after its request timeout", async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    browser.holdAttach = true;
    const { model } = mount(browser, undefined, 50);
    // Finish opening/discovery without waitFor advancing to the RPC deadline.
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.held).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(model.getSnapshot().status).toBe("error");
    const held = browser.held[0]!;
    held.socket.reply(held.command, { sessionId: held.sessionId });
    await Promise.resolve();
    expect(
      held.socket.commands.some(
        (c) =>
          c.method === "Target.detachFromTarget" &&
          c.params?.sessionId === held.sessionId,
      ),
    ).toBe(true);
  });

  it("isolates two viewers, pause/resume, and teardown without closing remote targets", async () => {
    const browser = new FakeBrowser();
    const first = mount(browser, 0);
    const second = mount(browser, 2);
    await vi.waitFor(() =>
      expect([
        first.model.getSnapshot().status,
        second.model.getSnapshot().status,
      ]).toEqual(["streaming", "streaming"]),
    );
    first.controller.setPaused(true);
    expect(first.model.getSnapshot().status).toBe("paused");
    expect(second.model.getSnapshot().status).toBe("streaming");
    first.controller.setPaused(false);
    await vi.waitFor(() =>
      expect(first.model.getSnapshot().status).toBe("streaming"),
    );
    first.controller.close();
    expect(first.sink.dispose).toHaveBeenCalledTimes(1);
    expect(browser.sockets[0]!.readyState).toBe(3);
    expect(browser.sockets[1]!.readyState).toBe(1);
    expect(second.model.getSnapshot().selectedTargetId).toBe("page-b");
    browser.sockets[1]!.close();
    second.controller.setPaused(true);
    expect(second.model.getSnapshot().status).toBe("disconnected");
    expect(
      browser.sockets
        .flatMap((s) => s.commands)
        .some((c) =>
          ["Browser.close", "Target.closeTarget"].includes(c.method),
        ),
    ).toBe(false);
  });
});
