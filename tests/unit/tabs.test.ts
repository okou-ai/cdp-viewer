import { afterEach, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";

const controllers: ViewerController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.close());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(
  browser: FakeBrowser,
  windowId?: number,
  interactive = true,
  requestTimeout?: number,
) {
  const model = createViewerModel();
  const controller = new ViewerController(
    model,
    {
      push: (_data, paint) => paint({ width: 800, height: 600 }),
      reset: vi.fn(),
      invalidate: vi.fn(),
      dispose: vi.fn(),
    },
    {
      url: "wss://fixture.invalid",
      socketFactory: browser.factory,
      interactive,
      ...(windowId === undefined ? {} : { windowId }),
      ...(requestTimeout === undefined ? {} : { requestTimeout }),
    },
  );
  controllers.push(controller);
  controller.start();
  await vi.waitFor(() =>
    expect(["streaming", "unavailable"]).toContain(model.getSnapshot().status),
  );
  return { controller, model, socket: browser.sockets.at(-1)! };
}

it("creates in window zero, selects the blank tab and releases only its temporary session", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  });
  const browser = new FakeBrowser();
  const { controller, model, socket } = await mount(browser, 0);
  controller.createTab();
  await vi.waitFor(() =>
    expect(model.getSnapshot().selectedTargetId).toBe("new-1"),
  );
  expect(
    browser.targets.find((target) => target.id === "new-1")?.windowId,
  ).toBe(0);
  expect(
    socket.commands
      .filter((command) => command.method === "Target.attachToTarget")
      .map((command) => command.params?.targetId),
  ).toEqual(["page-a", "new-1", "new-1"]);
  expect(
    socket.commands.some(
      (command) =>
        command.method === "Target.detachFromTarget" &&
        command.params?.sessionId === "session-2",
    ),
  ).toBe(true);
  controller.close();
  expect(browser.targets.some((target) => target.id === "new-1")).toBe(true);
  expect(
    socket.commands.some((command) => command.method === "Target.closeTarget"),
  ).toBe(false);
});

it("allows one pending mutation while keeping a later selection authoritative", async () => {
  const browser = new FakeBrowser();
  const { controller, model, socket } = await mount(browser);
  browser.holdMethod = "Page.createIsolatedWorld";
  controller.createTab();
  controller.createTab();
  controller.closeTab("page-b");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  expect(model.read(model.tabAction$)).toEqual({ type: "create" });
  controller.select("page-b");
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, { executionContextId: 42 });
  await vi.waitFor(() => expect(model.read(model.tabAction$)).toBeNull());
  expect(model.getSnapshot().selectedTargetId).toBe("page-b");
  expect(model.getSnapshot().error).toBeNull();
  expect(
    socket.commands.some((command) => command.method === "Target.closeTarget"),
  ).toBe(false);
  expect(browser.targets).toHaveLength(2);
});

it("creates a verified tab despite an unrelated window lookup failure", async () => {
  const browser = new FakeBrowser();
  const { controller, model, socket } = await mount(browser, 0);
  browser.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === "page-b";
  controller.createTab();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  const failed = browser.heldCommands.shift()!;
  failed.socket.reject(failed.command, -32000);
  await vi.waitFor(() => expect(model.read(model.tabAction$)).toBeNull());
  expect(model.getSnapshot()).toMatchObject({
    selectedTargetId: "new-1",
    error: null,
  });
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  expect(
    socket.commands
      .filter((command) => command.method === "Target.attachToTarget")
      .map((command) => command.params?.targetId),
  ).not.toContain("page-b");
});

it("reports a blocked popup without losing the live selection or retrying", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = await mount(browser);
  browser.blockOpen = true;
  controller.createTab();
  await vi.waitFor(() => expect(model.getSnapshot().error?.kind).toBe("tab"));
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    selectedTargetId: "page-a",
  });
  expect(browser.targets).toHaveLength(2);
});

it("cancels a pending creation when its remote document is replaced", async () => {
  const browser = new FakeBrowser();
  const { controller, model, socket } = await mount(browser);
  browser.holdMethod = "Page.createIsolatedWorld";
  controller.createTab();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  socket.emit(
    "Page.frameNavigated",
    { frame: { id: "replacement" } },
    "session-1",
  );
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, { executionContextId: 42 });
  await vi.waitFor(() => expect(model.read(model.tabAction$)).toBeNull());
  expect(browser.targets).toHaveLength(2);
  expect(model.getSnapshot().error).toBeNull();
});

it("isolates concurrent viewer mutations and discards a disposed controller's late work", async () => {
  const browser = new FakeBrowser();
  const first = await mount(browser, 0);
  const second = await mount(browser, 2);
  browser.holdMethod = "Page.createIsolatedWorld";
  first.controller.createTab();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  expect(second.model.read(second.model.tabAction$)).toBeNull();
  browser.holdMethod = null;
  second.controller.createTab();
  await vi.waitFor(() =>
    expect(second.model.getSnapshot().selectedTargetId).toBe("new-1"),
  );
  expect(
    browser.targets.find((target) => target.id === "new-1")?.windowId,
  ).toBe(2);
  first.controller.close();
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, { executionContextId: 42 });
  expect(second.model.getSnapshot().selectedTargetId).toBe("new-1");
  expect(browser.targets).toHaveLength(3);
});

it("freshly rejects a source moved outside configured scope before opening", async () => {
  const browser = new FakeBrowser();
  const { controller, model, socket } = await mount(browser, 0);
  browser.targets[0]!.windowId = 2;
  controller.createTab();
  await vi.waitFor(() => expect(model.getSnapshot().error?.kind).toBe("scope"));
  expect(
    socket.commands.some(
      (command) => command.method === "Page.createIsolatedWorld",
    ),
  ).toBe(false);
});

it("closes an inactive tab without replacing the active session, then closes the last tab", async () => {
  const browser = new FakeBrowser();
  const { controller, model, socket } = await mount(browser);
  const attaches = socket.commands.filter(
    (command) => command.method === "Target.attachToTarget",
  ).length;
  controller.closeTab("page-b");
  await vi.waitFor(() => expect(model.getSnapshot().targets).toHaveLength(1));
  expect(model.getSnapshot().selectedTargetId).toBe("page-a");
  expect(
    socket.commands.filter(
      (command) => command.method === "Target.attachToTarget",
    ),
  ).toHaveLength(attaches);
  await vi.waitFor(() => expect(model.read(model.tabAction$)).toBeNull());
  controller.closeTab("page-a");
  await vi.waitFor(() =>
    expect(model.getSnapshot()).toMatchObject({
      targets: [],
      selectedTargetId: null,
      status: "unavailable",
    }),
  );
  await vi.waitFor(() => expect(model.read(model.tabAction$)).toBeNull());
  controller.createTab();
  await vi.waitFor(() =>
    expect(model.getSnapshot().selectedTargetId).toBe("new-1"),
  );
  expect(
    socket.commands.some((command) => command.method.startsWith("Browser.")),
  ).toBe(false);
});

it("does not open a tab after its source moves during isolated-world creation", async () => {
  const browser = new FakeBrowser();
  const { controller, model, socket } = await mount(browser, 0);
  browser.holdMethod = "Page.createIsolatedWorld";
  controller.createTab();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  browser.targets[0]!.windowId = 2;
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, { executionContextId: 42 });
  await vi.waitFor(() => expect(model.read(model.tabAction$)).toBeNull());
  expect(browser.targets).toHaveLength(2);
  expect(
    socket.commands.some(
      (command) =>
        command.method === "Runtime.evaluate" &&
        String(command.params?.expression).includes("const tab = window.open("),
    ),
  ).toBe(false);
});

it("selects a neighbour after explicit active close while external close stays unavailable", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = await mount(browser);
  controller.closeTab("page-a");
  await vi.waitFor(() =>
    expect(model.getSnapshot()).toMatchObject({
      selectedTargetId: "page-b",
      status: "streaming",
    }),
  );
  browser.targets = [];
  browser.sockets[0]!.emit("Target.targetDestroyed", { targetId: "page-b" });
  await vi.waitFor(() =>
    expect(model.getSnapshot()).toMatchObject({
      selectedTargetId: null,
      status: "unavailable",
    }),
  );
});

it("does not overwrite a user selection made while active close was pending", async () => {
  const browser = new FakeBrowser();
  browser.targets.push({ id: "page-c", windowId: 0, title: "C" });
  const { controller, model } = await mount(browser);
  browser.holdMethod = "Target.closeTarget";
  controller.closeTab("page-a");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  browser.targets.push({ id: "page-d", windowId: 0, title: "New discovery" });
  browser.sockets[0]!.emit("Target.targetCreated", {});
  await vi.waitFor(() => expect(model.getSnapshot().targets).toHaveLength(4));
  controller.select("page-c");
  browser.targets = browser.targets.filter((target) => target.id !== "page-a");
  const held = browser.heldCommands[0]!;
  held.socket.emit("Target.targetDestroyed", { targetId: "page-a" });
  held.socket.reply(held.command, { success: true });
  await vi.waitFor(() => expect(model.read(model.tabAction$)).toBeNull());
  expect(model.getSnapshot().selectedTargetId).toBe("page-c");
  expect(
    model.getSnapshot().targets.some((target) => target.id === "page-d"),
  ).toBe(true);
});

it.each(["a preceding tab closes", "a new following tab appears"])(
  "keeps the close neighbour when %s",
  async (change) => {
    const browser = new FakeBrowser();
    browser.targets.push(
      { id: "page-c", windowId: 0, title: "C" },
      { id: "page-d", windowId: 0, title: "D" },
    );
    const { controller, model, socket } = await mount(browser);
    const closing = change === "a preceding tab closes" ? "page-b" : "page-d";
    controller.select(closing);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    browser.holdMethod = "Target.closeTarget";
    controller.closeTab(closing);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    if (change === "a preceding tab closes") {
      browser.targets = browser.targets.filter(
        (target) => target.id !== "page-a",
      );
      socket.emit("Target.targetDestroyed", { targetId: "page-a" });
    } else {
      browser.targets.push({ id: "page-e", windowId: 0, title: "E" });
      socket.emit("Target.targetCreated", {});
    }
    await vi.waitFor(() =>
      expect(model.getSnapshot().targets.map((target) => target.id)).toEqual(
        browser.targets.map((target) => target.id),
      ),
    );
    browser.targets = browser.targets.filter((target) => target.id !== closing);
    socket.emit("Target.targetDestroyed", { targetId: closing });
    await vi.waitFor(() =>
      expect(
        model.getSnapshot().targets.map((target) => target.id),
      ).not.toContain(closing),
    );
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command, { success: true });
    await vi.waitFor(() => expect(model.read(model.tabAction$)).toBeNull());
    await vi.waitFor(() =>
      expect(model.getSnapshot()).toMatchObject({
        selectedTargetId:
          change === "a preceding tab closes" ? "page-c" : "page-e",
        status: "streaming",
      }),
    );
  },
);

it("rejects unlisted, moved and view-only closes without remote mutations", async () => {
  const browser = new FakeBrowser();
  const first = await mount(browser, 0);
  first.controller.closeTab("page-b");
  browser.targets[0]!.windowId = 2;
  first.controller.closeTab("page-a");
  await vi.waitFor(() =>
    expect(first.model.getSnapshot().error?.kind).toBe("scope"),
  );
  const other = await mount(browser, 2, false);
  other.controller.closeTab("page-a");
  other.controller.createTab();
  expect(
    browser.sockets
      .flatMap((socket) => socket.commands)
      .some((command) =>
        [
          "Target.closeTarget",
          "Target.createTarget",
          "Page.createIsolatedWorld",
        ].includes(command.method),
      ),
  ).toBe(false);
});

it("cannot create outside a vanished configured window", async () => {
  const browser = new FakeBrowser();
  browser.targets = [];
  const { controller, model, socket } = await mount(browser, 0);
  controller.createTab();
  expect(model.getSnapshot().targets).toEqual([]);
  expect(
    socket.commands.some((command) => command.method === "Target.createTarget"),
  ).toBe(false);
});

it("does not treat failed discovery as a known empty browser", async () => {
  const browser = new FakeBrowser();
  const { controller, model, socket } = await mount(browser);
  browser.holdMethod = "Target.getTargets";
  socket.emit("Target.targetInfoChanged", {});
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  const held = browser.heldCommands[0]!;
  held.socket.reject(held.command);
  await vi.waitFor(() =>
    expect(model.getSnapshot().status).toBe("unavailable"),
  );
  controller.createTab();
  expect(
    socket.commands.some((command) => command.method === "Target.createTarget"),
  ).toBe(false);
});

it("rejects a created tab moved during temporary attach and detaches that session", async () => {
  const browser = new FakeBrowser();
  const { controller, model, socket } = await mount(browser, 0);
  browser.holdAttach = true;
  controller.createTab();
  await vi.waitFor(() => expect(browser.held).toHaveLength(1));
  browser.targets.find((target) => target.id === "new-1")!.windowId = 2;
  const held = browser.held[0]!;
  held.socket.reply(held.command, { sessionId: held.sessionId });
  await vi.waitFor(() => expect(model.getSnapshot().error?.kind).toBe("scope"));
  expect(model.getSnapshot().selectedTargetId).toBe("page-a");
  expect(
    socket.commands.some((command) => command.method === "Page.navigate"),
  ).toBe(false);
  expect(
    socket.commands.some(
      (command) =>
        command.method === "Target.detachFromTarget" &&
        command.params?.sessionId === held.sessionId,
    ),
  ).toBe(true);
});

it("releases unexpected evaluation and exception handles without exposing provider details", async () => {
  const browser = new FakeBrowser();
  const { controller, model, socket } = await mount(browser);
  browser.holdMethod = "Runtime.evaluate";
  controller.createTab();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, {
    result: { type: "object", objectId: "result-object" },
    exceptionDetails: {
      text: "provider secret",
      exception: { objectId: "exception-object" },
    },
  });
  await vi.waitFor(() => expect(model.getSnapshot().error?.kind).toBe("tab"));
  expect(
    socket.commands
      .filter((command) => command.method === "Runtime.releaseObject")
      .map((command) => [command.sessionId, command.params?.objectId]),
  ).toEqual([
    ["session-1", "result-object"],
    ["session-1", "exception-object"],
  ]);
  expect(JSON.stringify(model.getSnapshot())).not.toContain("provider secret");
});

it("detaches a temporary attach arriving after timeout through its original socket", async () => {
  const browser = new FakeBrowser();
  const { controller, model, socket } = await mount(
    browser,
    undefined,
    true,
    80,
  );
  browser.holdAttach = true;
  controller.createTab();
  await vi.waitFor(() => expect(browser.held).toHaveLength(1), { interval: 1 });
  const held = browser.held[0]!;
  await vi.waitFor(() => expect(model.read(model.tabAction$)).toBeNull());
  browser.holdAttach = false;
  controller.select("page-b");
  held.socket.reply(held.command, { sessionId: held.sessionId });
  await vi.waitFor(() =>
    expect(
      socket.commands.some(
        (command) =>
          command.method === "Target.detachFromTarget" &&
          command.params?.sessionId === held.sessionId,
      ),
    ).toBe(true),
  );
  expect(model.getSnapshot().selectedTargetId).toBe("page-b");
});
