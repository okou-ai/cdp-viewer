import { afterEach, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";
import type { FakeSocket } from "./wire";

const controllers: ViewerController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.close());
  vi.useRealTimers();
});

function reads(socket: FakeSocket) {
  return socket.commands.filter((command) =>
    String(command.params?.expression).startsWith("/* cdp-viewer favicon */"),
  );
}

async function mount(
  browser: FakeBrowser,
  transport: "shared" | "split" = "shared",
) {
  const model = createViewerModel();
  const controller = new ViewerController(
    model,
    {
      push: (_data, paint) => paint({ width: 800, height: 600 }),
      reset() {},
      invalidate() {},
      dispose() {},
    },
    {
      url: "wss://fixture.invalid/",
      socketFactory: browser.factory,
      interactive: true,
      transport,
    },
  );
  controllers.push(controller);
  controller.start();
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  const socket = browser.sockets[0]!;
  await vi.waitFor(() => expect(reads(socket)).toHaveLength(1));
  return { model, controller, socket, sessionId: reads(socket)[0]!.sessionId! };
}

it.each(["shared", "split"] as const)(
  "keeps %s favicon work off input and bounds it independently of tabs and frames",
  async (transport) => {
    const browser = new FakeBrowser();
    browser.targets.push(
      ...Array.from({ length: 500 }, (_, index) => ({
        id: `background-${String(index)}`,
        title: "Background",
        windowId: 2,
      })),
    );
    browser.holdFavicon = true;
    const { controller, model, socket } = await mount(browser, transport);
    expect(controller.input).not.toBeNull();
    controller.input!.focus();
    controller.input!.text("still responsive");
    await vi.waitFor(() =>
      expect(
        socket.commands.some(
          (command) => command.method === "Input.insertText",
        ),
      ).toBe(true),
    );
    const frames = browser.sockets.at(-1)!;
    const frameSession = frames.commands.find(
      (command) => command.method === "Page.startScreencast",
    )!.sessionId!;
    for (let index = 0; index < 30; index++) {
      browser.frame(frames, frameSession, index);
      socket.emit("Target.targetInfoChanged", {});
    }
    await vi.waitFor(() =>
      expect(model.getSnapshot().targets).toHaveLength(502),
    );
    expect(reads(socket)).toHaveLength(1);
    expect(browser.heldCommands).toHaveLength(1);
    expect(browser.sockets).toHaveLength(transport === "split" ? 2 : 1);
    expect(
      browser.sockets
        .flatMap((wire) => wire.commands)
        .filter((command) => command.method === "Target.attachToTarget"),
    ).toHaveLength(transport === "split" ? 2 : 1);
    if (transport === "split") expect(reads(frames)).toHaveLength(0);
  },
);

it("coalesces navigation/readiness and releases stale handles through the original session", async () => {
  const browser = new FakeBrowser();
  browser.holdFavicon = true;
  const { model, socket, sessionId } = await mount(browser);
  const first = browser.heldCommands.shift()!;
  for (let index = 0; index < 10; index++) {
    socket.emit("Page.frameNavigated", { frame: { id: "main" } }, sessionId);
    socket.emit("Page.domContentEventFired", {}, sessionId);
  }
  expect(reads(socket)).toHaveLength(1);
  first.socket.reply(first.command, {
    result: {
      type: "string",
      value: "https://old.invalid/icon.svg",
      objectId: "old-object",
    },
    exceptionDetails: { exception: { objectId: "exception-object" } },
  });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  expect(model.read(model.favicons$).size).toBe(0);
  expect(
    socket.commands
      .filter((command) => command.method === "Runtime.releaseObject")
      .map((command) => ({
        sessionId: command.sessionId,
        objectId: command.params?.objectId,
      })),
  ).toEqual([
    { sessionId, objectId: "old-object" },
    { sessionId, objectId: "exception-object" },
  ]);
  const current = browser.heldCommands.shift()!;
  current.socket.reply(current.command, {
    result: { type: "string", value: "https://new.invalid/icon.svg" },
  });
  await vi.waitFor(() =>
    expect(model.read(model.favicons$).get("page-a")?.url).toBe(
      "https://new.invalid/icon.svg",
    ),
  );
  socket.emit("Page.domContentEventFired", {}, sessionId);
  expect(reads(socket)).toHaveLength(2);
  socket.emit(
    "Page.frameNavigated",
    { frame: { id: "child", parentId: "main" } },
    sessionId,
  );
  expect(model.read(model.favicons$).size).toBe(1);
  socket.emit("Page.frameNavigated", { frame: { id: "main" } }, sessionId);
  expect(model.read(model.favicons$).size).toBe(0);
});

it("waits for document readiness without polling and treats failure as optional", async () => {
  const browser = new FakeBrowser();
  browser.favicon = false;
  const { model, socket, sessionId } = await mount(browser);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(0));
  socket.emit("Target.targetInfoChanged", {});
  expect(reads(socket)).toHaveLength(1);
  browser.holdFavicon = true;
  socket.emit("Page.domContentEventFired", {}, sessionId);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  const held = browser.heldCommands.shift()!;
  model.run(model.setFavicon$, {
    targetId: "page-a",
    url: "https://cached.invalid/icon.svg",
  });
  held.socket.reject(held.command);
  await vi.waitFor(() => expect(model.read(model.favicons$).size).toBe(0));
  await vi.waitFor(() =>
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      error: null,
    }),
  );
  socket.emit("Page.domContentEventFired", {}, sessionId);
  socket.emit("Target.targetInfoChanged", {});
  socket.emit("Page.frameNavigated", { frame: { id: "main" } }, sessionId);
  socket.emit("Page.domContentEventFired", {}, sessionId);
  expect(reads(socket)).toHaveLength(2);
  expect(model.read(model.favicons$).size).toBe(0);
});

it("stops optional reads after timeout and releases a late result without consuming more request slots", async () => {
  vi.useFakeTimers();
  const browser = new FakeBrowser();
  browser.holdFavicon = true;
  const { model, socket, sessionId } = await mount(browser);
  const old = browser.heldCommands.shift()!;
  await vi.advanceTimersByTimeAsync(10_000);
  for (let index = 0; index < 5; index++) {
    socket.emit("Page.frameNavigated", { frame: { id: "main" } }, sessionId);
    socket.emit("Page.domContentEventFired", {}, sessionId);
  }
  expect(reads(socket)).toHaveLength(1);
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    error: null,
  });
  socket.reply(old.command, {
    result: { type: "object", objectId: "late-object" },
  });
  await vi.waitFor(() =>
    expect(
      socket.commands.some(
        (command) =>
          command.method === "Runtime.releaseObject" &&
          command.sessionId === sessionId &&
          command.params?.objectId === "late-object",
      ),
    ).toBe(true),
  );
  expect(model.read(model.favicons$).size).toBe(0);
});

it("keeps a replacement selection responsive while one old metadata read is pending", async () => {
  const browser = new FakeBrowser();
  browser.holdFavicon = true;
  const { model, controller, socket } = await mount(browser);
  const old = browser.heldCommands.shift()!;
  controller.select("page-b");
  await vi.waitFor(() =>
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "page-b",
    }),
  );
  expect(reads(socket)).toHaveLength(1);
  expect(browser.heldCommands).toHaveLength(0);
  old.socket.reply(old.command, {
    result: { type: "string", value: "https://old.invalid/icon.svg" },
  });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  expect(model.read(model.favicons$).size).toBe(0);
  const current = browser.heldCommands.shift()!;
  expect(current.command.sessionId).not.toBe(old.command.sessionId);
  current.socket.reply(current.command, {
    result: { type: "string", value: "https://new.invalid/icon.svg" },
  });
  await vi.waitFor(() =>
    expect(model.read(model.favicons$).get("page-b")?.url).toBe(
      "https://new.invalid/icon.svg",
    ),
  );
});

it.each(["selection", "navigation"] as const)(
  "does not disable a new %s after the old session rejects its metadata read",
  async (replacement) => {
    const browser = new FakeBrowser();
    browser.holdFavicon = true;
    const { model, controller, socket, sessionId } = await mount(browser);
    const old = browser.heldCommands.shift()!;
    const targetId = replacement === "selection" ? "page-b" : "page-a";
    if (replacement === "selection") {
      controller.select(targetId);
      await vi.waitFor(() =>
        expect(model.getSnapshot()).toMatchObject({
          status: "streaming",
          selectedTargetId: targetId,
        }),
      );
    } else {
      socket.emit("Page.frameNavigated", { frame: { id: "main" } }, sessionId);
      socket.emit("Page.domContentEventFired", {}, sessionId);
    }
    expect(reads(socket)).toHaveLength(1);
    expect(browser.heldCommands).toHaveLength(0);
    // The old execution context/session can disappear during navigation or
    // detach. A definitive error reply has already retired its request slot.
    old.socket.reject(old.command, -32000);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const current = browser.heldCommands.shift()!;
    current.socket.reply(current.command, {
      result: { type: "string", value: "https://current.invalid/icon.svg" },
    });
    await vi.waitFor(() =>
      expect(model.read(model.favicons$).get(targetId)?.url).toBe(
        "https://current.invalid/icon.svg",
      ),
    );
    expect(reads(socket)).toHaveLength(2);
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      error: null,
    });
  },
);

it("does not retry a rejected document and admits the next document after a definitive failure", async () => {
  const browser = new FakeBrowser();
  browser.holdFavicon = true;
  const { model, socket, sessionId } = await mount(browser);
  const old = browser.heldCommands.shift()!;
  model.run(model.setFavicon$, {
    targetId: "page-a",
    url: "https://cached.invalid/icon.svg",
  });
  old.socket.reject(old.command, -32000);
  await vi.waitFor(() => expect(model.read(model.favicons$).size).toBe(0));
  socket.emit("Page.domContentEventFired", {}, sessionId);
  socket.emit("Target.targetInfoChanged", {});
  expect(reads(socket)).toHaveLength(1);
  socket.emit("Page.frameNavigated", { frame: { id: "main" } }, sessionId);
  socket.emit("Page.domContentEventFired", {}, sessionId);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  const current = browser.heldCommands.shift()!;
  current.socket.reply(current.command, {
    result: { type: "string", value: "https://current.invalid/icon.svg" },
  });
  await vi.waitFor(() =>
    expect(model.read(model.favicons$).get("page-a")?.url).toBe(
      "https://current.invalid/icon.svg",
    ),
  );
  expect(reads(socket)).toHaveLength(2);
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    error: null,
  });
});

it("refreshes a restored document without waiting for an event that will not fire again", async () => {
  const browser = new FakeBrowser();
  browser.favicon = "https://fixture.invalid/old.svg";
  const { model, socket, sessionId } = await mount(browser);
  await vi.waitFor(() => expect(model.read(model.favicons$).size).toBe(1));
  browser.favicon = "https://fixture.invalid/restored.svg";
  socket.emit(
    "Page.frameNavigated",
    { frame: { id: "main" }, type: "BackForwardCacheRestore" },
    sessionId,
  );
  expect(model.read(model.favicons$).size).toBe(0);
  await vi.waitFor(() =>
    expect(model.read(model.favicons$).get("page-a")?.url).toBe(
      "https://fixture.invalid/restored.svg",
    ),
  );
  expect(reads(socket)).toHaveLength(2);
});

it.each(["selection", "pause", "disconnect", "close"])(
  "ignores a favicon result after %s ownership loss",
  async (loss) => {
    const browser = new FakeBrowser();
    browser.holdFavicon = true;
    const { model, controller, socket } = await mount(browser);
    const old = browser.heldCommands.shift()!;
    if (loss === "selection") controller.select("page-b");
    else if (loss === "pause") controller.setPaused(true);
    else if (loss === "disconnect") socket.close();
    else controller.close();
    old.socket.reply(old.command, {
      result: { type: "string", value: "https://stale.invalid/icon.svg" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(model.read(model.favicons$).size).toBe(0);
  },
);

it.each([
  null,
  "javascript:alert(1)",
  "file:///icon.png",
  "https://example.invalid/" + "x".repeat(8192),
  { url: "https://invalid.invalid/" },
])(
  "ignores unusable favicon metadata without affecting viewing: %j",
  async (value) => {
    const browser = new FakeBrowser();
    browser.favicon = value;
    const { model, socket } = await mount(browser);
    expect(model.read(model.favicons$).size).toBe(0);
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      error: null,
    });
    expect(reads(socket)).toHaveLength(1);
  },
);

it("keeps URL outcomes private, cached, instance-owned and pruned to current scope", () => {
  const model = createViewerModel();
  const sibling = createViewerModel();
  model.update({ targets: [{ id: "page-a", title: "A" }] });
  const notify = vi.fn();
  model.subscribe(notify);
  const set = () =>
    model.run(model.setFavicon$, {
      targetId: "page-a",
      url: "https://fixture.invalid/icon.svg",
    });
  set();
  const old = model.read(model.favicons$).get("page-a")!;
  set();
  expect(model.read(model.favicons$).get("page-a")).toBe(old);
  model.run(model.rejectFavicon$, { targetId: "page-a", icon: old });
  set();
  expect(model.read(model.favicons$).get("page-a")?.failed).toBe(true);
  model.run(model.setFavicon$, { targetId: "page-a", url: null });
  set();
  model.run(model.rejectFavicon$, { targetId: "page-a", icon: old });
  expect(model.read(model.favicons$).get("page-a")?.failed).toBe(false);
  expect(sibling.read(sibling.favicons$).size).toBe(0);
  expect(notify).not.toHaveBeenCalled();
  expect(JSON.stringify(model.getSnapshot())).not.toContain("fixture.invalid");
  model.update({ targets: [] });
  expect(model.read(model.favicons$).size).toBe(0);
  model.run(model.setFavicon$, {
    targetId: "page-a",
    url: "https://late.invalid/icon.svg",
  });
  expect(model.read(model.favicons$).size).toBe(0);
});
