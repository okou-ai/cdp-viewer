import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpEvent } from "../../src/cdp/client";
import { browserUse } from "../../src/extensions/browser-use";
import { ExtensionRuntime } from "../../src/extensions/runtime";
import type {
  ExtensionCleanup,
  ExtensionContext,
  ViewerExtension,
} from "../../src/extensions/types";
import { ViewerController } from "../../src/viewer/controller";
import type { FrameSink } from "../../src/render/canvas";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).forEach((close) => close()));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function runtime() {
  const connection = new AbortController();
  const listeners = new Set<(event: CdpEvent) => void>();
  const reportError = vi.fn();
  const select = vi.fn(async (_id: string, current: () => boolean) =>
    current(),
  );
  const extensions = new ExtensionRuntime({
    signal: connection.signal,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () =>
      Object.freeze({
        status: "streaming",
        selectedTargetId: "page-a",
        capabilities: Object.freeze({
          windowScoped: false,
          interactive: false,
        }),
      }),
    requestTargetSelection: select,
    reportError,
  });
  resources.push(() => connection.abort());
  return {
    connection,
    extensions,
    listeners,
    reportError,
    select,
    emit: () => {
      for (const listener of listeners)
        listener({ method: "Vendor.changed", params: {} });
    },
  };
}

function mount(
  browser: FakeBrowser,
  windowId?: number,
  adapters = [browserUse()],
) {
  const model = createViewerModel();
  const sink: FrameSink = {
    push: vi.fn((_data: string, paint: () => void) => paint()),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
  const results: boolean[] = [];
  const controller = new ViewerController(model, sink, {
    url: "wss://fixture.invalid/?token=private-endpoint",
    socketFactory: browser.factory,
    ...(windowId === undefined ? {} : { windowId }),
  });
  resources.push(() => controller.close());
  controller.setExtensions(
    adapters.map((adapter) => ({
      ...adapter,
      setup: (context) =>
        adapter.setup({
          ...context,
          requestTargetSelection: async (targetId) => {
            const accepted = await context.requestTargetSelection(targetId);
            results.push(accepted);
            return accepted;
          },
        }),
    })),
  );
  controller.start();
  return { controller, model, sink, results };
}

async function streaming(viewer: ReturnType<typeof mount>, target = "page-a") {
  await vi.waitFor(() =>
    expect(viewer.model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: target,
    }),
  );
}

describe("extension ownership", () => {
  it("keeps reused descriptors independent and releases only the removed owner", async () => {
    const owners: ExtensionContext[] = [];
    const counts: number[] = [];
    const cleanup = vi.fn();
    const descriptor: ViewerExtension = {
      id: "shared",
      setup: (context) => {
        owners.push(context);
        let count = 0;
        context.subscribe("Vendor.changed", () => {
          counts.push(++count);
        });
        return cleanup;
      },
    };
    const a = runtime();
    const b = runtime();
    a.extensions.reconcile([descriptor]);
    b.extensions.reconcile([descriptor]);
    await vi.waitFor(() => expect(owners).toHaveLength(2));
    a.emit();
    b.emit();
    expect(counts).toEqual([1, 1]);
    a.extensions.reconcile([]);
    expect(owners[0]!.signal.aborted).toBe(true);
    expect(owners[1]!.signal.aborted).toBe(false);
    expect(a.listeners.size).toBe(0);
    a.emit();
    b.emit();
    expect(counts).toEqual([1, 1, 2]);
    expect(await owners[0]!.requestTargetSelection("page-b")).toBe(false);
    expect(owners[0]!.getState().status).toBe("disconnected");
    owners[0]!.subscribe("Vendor.changed", () => {});
    expect(a.listeners.size).toBe(0);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    b.connection.abort();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
  });

  it("reconciles by id/key, retaining setup across equivalent closures and order changes", async () => {
    const owner = runtime();
    const first = vi.fn<ViewerExtension["setup"]>();
    const second = vi.fn<ViewerExtension["setup"]>();
    const replacement = vi.fn();
    owner.extensions.reconcile([
      { id: "one", setup: first },
      { id: "two", setup: second },
    ]);
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    owner.extensions.reconcile([
      { id: "two", setup: replacement },
      { id: "one", setup: replacement },
    ]);
    await Promise.resolve();
    expect(replacement).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    owner.extensions.reconcile([
      { id: "one", key: "changed", setup: replacement },
    ]);
    await vi.waitFor(() => expect(replacement).toHaveBeenCalledOnce());
    expect(first.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(second.mock.calls[0]![0].signal.aborted).toBe(true);
  });

  it("rejects duplicate or invalid configurations atomically and deduplicates errors", async () => {
    const owner = runtime();
    const setup = vi.fn<ViewerExtension["setup"]>();
    owner.extensions.reconcile([{ id: "valid", setup }]);
    await vi.waitFor(() => expect(setup).toHaveBeenCalledOnce());
    const bad = [
      { id: "duplicate", setup },
      { id: "duplicate", setup },
    ];
    owner.extensions.reconcile(bad);
    owner.extensions.reconcile([...bad]);
    expect(owner.reportError).toHaveBeenCalledOnce();
    expect(setup.mock.calls[0]![0].signal.aborted).toBe(false);
    owner.extensions.reconcile([{ id: "", setup }]);
    expect(owner.reportError).toHaveBeenCalledTimes(2);
    expect(setup).toHaveBeenCalledOnce();
    owner.extensions.reconcile([{ id: "valid", setup }]);
    expect(setup).toHaveBeenCalledOnce();
    const empty = runtime();
    empty.extensions.reconcile(bad);
    await Promise.resolve();
    expect(empty.listeners.size).toBe(0);
    expect(setup).toHaveBeenCalledOnce();
  });

  it("waits for late setup and async cleanup, skips superseded setups and starts unrelated IDs", async () => {
    const owner = runtime();
    const setupResult = deferred<void | ExtensionCleanup>();
    const cleanupResult = deferred<void>();
    const cleanup = vi.fn(() => cleanupResult.promise);
    const initial = vi.fn((_context: ExtensionContext) => setupResult.promise);
    const skipped = vi.fn();
    const latest = vi.fn();
    const sibling = vi.fn();
    owner.extensions.reconcile([{ id: "async", setup: initial }]);
    await vi.waitFor(() => expect(initial).toHaveBeenCalledOnce());
    owner.extensions.reconcile([{ id: "async", key: "1", setup: skipped }]);
    owner.extensions.reconcile([
      { id: "async", key: "2", setup: latest },
      { id: "other", setup: sibling },
    ]);
    expect(initial.mock.calls[0]![0].signal.aborted).toBe(true);
    await vi.waitFor(() => expect(sibling).toHaveBeenCalledOnce());
    expect(latest).not.toHaveBeenCalled();
    setupResult.resolve(cleanup);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(latest).not.toHaveBeenCalled();
    cleanupResult.resolve();
    await vi.waitFor(() => expect(latest).toHaveBeenCalledOnce());
    expect(skipped).not.toHaveBeenCalled();
    expect(owner.reportError).not.toHaveBeenCalled();
  });

  it.each([
    "sync setup",
    "async setup",
    "sync event",
    "async event",
    "sync cleanup",
    "async cleanup",
  ])(
    "contains %s failure without leaking payloads or breaking another adapter",
    async (failure) => {
      const owner = runtime();
      const other = vi.fn();
      let failed!: ExtensionContext;
      owner.extensions.reconcile([
        {
          id: "fault",
          setup: (context) => {
            failed = context;
            context.subscribe("Vendor.changed", () => {
              if (failure === "sync event")
                throw new Error("private provider payload");
              if (failure === "async event")
                return Promise.reject(new Error("private provider payload"));
            });
            if (failure === "sync setup")
              throw new Error("private provider payload");
            if (failure === "async setup")
              return Promise.reject(new Error("private provider payload"));
            return () => {
              if (failure === "sync cleanup")
                throw new Error("private provider payload");
              if (failure === "async cleanup")
                return Promise.reject(new Error("private provider payload"));
            };
          },
        },
        {
          id: "other",
          setup: (context) => context.subscribe("Vendor.changed", other),
        },
      ]);
      await vi.waitFor(() => expect(failed).toBeDefined());
      owner.emit();
      if (failure.endsWith("cleanup"))
        owner.extensions.reconcile([{ id: "other", setup: () => {} }]);
      await vi.waitFor(() => expect(owner.reportError).toHaveBeenCalledOnce());
      expect(failed.signal.aborted).toBe(true);
      expect(JSON.stringify(owner.reportError.mock.calls)).not.toContain(
        "private",
      );
      owner.emit();
      expect(other).toHaveBeenCalledTimes(2);
      expect(owner.listeners.size).toBe(1);
      expect(owner.connection.signal.aborted).toBe(false);
    },
  );

  it("ignores late rejected event work after connection ownership ends", async () => {
    const owner = runtime();
    const result = deferred<void>();
    const entered = vi.fn(() => result.promise);
    owner.extensions.reconcile([
      {
        id: "late",
        setup: (context) => context.subscribe("Vendor.changed", entered),
      },
    ]);
    await vi.waitFor(() => expect(owner.listeners.size).toBe(1));
    owner.emit();
    expect(entered).toHaveBeenCalledOnce();
    owner.connection.abort();
    result.reject(new Error("private late rejection"));
    await result.promise.catch(() => {});
    await Promise.resolve();
    expect(owner.listeners.size).toBe(0);
    expect(owner.reportError).not.toHaveBeenCalled();
  });
});

describe("Browser Use target suggestions", () => {
  it("keeps ordinary viewing independent of optional or unknown vendor events", async () => {
    const browser = new FakeBrowser();
    const viewer = mount(browser, undefined, []);
    await streaming(viewer);
    const socket = browser.sockets[0]!;
    socket.emit("BrowserUse.activeTargetChanged", { targetId: "page-b" });
    socket.emit("Vendor.unknown", { targetId: "page-b" });
    expect(viewer.model.getSnapshot().selectedTargetId).toBe("page-a");
    expect(
      socket.commands.some(
        (command) => command.method === "Target.getTargetInfo",
      ),
    ).toBe(false);
  });

  it("follows valid in-scope activations and no-ops activation echoes", async () => {
    const browser = new FakeBrowser();
    browser.targets[1]!.windowId = 0;
    const viewer = mount(browser, 0);
    await streaming(viewer);
    const socket = browser.sockets[0]!;
    socket.emit("BrowserUse.activeTargetChanged", { targetId: "page-b" });
    await streaming(viewer, "page-b");
    const commands = socket.commands.length;
    for (let index = 0; index < 3; index++)
      socket.emit("BrowserUse.activeTargetChanged", { targetId: "page-b" });
    expect(socket.commands).toHaveLength(commands);
    expect(
      socket.commands.filter(
        (command) => command.method === "Target.attachToTarget",
      ),
    ).toHaveLength(2);
    expect(
      socket.commands.some(
        (command) =>
          command.method === "Browser.getWindowForTarget" &&
          command.params?.targetId === "page-b",
      ),
    ).toBe(true);
  });

  it("ignores foreign, missing, malformed and session-level activation events", async () => {
    const browser = new FakeBrowser();
    const viewer = mount(browser, 0);
    await streaming(viewer);
    const socket = browser.sockets[0]!;
    const count = socket.commands.length;
    for (const params of [
      {},
      { targetId: "" },
      { targetId: " " },
      { targetId: null },
      { targetId: 7 },
      { targetId: "missing" },
      { targetId: "page-b" },
    ])
      socket.emit("BrowserUse.activeTargetChanged", params);
    socket.emit(
      "BrowserUse.activeTargetChanged",
      { targetId: "page-b" },
      "old-session",
    );
    expect(viewer.model.getSnapshot().selectedTargetId).toBe("page-a");
    expect(socket.commands).toHaveLength(count);
  });

  it.each(["missing", "moved", "unsupported scope"])(
    "retains the current stream when a listed suggestion becomes %s",
    async (reason) => {
      const browser = new FakeBrowser();
      browser.targets[1]!.windowId = 0;
      const viewer = mount(browser, 0);
      await streaming(viewer);
      const socket = browser.sockets[0]!;
      if (reason === "missing") browser.targets.pop();
      if (reason === "moved") browser.targets[1]!.windowId = 2;
      if (reason === "unsupported scope") browser.unsupportedWindows = true;
      socket.emit("BrowserUse.activeTargetChanged", { targetId: "page-b" });
      await vi.waitFor(() =>
        expect(
          socket.commands.some(
            (command) => command.method === "Target.getTargetInfo",
          ),
        ).toBe(true),
      );
      await vi.waitFor(() => expect(viewer.results).toEqual([false]));
      await streaming(viewer);
      expect(
        socket.commands.filter(
          (command) => command.method === "Target.attachToTarget",
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["wrong ID", "worker", "prerender"])(
    "rejects %s live target metadata before selection",
    async (kind) => {
      const browser = new FakeBrowser();
      const viewer = mount(browser);
      await streaming(viewer);
      browser.holdMethod = "Target.getTargetInfo";
      const socket = browser.sockets[0]!;
      socket.emit("BrowserUse.activeTargetChanged", { targetId: "page-b" });
      await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
      const held = browser.heldCommands[0]!;
      held.socket.reply(held.command, {
        targetInfo: {
          targetId: kind === "wrong ID" ? "other" : "page-b",
          type: kind === "worker" ? "worker" : "page",
          ...(kind === "prerender" ? { subtype: "prerender" } : {}),
        },
      });
      await vi.waitFor(() => expect(viewer.results).toEqual([false]));
      expect(viewer.model.getSnapshot().selectedTargetId).toBe("page-a");
    },
  );

  it("keeps the latest observed suggestion when validations complete out of order", async () => {
    const browser = new FakeBrowser();
    browser.targets.push({ id: "page-c", windowId: 0, title: "Page C" });
    const viewer = mount(browser);
    await streaming(viewer);
    browser.holdMethod = "Target.getTargetInfo";
    const socket = browser.sockets[0]!;
    socket.emit("BrowserUse.activeTargetChanged", { targetId: "page-b" });
    socket.emit("BrowserUse.activeTargetChanged", { targetId: "page-c" });
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
    const [first, last] = browser.heldCommands;
    last!.socket.reply(last!.command, {
      targetInfo: { targetId: "page-c", type: "page" },
    });
    await streaming(viewer, "page-c");
    first!.socket.reply(first!.command, {
      targetInfo: { targetId: "page-b", type: "page" },
    });
    await vi.waitFor(() => expect(viewer.results).toEqual([true, false]));
    expect(viewer.model.getSnapshot().selectedTargetId).toBe("page-c");
  });

  it.each(["user selection", "remove", "disconnect", "target event"])(
    "rejects pending work after %s",
    async (change) => {
      const browser = new FakeBrowser();
      browser.targets[1]!.windowId = 0;
      browser.targets.push({ id: "page-c", windowId: 0, title: "Page C" });
      const viewer = mount(browser, 0);
      await streaming(viewer);
      browser.holdMethod = "Browser.getWindowForTarget";
      const socket = browser.sockets[0]!;
      socket.emit("BrowserUse.activeTargetChanged", { targetId: "page-b" });
      await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
      const held = browser.heldCommands[0]!;
      browser.holdMethod = null;
      if (change === "user selection") {
        viewer.controller.select("page-c");
        await streaming(viewer, "page-c");
      }
      if (change === "remove") viewer.controller.setExtensions([]);
      if (change === "disconnect") socket.close();
      if (change === "target event")
        socket.emit("Target.targetInfoChanged", {});
      held.socket.reply(held.command, { windowId: 0, bounds: {} });
      await vi.waitFor(() => expect(viewer.results).toEqual([false]));
      expect(viewer.model.getSnapshot().selectedTargetId).toBe(
        change === "user selection" ? "page-c" : "page-a",
      );
      expect(
        socket.commands.filter(
          (command) => command.method === "Target.attachToTarget",
        ),
      ).toHaveLength(change === "user selection" ? 2 : 1);
    },
  );
});
