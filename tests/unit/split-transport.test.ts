import { afterEach, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import type { CdpViewerProps } from "../../src/viewer/types";
import type { SocketFactory } from "../../src/cdp/client";
import { FakeBrowser } from "./wire";
import type { FakeSocket } from "./wire";

const controllers: ViewerController[] = [];
afterEach(() =>
  controllers.splice(0).forEach((controller) => controller.close()),
);

function mount(
  browser = new FakeBrowser(),
  options: {
    interactive?: boolean;
    transport?: CdpViewerProps["transport"];
    windowId?: number;
    socketFactory?: SocketFactory;
  } = {},
) {
  const model = createViewerModel();
  const sink = {
    push: vi.fn(
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
    url: "wss://fixture.invalid/",
    socketFactory: browser.factory,
    interactive: true,
    transport: "split",
    ...options,
  });
  controllers.push(controller);
  controller.start();
  return { controller, model, sink, browser };
}

const streaming = (model: ReturnType<typeof createViewerModel>) =>
  vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
const commands = (socket: FakeSocket, method: string) =>
  socket.commands.filter((command) => command.method === method);

it("closes a partial group when the second WebSocket cannot be constructed", async () => {
  const browser = new FakeBrowser();
  let created = 0;
  const { model } = mount(browser, {
    socketFactory: (url) => {
      if (created++ === 1) throw new Error("private provider payload");
      return browser.factory(url);
    },
  });
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("error"));
  expect(browser.sockets).toHaveLength(1);
  expect(browser.sockets[0]!.readyState).toBe(3);
  expect(JSON.stringify(model.getSnapshot().error)).not.toContain("private");
});

it("cannot finish startup after either socket closes during discovery", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Target.setDiscoverTargets";
  const { model, controller } = mount(browser);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  browser.sockets[1]!.close();
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command);
  await Promise.resolve();
  expect(controller.input).toBeNull();
  expect(model.getSnapshot()).toMatchObject({
    status: "error",
    error: { kind: "connection" },
  });
  expect(browser.sockets.every((socket) => socket.readyState === 3)).toBe(true);
  expect(commands(browser.sockets[0]!, "Target.getTargets")).toHaveLength(0);
});

it.each(["select", "pause"] as const)(
  "preserves terminal failure when a %s cleanup send closes the frame lane",
  async (action) => {
    const { browser, model, controller } = mount();
    await streaming(model);
    browser.sockets[1]!.bufferedAmount = 5 * 1024 * 1024;
    if (action === "select") controller.select("page-b");
    else controller.setPaused(true);
    expect(controller.input).toBeNull();
    expect(model.getSnapshot()).toMatchObject({
      status: "disconnected",
      error: { kind: "connection" },
    });
    await vi.waitFor(() =>
      expect(browser.sockets.every((socket) => socket.readyState === 3)).toBe(
        true,
      ),
    );
  },
);

it("preserves terminal frame failure during discovery-error cleanup", async () => {
  const { browser, model, controller } = mount();
  await streaming(model);
  const [control, frames] = browser.sockets as [FakeSocket, FakeSocket];
  browser.holdMethod = "Target.getTargets";
  control.emit("Target.targetInfoChanged", {});
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  frames.bufferedAmount = 5 * 1024 * 1024;
  const lookup = browser.heldCommands[0]!;
  control.reject(lookup.command, -32000);
  await vi.waitFor(() =>
    expect(browser.sockets.every((socket) => socket.readyState === 3)).toBe(
      true,
    ),
  );
  expect(controller.input).toBeNull();
  expect(model.getSnapshot()).toMatchObject({
    status: "disconnected",
    error: { kind: "connection" },
  });
});

it.each([{ transport: "shared" as const }, { interactive: false }])(
  "retains a single socket for %j",
  async (options) => {
    const { browser, model } = mount(undefined, options);
    await streaming(model);
    expect(browser.sockets).toHaveLength(1);
    expect(commands(browser.sockets[0]!, "Page.startScreencast")).toHaveLength(
      1,
    );
  },
);

it("routes only capture and ACKs through frames while input and navigation stay on control", async () => {
  const { browser, model, controller } = mount();
  await streaming(model);
  const [control, frames] = browser.sockets as [FakeSocket, FakeSocket];
  expect(browser.sockets).toHaveLength(2);
  expect(commands(control, "Page.startScreencast")).toHaveLength(0);
  expect(commands(frames, "Page.startScreencast")).toMatchObject([
    {
      sessionId: "session-2",
      params: {
        format: "webp",
        quality: 70,
        maxWidth: 1920,
        maxHeight: 1080,
      },
    },
  ]);
  expect(commands(frames, "Page.screencastFrameAck")).toHaveLength(1);
  const input = controller.input!;
  input.text("owned text");
  await input.completion(input.owner!);
  input.navigate("reload");
  await vi.waitFor(() =>
    expect(commands(control, "Page.reload")).toHaveLength(1),
  );
  expect(commands(control, "Input.insertText")).toMatchObject([
    { sessionId: "session-1", params: { text: "owned text" } },
  ]);
  expect(
    frames.commands.some(
      (c) =>
        c.method.startsWith("Input.") ||
        c.method.startsWith("Runtime.") ||
        c.method.startsWith("Browser.") ||
        c.method === "Page.reload",
    ),
  ).toBe(false);
  controller.setCapture({ quality: 50 });
  await vi.waitFor(() =>
    expect(commands(frames, "Page.startScreencast")).toHaveLength(2),
  );
  expect(commands(control, "Page.stopScreencast")).toHaveLength(0);
});

it("qualifies colliding session IDs by source connection and ignores foreign document events", async () => {
  const browser = new FakeBrowser();
  browser.holdAttach = true;
  const { controller, model, sink } = mount(browser);
  await vi.waitFor(() => expect(browser.held).toHaveLength(1));
  const controlAttach = browser.held[0]!;
  controlAttach.socket.reply(controlAttach.command, { sessionId: "collision" });
  await vi.waitFor(() => expect(browser.held).toHaveLength(2));
  const frameAttach = browser.held[1]!;
  frameAttach.socket.reply(frameAttach.command, { sessionId: "collision" });
  await streaming(model);
  const [control, frames] = browser.sockets as [FakeSocket, FakeSocket];
  const owner = controller.input!.owner;
  sink.push.mockClear();
  control.emit(
    "Page.screencastFrame",
    { sessionId: 90, data: "wrong-lane" },
    "collision",
  );
  frames.emit("Runtime.executionContextsCleared", {}, "collision");
  expect(controller.input!.owner).toBe(owner);
  expect(sink.push).not.toHaveBeenCalled();
  expect(commands(control, "Page.screencastFrameAck")).toHaveLength(0);
  frames.emit(
    "Page.screencastFrame",
    { sessionId: 91, data: "owned" },
    "collision",
  );
  expect(sink.push.mock.calls.map(([data]) => data)).toEqual(["owned"]);
  expect(
    commands(frames, "Page.screencastFrameAck").at(-1)?.params?.sessionId,
  ).toBe(91);
  frames.emit("Target.detachedFromTarget", { sessionId: "collision" });
  expect(controller.input).toBeNull();
  expect(model.getSnapshot().status).toBe("unavailable");
  await vi.waitFor(() =>
    expect(commands(control, "Target.detachFromTarget")).toHaveLength(1),
  );
});

it.each([0, 1])(
  "terminates both sockets when lane %i disconnects, without replay or revival",
  async (lane) => {
    const { browser, model, controller, sink } = mount();
    await streaming(model);
    browser.holdMethod = "Input.insertText";
    controller.input!.text("uncertain");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    browser.sockets[lane]!.close();
    expect(controller.input).toBeNull();
    expect(model.getSnapshot()).toMatchObject({
      status: "disconnected",
      error: { kind: "connection" },
    });
    expect(browser.sockets[1]!.readyState).toBe(3);
    expect(browser.sockets[0]!.readyState).toBe(lane === 0 ? 3 : 1);
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command);
    await vi.waitFor(() =>
      expect(browser.sockets.every((socket) => socket.readyState === 3)).toBe(
        true,
      ),
    );
    controller.setPaused(true);
    controller.setPaused(false);
    controller.select("page-b");
    await Promise.resolve();
    expect(model.getSnapshot().status).toBe("disconnected");
    expect(browser.sockets).toHaveLength(2);
    expect(commands(browser.sockets[0]!, "Input.insertText")).toHaveLength(1);
    expect(sink.reset).toHaveBeenCalled();
  },
);

it.each([false, true])(
  "joins original key/composition cleanup after frame loss (rejected: %s)",
  async (rejected) => {
    const { browser, controller, model } = mount();
    await streaming(model);
    const input = controller.input!;
    const [control, frames] = browser.sockets as [FakeSocket, FakeSocket];
    input.key({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
    input.preedit("ni", input.owner!);
    await input.completion(input.owner!);
    browser.holdMethod = "Input.dispatchKeyEvent";
    frames.close();
    expect(controller.input).toBeNull();
    expect(model.getSnapshot().status).toBe("disconnected");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const release = browser.heldCommands[0]!;
    expect(release.command).toMatchObject({
      method: "Input.dispatchKeyEvent",
      sessionId: input.sessionId,
      params: { type: "keyUp", key: "Shift" },
    });
    expect(
      commands(control, "Input.imeSetComposition").some(
        (command) =>
          command.sessionId === input.sessionId && command.params?.text === "",
      ),
    ).toBe(true);
    expect(control.readyState).toBe(1);
    expect(commands(control, "Target.detachFromTarget")).toHaveLength(0);
    if (rejected) control.reject(release.command, -32000);
    else control.reply(release.command);
    await vi.waitFor(() => expect(control.readyState).toBe(3));
    expect(
      commands(control, "Input.dispatchKeyEvent").filter(
        (command) => command.params?.type === "keyUp",
      ),
    ).toHaveLength(1);
    expect(model.getSnapshot().status).toBe("disconnected");
  },
);

it("releases a late frame attachment through its original socket without touching the replacement", async () => {
  const browser = new FakeBrowser();
  browser.holdAttach = true;
  const { model, controller, sink } = mount(browser);
  await vi.waitFor(() => expect(browser.held).toHaveLength(1));
  const first = browser.held[0]!;
  first.socket.reply(first.command, { sessionId: first.sessionId });
  await vi.waitFor(() => expect(browser.held).toHaveLength(2));
  const old = browser.held[1]!;
  browser.holdAttach = false;
  controller.select("page-b");
  await streaming(model);
  const input = controller.input;
  sink.push.mockClear();
  old.socket.reply(old.command, { sessionId: old.sessionId });
  await vi.waitFor(() =>
    expect(
      commands(old.socket, "Target.detachFromTarget").some(
        (c) => c.params?.sessionId === old.sessionId,
      ),
    ).toBe(true),
  );
  old.socket.emit(
    "Page.screencastFrame",
    { sessionId: 99, data: "stale" },
    old.sessionId,
  );
  expect(sink.push).not.toHaveBeenCalled();
  expect(controller.input).toBe(input);
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    selectedTargetId: "page-b",
  });
});

it("keeps original input retirement fenced after promptly releasing the frame session", async () => {
  const browser = new FakeBrowser();
  const { model, controller, sink } = mount(browser);
  await streaming(model);
  const old = controller.input!;
  const [control, frames] = browser.sockets as [FakeSocket, FakeSocket];
  browser.holdMethod = "Input.imeSetComposition";
  old.preedit("n", old.owner!);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.select("page-b");
  await streaming(model);
  expect(
    commands(frames, "Page.stopScreencast").some(
      (c) => c.sessionId === "session-2",
    ),
  ).toBe(true);
  expect(
    commands(frames, "Target.detachFromTarget").some(
      (c) => c.params?.sessionId === "session-2",
    ),
  ).toBe(true);
  expect(
    commands(control, "Target.detachFromTarget").some(
      (c) => c.params?.sessionId === old.sessionId,
    ),
  ).toBe(false);
  sink.push.mockClear();
  control.emit(
    "Page.screencastFrame",
    { sessionId: 98, data: "wrong" },
    old.sessionId,
  );
  frames.emit(
    "Page.screencastFrame",
    { sessionId: 99, data: "old" },
    "session-2",
  );
  expect(sink.push).not.toHaveBeenCalled();
  controller.select("page-a");
  expect(controller.input).toBeNull();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  expect(
    commands(control, "Target.attachToTarget").filter(
      (c) => c.params?.targetId === "page-a",
    ),
  ).toHaveLength(1);
  browser.holdMethod = null;
  for (const held of browser.heldCommands) held.socket.reply(held.command);
  await streaming(model);
  expect(controller.input!.sessionId).not.toBe(old.sessionId);
});

it("preserves the other window when a split viewer pauses, resumes and closes", async () => {
  const browser = new FakeBrowser();
  const a = mount(browser, { windowId: 0 });
  const b = mount(browser, { windowId: 2 });
  await Promise.all([streaming(a.model), streaming(b.model)]);
  const other = b.controller.input;
  a.controller.setPaused(true);
  expect(a.controller.input).toBeNull();
  expect(b.controller.input).toBe(other);
  a.controller.setPaused(false);
  await streaming(a.model);
  a.controller.close();
  expect(
    browser.sockets.slice(0, 2).every((socket) => socket.readyState === 3),
  ).toBe(true);
  expect(
    browser.sockets.slice(2).every((socket) => socket.readyState === 1),
  ).toBe(true);
  expect(b.controller.input).toBe(other);
  expect(browser.targets).toHaveLength(2);
  expect(
    browser.sockets.flatMap((socket) => commands(socket, "Target.closeTarget")),
  ).toHaveLength(0);
});
