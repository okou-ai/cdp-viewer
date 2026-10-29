import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";
import type { FakeTarget } from "./wire";

const controllers: ViewerController[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.close());
  vi.useRealTimers();
});

function browser(pages = 20) {
  const fake = new FakeBrowser();
  fake.targets = Array.from({ length: pages }, (_, index) => ({
    id: "owned-" + index,
    title: "Owned " + index,
    windowId: 0,
  }));
  return fake;
}

function mount(
  fake: FakeBrowser,
  options: {
    windowId?: number;
    paused?: boolean;
    requestTimeout?: number;
    onTabClosed?: (targetId: string) => void;
  } = {
    windowId: 0,
  },
) {
  const model = createViewerModel();
  const sink = {
    push: vi.fn(
      (
        _data: string,
        painted: (raster: { width: number; height: number }) => void,
      ) => painted({ width: 800, height: 600 }),
    ),
    reset: vi.fn(),
    invalidate: vi.fn(),
    dispose: vi.fn(),
  };
  const controller = new ViewerController(model, sink, {
    url: "wss://fixture.invalid",
    socketFactory: fake.factory,
    interactive: true,
    ...options,
  });
  controllers.push(controller);
  controller.start();
  return { controller, model, sink };
}

const advance = (milliseconds = 0) => vi.advanceTimersByTimeAsync(milliseconds);
const count = (fake: FakeBrowser, method: string) =>
  fake.sockets
    .flatMap((socket) => socket.commands)
    .filter((command) => command.method === method).length;
const info = (target: FakeTarget) => ({
  targetId: target.id,
  type: "page",
  title: target.title,
  url: target.url ?? "https://fixture.invalid/",
});

it.each([
  { pages: 1, paused: false },
  { pages: 20, paused: false },
  { pages: 100, paused: false },
  { pages: 20, paused: true },
])(
  "limits settled idle work to the active selection %j",
  async ({ pages, paused }) => {
    const fake = browser(pages);
    const { model } = mount(fake, { windowId: 0, paused });
    await advance();
    expect(model.getSnapshot().status).toBe(paused ? "paused" : "streaming");
    const before = model.getSnapshot();
    const queries = count(fake, "Target.getTargets");
    const membership = count(fake, "Browser.getWindowForTarget");
    await advance(6100);
    expect(count(fake, "Target.getTargets") - queries).toBe(0);
    expect(count(fake, "Browser.getWindowForTarget") - membership).toBe(
      paused ? 0 : 3,
    );
    expect(model.getSnapshot()).toBe(before);
  },
);

it.each([false, true])(
  "includes all background rounds in long idle counts, paused=%s",
  async (paused) => {
    const fake = browser();
    const { model } = mount(fake, { windowId: 0, paused });
    await advance();
    const queries = count(fake, "Target.getTargets");
    const membership = count(fake, "Browser.getWindowForTarget");
    await advance(61_100);
    expect(count(fake, "Target.getTargets") - queries).toBe(6);
    expect(count(fake, "Browser.getWindowForTarget") - membership).toBe(
      paused ? 120 : 150,
    );
    expect(model.getSnapshot().status).toBe(paused ? "paused" : "streaming");
  },
);

it("keeps sibling observation and pause/resume lifetimes independent", async () => {
  const fake = browser();
  fake.targets.push(
    ...Array.from({ length: 20 }, (_, index) => ({
      id: "sibling-" + index,
      title: "Sibling",
      windowId: 2,
    })),
  );
  const first = mount(fake);
  const second = mount(fake, { windowId: 2 });
  await advance();
  const queries = count(fake, "Target.getTargets");
  const membership = count(fake, "Browser.getWindowForTarget");
  await advance(6100);
  expect(count(fake, "Target.getTargets") - queries).toBe(0);
  expect(count(fake, "Browser.getWindowForTarget") - membership).toBe(6);
  first.controller.setPaused(true);
  await advance(2000);
  expect(first.model.getSnapshot().status).toBe("paused");
  expect(second.model.getSnapshot().status).toBe("streaming");
  first.controller.setPaused(false);
  await advance();
  expect(first.model.getSnapshot().status).toBe("streaming");
  first.controller.close();
  const sibling = second.model.getSnapshot();
  await advance(6100);
  expect(second.model.getSnapshot()).toBe(sibling);
  expect(fake.sockets[1]!.readyState).toBe(1);
});

it("keeps unscoped operation free of window reads and periodic inventory", async () => {
  const fake = browser();
  fake.unsupportedWindows = true;
  const { model } = mount(fake, {});
  await advance();
  const queries = count(fake, "Target.getTargets");
  await advance(61_100);
  expect(count(fake, "Target.getTargets")).toBe(queries);
  expect(count(fake, "Browser.getWindowForTarget")).toBe(0);
  expect(model.getSnapshot().status).toBe("streaming");
});

it.each(["page", "worker"])(
  "coalesces %s events without full inventory reads",
  async (type) => {
    const fake = browser();
    const { model } = mount(fake);
    await advance();
    const queries = count(fake, "Target.getTargets");
    const membership = count(fake, "Browser.getWindowForTarget");
    const snapshot = model.getSnapshot();
    for (let index = 0; index < 10; index++) {
      fake.targets[0]!.title = "Renamed " + index;
      fake.sockets[0]!.emit("Target.targetInfoChanged", {
        targetInfo:
          type === "page"
            ? info(fake.targets[0]!)
            : { targetId: "worker-owned", type: "worker", title: "Worker" },
      });
    }
    await advance();
    expect(count(fake, "Target.getTargets")).toBe(queries);
    expect(count(fake, "Browser.getWindowForTarget") - membership).toBe(
      type === "page" ? 2 : 0,
    );
    if (type === "page")
      expect(model.getSnapshot().targets[0]!.title).toBe("Renamed 9");
    else expect(model.getSnapshot()).toBe(snapshot);
  },
);

it("retains the public snapshot for equivalent target events", async () => {
  const fake = browser();
  const { model } = mount(fake);
  await advance();
  const snapshot = model.getSnapshot();
  const changed = vi.fn();
  const stop = model.subscribe(changed);
  try {
    for (let index = 0; index < 3; index++) {
      fake.sockets[0]!.emit("Target.targetInfoChanged", {
        targetInfo: info(fake.targets[0]!),
      });
      await advance();
    }
    expect(model.getSnapshot()).toBe(snapshot);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it("uses verified creation results without another full scan and removes destruction immediately", async () => {
  const fake = browser(1);
  const { controller, model } = mount(fake);
  await advance();
  const queries = count(fake, "Target.getTargets");
  controller.createTab();
  await advance();
  const created = model.getSnapshot().selectedTargetId!;
  expect(created).not.toBe("owned-0");
  expect(model.getSnapshot().status).toBe("streaming");
  expect(count(fake, "Target.getTargets") - queries).toBe(2);
  fake.targets = fake.targets.filter((target) => target.id !== created);
  fake.sockets[0]!.emit("Target.targetDestroyed", { targetId: created });
  expect(model.getSnapshot()).toMatchObject({
    status: "unavailable",
    selectedTargetId: null,
  });
  expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
    "owned-0",
  ]);
});

it.each([{ windowId: 0 }, {}])(
  "does not republish a closed tab while authoritative discovery is pending %j",
  async (options) => {
    const fake = browser(3);
    const { controller, model } = mount(fake, options);
    await advance();
    fake.holdMethod = "Target.closeTarget";
    controller.closeTab("owned-1");
    await advance();
    expect(fake.heldCommands).toHaveLength(1);
    const close = fake.heldCommands.shift()!;
    // The close succeeds before its corresponding target event is delivered.
    fake.targets = fake.targets.filter((target) => target.id !== "owned-1");
    fake.holdMethod = "Target.getTargets";
    close.socket.reply(close.command, { success: true });
    await advance();
    expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
      "owned-0",
      "owned-2",
    ]);
    expect(fake.heldCommands).toHaveLength(1);
    fake.targets = fake.targets.filter((target) => target.id !== "owned-2");
    fake.sockets[0]!.emit("Target.targetDestroyed", {
      targetId: "owned-2",
    });
    expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
      "owned-0",
    ]);
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "owned-0",
    });
    fake.holdMethod = null;
    const full = fake.heldCommands.shift()!;
    fake.resume(full.command, full.socket);
    await advance();
    expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
      "owned-0",
    ]);
  },
);

it.each(["event", "full"])(
  "keeps newer %s creation metadata when an older explicit list completes",
  async (source) => {
    const fake = browser(1);
    const { controller, model } = mount(fake);
    await advance();
    const socket = fake.sockets[0]!;
    socket.holdReplyMethod = "Target.getTargets";
    controller.createTab();
    await advance();
    expect(socket.heldReplies).toHaveLength(1);
    const identify = socket.heldReplies.shift()!;
    socket.holdReplyMethod = null;
    socket.reply(identify.command, identify.result);
    socket.holdReplyMethod = "Target.getTargets";
    await advance();
    expect(socket.heldReplies).toHaveLength(1);
    const list = socket.heldReplies.shift()!;
    const created = fake.targets.at(-1)!;
    created.title = "Newer creation title";
    if (source === "event") {
      socket.emit("Target.targetInfoChanged", { targetInfo: info(created) });
      await advance();
    } else {
      socket.emit("Target.targetInfoChanged", {});
      await advance();
      expect(socket.heldReplies).toHaveLength(1);
      const full = socket.heldReplies.shift()!;
      socket.holdReplyMethod = null;
      socket.reply(full.command, full.result);
      await advance();
    }
    expect(
      model.getSnapshot().targets.find((target) => target.id === created.id)
        ?.title,
    ).toBe("Newer creation title");
    socket.holdReplyMethod = null;
    socket.reply(list.command, list.result);
    await advance();
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: created.id,
    });
    expect(
      model.getSnapshot().targets.find((target) => target.id === created.id)
        ?.title,
    ).toBe("Newer creation title");
  },
);

it.each([{ windowId: 0 }, {}])(
  "rejects a retired creation while its old explicit list completes %j",
  async (options) => {
    const fake = browser(1);
    const { controller, model } = mount(fake, options);
    await advance();
    const socket = fake.sockets[0]!;
    socket.holdReplyMethod = "Target.getTargets";
    controller.createTab();
    await advance();
    const identify = socket.heldReplies.shift()!;
    expect(identify).toBeDefined();
    socket.holdReplyMethod = null;
    socket.reply(identify.command, identify.result);
    socket.holdReplyMethod = "Target.getTargets";
    await advance();
    const list = socket.heldReplies.shift()!;
    expect(list).toBeDefined();
    const created = fake.targets.at(-1)!;
    const scoped = "windowId" in options;
    if (scoped) {
      socket.holdReplyMethod = "Browser.getWindowForTarget";
      socket.reply(list.command, list.result);
      await advance();
      expect(socket.heldReplies).toHaveLength(2);
    }
    const attaches = count(fake, "Target.attachToTarget");
    fake.targets = fake.targets.filter((target) => target.id !== created.id);
    socket.emit("Target.targetDestroyed", { targetId: created.id });
    socket.holdReplyMethod = null;
    if (scoped)
      for (const held of socket.heldReplies.splice(0))
        socket.reply(held.command, held.result);
    else socket.reply(list.command, list.result);
    await advance();
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "owned-0",
      targets: [{ id: "owned-0" }],
      error: { kind: "tab" },
    });
    expect(count(fake, "Target.attachToTarget")).toBe(attaches);
    expect(controller.input).not.toBeNull();
  },
);

it.each(["negative", "failure"])(
  "ignores an older selected %s after a newer positive scope result",
  async (outcome) => {
    const fake = browser(1);
    const { controller, model } = mount(fake);
    await advance();
    fake.holdMethod = "Browser.getWindowForTarget";
    await advance(2000);
    expect(fake.heldCommands).toHaveLength(1);
    fake.sockets[0]!.emit("Target.targetInfoChanged", {
      targetInfo: { ...info(fake.targets[0]!), title: "New title" },
    });
    await advance();
    expect(fake.heldCommands).toHaveLength(2);
    const selected = fake.heldCommands.shift()!;
    const newer = fake.heldCommands.shift()!;
    fake.holdMethod = null;
    newer.socket.reply(newer.command, { windowId: 0 });
    await advance();
    if (outcome === "negative")
      selected.socket.reply(selected.command, { windowId: 2 });
    else selected.socket.reject(selected.command, -32000);
    await advance();
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "owned-0",
      targets: [{ id: "owned-0", title: "New title" }],
      error: null,
    });
    expect(controller.input).not.toBeNull();
  },
);

it("keeps a newer explicit selection made during creation publication", async () => {
  const fake = browser(1);
  const { controller, model } = mount(fake);
  await advance();
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === "new-1" &&
    fake.heldCommands.length === 0;
  let replaced = false;
  const stop = model.subscribe(() => {
    if (
      !replaced &&
      model.getSnapshot().targets.some((target) => target.id === "new-1")
    ) {
      replaced = true;
      controller.select("owned-0");
    }
  });
  try {
    controller.createTab();
    await advance();
    expect(replaced).toBe(true);
    expect(fake.heldCommands).toHaveLength(1);
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "owned-0",
    });
    const held = fake.heldCommands.shift()!;
    fake.holdCommand = null;
    held.socket.reply(held.command, { windowId: 0 });
    await advance();
    expect(model.getSnapshot().selectedTargetId).toBe("owned-0");
  } finally {
    stop();
  }
});

it("does not activate an obsolete selection after synchronous model publication", async () => {
  const fake = browser(2);
  const { controller, model } = mount(fake);
  await advance();
  let replaced = false;
  const stop = model.subscribe(() => {
    if (!replaced && model.getSnapshot().selectedTargetId === "owned-1") {
      replaced = true;
      controller.select("owned-0");
    }
  });
  try {
    controller.select("owned-1");
    await advance();
    expect(replaced).toBe(true);
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "owned-0",
    });
    expect(
      fake.sockets[0]!.commands.some(
        (command) =>
          command.method === "Target.activateTarget" &&
          command.params?.targetId === "owned-1",
      ),
    ).toBe(false);
    expect(controller.input).not.toBeNull();
  } finally {
    stop();
  }
});

it("does not notify a retired controller after close publication", async () => {
  const fake = browser(2);
  const closed = vi.fn();
  const { controller, model } = mount(fake, {
    windowId: 0,
    onTabClosed: closed,
  });
  await advance();
  let retired = false;
  const stop = model.subscribe(() => {
    if (
      !retired &&
      !model.getSnapshot().targets.some((target) => target.id === "owned-1")
    ) {
      retired = true;
      controller.close();
    }
  });
  try {
    fake.holdMethod = "Target.closeTarget";
    controller.closeTab("owned-1");
    await advance();
    expect(fake.heldCommands).toHaveLength(1);
    const held = fake.heldCommands.shift()!;
    fake.targets.pop();
    fake.holdMethod = null;
    held.socket.reply(held.command, { success: true });
    await advance();
    expect(retired).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    expect(controller.input).toBeNull();
    expect(count(fake, "Target.getTargets")).toBe(1);
  } finally {
    stop();
  }
});

it("preserves a newer selection made during discovery target-loss publication", async () => {
  const fake = browser(2);
  const { controller, model } = mount(fake);
  await advance();
  expect(model.getSnapshot().navigation).not.toBeNull();
  let replaced = false;
  let tornRetirement = false;
  const stop = model.subscribe(() => {
    const snapshot = model.getSnapshot();
    if (
      snapshot.selectedTargetId === "owned-0" &&
      snapshot.navigation === null &&
      !snapshot.targets.some((target) => target.id === "owned-0")
    )
      tornRetirement = true;
    if (
      !replaced &&
      snapshot.selectedTargetId === null &&
      snapshot.status === "unavailable" &&
      snapshot.navigation === null &&
      !snapshot.targets.some((target) => target.id === "owned-0")
    ) {
      replaced = true;
      controller.select("owned-1");
    }
  });
  try {
    fake.targets[0]!.windowId = 1;
    await advance(2000);
    expect(tornRetirement).toBe(false);
    expect(replaced).toBe(true);
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "owned-1",
    });
    expect(controller.input).not.toBeNull();
  } finally {
    stop();
  }
});

it("repairs silent selected and background titles on the authoritative round", async () => {
  const fake = browser(2);
  const { model } = mount(fake);
  await advance();
  const selected = model.getSnapshot().selectedTargetId;
  fake.targets[0]!.title = "Silent selected title";
  fake.targets[1]!.title = "Silent background title";
  await advance(6_000);
  expect(model.getSnapshot().targets.map((target) => target.title)).toEqual([
    "Owned 0",
    "Owned 1",
  ]);
  await advance(4_000);
  expect(model.getSnapshot().targets.map((target) => target.title)).toEqual([
    "Silent selected title",
    "Silent background title",
  ]);
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    selectedTargetId: selected,
  });
});

it("does not republish an unavailable snapshot for unrelated destruction during a scan", async () => {
  const fake = browser();
  const { model } = mount(fake, { windowId: 99 });
  await advance();
  expect(model.getSnapshot().status).toBe("unavailable");
  fake.holdMethod = "Browser.getWindowForTarget";
  await advance(10_000);
  const snapshot = model.getSnapshot();
  fake.sockets[0]!.emit("Target.targetDestroyed", {
    targetId: "unrelated-worker",
  });
  expect(model.getSnapshot()).toBe(snapshot);
});

it.each(["positive", "failure"])(
  "ignores a retired event target's late %s",
  async (outcome) => {
    const fake = browser(1);
    const { model } = mount(fake);
    await advance();
    const added = { id: "new-page", title: "New", windowId: 0 };
    fake.targets.push(added);
    fake.holdCommand = (command) =>
      command.method === "Browser.getWindowForTarget" &&
      command.params?.targetId === added.id;
    fake.sockets[0]!.emit("Target.targetCreated", { targetInfo: info(added) });
    await advance();
    expect(fake.heldCommands).toHaveLength(1);
    expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
      "owned-0",
    ]);
    fake.targets.pop();
    fake.sockets[0]!.emit("Target.targetDestroyed", { targetId: added.id });
    const held = fake.heldCommands.shift()!;
    if (outcome === "positive")
      held.socket.reply(held.command, { windowId: 0 });
    else held.socket.reject(held.command, -32000);
    await advance();
    expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
      "owned-0",
    ]);
    expect(model.getSnapshot().status).toBe("streaming");
  },
);

it("adds only the verified window member and removes a page that becomes a worker", async () => {
  const fake = browser(1);
  const { model } = mount(fake);
  await advance();
  const outside = { id: "outside", title: "Outside", windowId: 2 };
  const inside = { id: "inside", title: "Inside", windowId: 0 };
  fake.targets.push(outside, inside);
  fake.sockets[0]!.emit("Target.targetCreated", { targetInfo: info(outside) });
  fake.sockets[0]!.emit("Target.targetCreated", { targetInfo: info(inside) });
  await advance();
  expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
    "owned-0",
    "inside",
  ]);
  fake.sockets[0]!.emit("Target.targetInfoChanged", {
    targetInfo: { ...info(inside), type: "worker" },
  });
  await advance();
  expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
    "owned-0",
  ]);
});

it("reconciles silent unselected moves while paused and freshly checks resume", async () => {
  const fake = browser(2);
  const { controller, model } = mount(fake, { windowId: 0, paused: true });
  await advance();
  fake.targets[1]!.windowId = 2;
  await advance(9999);
  expect(model.getSnapshot().targets).toHaveLength(2);
  await advance(1);
  expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
    "owned-0",
  ]);
  fake.targets[0]!.windowId = 2;
  controller.setPaused(false);
  await advance();
  expect(controller.input).toBeNull();
  expect(model.getSnapshot().error?.kind).toBe("scope");
});

it.each([
  { selected: 19, heldId: 0 },
  { selected: 0, heldId: 19 },
])(
  "retires a moved selected owner independently of a held background read %j",
  async ({ selected, heldId }) => {
    const fake = browser();
    const { controller, model, sink } = mount(fake);
    await advance();
    const selectedId = "owned-" + selected;
    controller.select(selectedId);
    await advance();
    fake.holdCommand = (command) =>
      command.method === "Browser.getWindowForTarget" &&
      command.params?.targetId === "owned-" + heldId;
    await advance(10_000);
    expect(fake.heldCommands).toHaveLength(1);
    fake.targets[selected]!.windowId = 2;
    const resets = sink.reset.mock.calls.length;
    await advance(2000);
    expect(model.getSnapshot().selectedTargetId).toBeNull();
    expect(controller.input).toBeNull();
    expect(sink.reset.mock.calls.length).toBeGreaterThan(resets);
    expect(
      model.getSnapshot().targets.some((target) => target.id === selectedId),
    ).toBe(false);
    fake.holdCommand = null;
    const held = fake.heldCommands.shift()!;
    held.socket.reply(held.command, { windowId: 0 });
    await advance();
    expect(
      model.getSnapshot().targets.some((target) => target.id === selectedId),
    ).toBe(false);
    expect(model.getSnapshot().selectedTargetId).toBeNull();
  },
);

it.each(["success", "failure"])(
  "ignores a late selected %s after replacement",
  async (outcome) => {
    const fake = browser(2);
    const { controller, model } = mount(fake);
    await advance();
    fake.holdCommand = (command) =>
      command.method === "Browser.getWindowForTarget" &&
      command.params?.targetId === "owned-0";
    await advance(2000);
    expect(fake.heldCommands).toHaveLength(1);
    controller.select("owned-1");
    await advance();
    const held = fake.heldCommands.shift()!;
    if (outcome === "failure") held.socket.reject(held.command, -32000);
    else held.socket.reply(held.command, { windowId: 2 });
    await advance();
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "owned-1",
      error: null,
    });
  },
);

it("fails closed at the selected request deadline without overlapping that owner", async () => {
  const fake = browser();
  const { controller, model } = mount(fake, {
    windowId: 0,
    requestTimeout: 500,
  });
  await advance();
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === "owned-0";
  await advance(2499);
  expect(fake.heldCommands).toHaveLength(1);
  expect(controller.input).not.toBeNull();
  await advance(1);
  expect(model.getSnapshot()).toMatchObject({
    status: "unavailable",
    selectedTargetId: null,
    targets: [],
  });
  expect(controller.input).toBeNull();
  await advance(4000);
  expect(fake.heldCommands).toHaveLength(1);
});

it.each(
  ["full", "dirty"].flatMap((mode) =>
    [0, 2].map((windowId) => ({ mode, windowId })),
  ),
)(
  "isolates a failed background lookup before sibling reads settle %j",
  async ({ mode, windowId }) => {
    const fake = browser(3);
    fake.targets[1]!.windowId = windowId;
    const { controller, model, sink } = mount(fake);
    await advance();
    const input = controller.input!;
    const resets = sink.reset.mock.calls.length;
    const attaches = count(fake, "Target.attachToTarget");
    fake.holdCommand = (command) =>
      command.method === "Browser.getWindowForTarget" &&
      ["owned-1", "owned-2"].includes(String(command.params?.targetId));
    if (mode === "full") await advance(10_000);
    else {
      for (const target of fake.targets.slice(1))
        fake.sockets[0]!.emit("Target.targetInfoChanged", {
          targetInfo: info(target),
        });
      await advance();
    }
    const failed = fake.heldCommands.shift()!;
    expect(failed.command.params?.targetId).toBe("owned-1");
    failed.socket.reject(failed.command, -32000);
    await advance();
    expect(fake.heldCommands).toHaveLength(1);
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "owned-0",
      targets: [{ id: "owned-0" }, { id: "owned-2" }],
      error: null,
    });
    expect(controller.input).toBe(input);
    expect(sink.reset).toHaveBeenCalledTimes(resets);
    expect(count(fake, "Target.attachToTarget")).toBe(attaches);
    input.text("still selected");
    await advance();
    expect(fake.sockets[0]!.commands).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "still selected" },
        sessionId: "session-1",
      }),
    );
    const sibling = fake.heldCommands.shift()!;
    sibling.socket.reply(sibling.command, { windowId: 0 });
    await advance();
    fake.targets[1]!.windowId = 0;
    fake.sockets[0]!.emit("Target.targetInfoChanged", {
      targetInfo: info(fake.targets[1]!),
    });
    await advance();
    expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
      "owned-0",
      "owned-2",
    ]);
    const fresh = fake.heldCommands.shift()!;
    fresh.socket.reply(fresh.command, { windowId: 0 });
    await advance();
    expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
      "owned-0",
      "owned-1",
      "owned-2",
    ]);
    expect(controller.input).toBe(input);
  },
);

it.each(["rejected", "invalid", "timeout"])(
  "starts viewing verified pages when a foreign lookup is %s",
  async (outcome) => {
    const fake = browser(2);
    fake.targets[1]!.windowId = 2;
    fake.holdCommand = (command) =>
      command.method === "Browser.getWindowForTarget" &&
      command.params?.targetId === "owned-1";
    const { controller, model } = mount(fake, {
      windowId: 0,
      requestTimeout: 500,
    });
    await advance();
    expect(fake.heldCommands).toHaveLength(1);
    const held = fake.heldCommands.shift()!;
    if (outcome === "rejected") held.socket.reject(held.command, -32000);
    else if (outcome === "invalid")
      held.socket.reply(held.command, { windowId: "0" });
    else await advance(500);
    await advance();
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "owned-0",
      targets: [{ id: "owned-0" }],
      error: null,
    });
    expect(controller.input).not.toBeNull();
    expect(
      fake.sockets[0]!.commands.filter(
        (command) => command.method === "Target.attachToTarget",
      ).map((command) => command.params?.targetId),
    ).toEqual(["owned-0"]);
  },
);

it.each([false, true])(
  "still fails on a selected page's reconciliation failure, paused=%s",
  async (paused) => {
    const fake = browser(2);
    const { controller, model } = mount(fake);
    await advance();
    if (paused) controller.setPaused(true);
    fake.holdCommand = (command) =>
      command.method === "Browser.getWindowForTarget" &&
      command.params?.targetId === "owned-0";
    fake.sockets[0]!.emit("Target.targetInfoChanged", {
      targetInfo: info(fake.targets[0]!),
    });
    await advance();
    const held = fake.heldCommands.shift()!;
    held.socket.reject(held.command, -32000);
    await advance();
    expect(model.getSnapshot()).toMatchObject({
      status: "unavailable",
      selectedTargetId: null,
      targets: [],
      error: { kind: "scope" },
    });
    expect(controller.input).toBeNull();
  },
);

it("does not disguise an unsupported window API as a background-page failure", async () => {
  const fake = browser(2);
  const { controller, model } = mount(fake);
  await advance();
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === "owned-1";
  fake.sockets[0]!.emit("Target.targetInfoChanged", {
    targetInfo: info(fake.targets[1]!),
  });
  await advance();
  const held = fake.heldCommands.shift()!;
  held.socket.reject(held.command, -32601);
  await advance();
  expect(model.getSnapshot()).toMatchObject({
    status: "unavailable",
    selectedTargetId: null,
    targets: [],
    error: { kind: "unsupported-capability" },
  });
  expect(controller.input).toBeNull();
});

it("keeps a sibling viewer whose selected page is independently verified", async () => {
  const fake = browser(2);
  fake.targets[1]!.windowId = 2;
  const first = mount(fake);
  const second = mount(fake, { windowId: 2 });
  await advance();
  const input = first.controller.input;
  const resets = first.sink.reset.mock.calls.length;
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === "owned-1";
  for (const socket of fake.sockets)
    socket.emit("Target.targetInfoChanged", {
      targetInfo: info(fake.targets[1]!),
    });
  await advance();
  expect(fake.heldCommands).toHaveLength(2);
  for (const held of fake.heldCommands.splice(0))
    held.socket.reject(held.command, -32000);
  await advance();
  expect(first.model.getSnapshot()).toMatchObject({
    status: "streaming",
    selectedTargetId: "owned-0",
    targets: [{ id: "owned-0" }],
    error: null,
  });
  expect(first.controller.input).toBe(input);
  expect(first.sink.reset).toHaveBeenCalledTimes(resets);
  expect(second.model.getSnapshot()).toMatchObject({
    status: "unavailable",
    selectedTargetId: null,
    targets: [],
    error: { kind: "scope" },
  });
  expect(second.controller.input).toBeNull();
});

it.each(["failure", "negative"])(
  "does not let an older background %s revoke a freshly attached selection",
  async (outcome) => {
    const fake = browser(2);
    const { controller, model, sink } = mount(fake);
    await advance();
    fake.holdCommand = (command) =>
      command.method === "Browser.getWindowForTarget" &&
      command.params?.targetId === "owned-1";
    fake.sockets[0]!.emit("Target.targetInfoChanged", {
      targetInfo: info(fake.targets[1]!),
    });
    await advance();
    const held = fake.heldCommands.shift()!;
    fake.holdCommand = null;
    controller.select("owned-1");
    await advance();
    const input = controller.input;
    const resets = sink.reset.mock.calls.length;
    expect(input).not.toBeNull();
    expect(model.getSnapshot().status).toBe("streaming");
    if (outcome === "failure") held.socket.reject(held.command, -32000);
    else held.socket.reply(held.command, { windowId: 2 });
    await advance();
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "owned-1",
      targets: [{ id: "owned-0" }, { id: "owned-1" }],
      error: null,
    });
    expect(controller.input).toBe(input);
    expect(sink.reset).toHaveBeenCalledTimes(resets);
  },
);

it("fails a slow full round at its overall deadline and discards its late results", async () => {
  const fake = browser();
  const { controller, model } = mount(fake);
  await advance();
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === "owned-0";
  controller.setPaused(true);
  await advance(10_000);
  expect(fake.heldCommands).toHaveLength(1);
  const reads = count(fake, "Browser.getWindowForTarget");
  await advance(9999);
  expect(model.getSnapshot().status).toBe("paused");
  await advance(1);
  expect(model.getSnapshot()).toMatchObject({
    status: "unavailable",
    targets: [],
    selectedTargetId: null,
  });
  expect(count(fake, "Browser.getWindowForTarget")).toBeLessThanOrEqual(
    reads + 4,
  );
  const held = fake.heldCommands.shift()!;
  held.socket.reply(held.command, { windowId: 0 });
  await advance();
  expect(model.getSnapshot().targets).toEqual([]);
});

it("does not renew membership freshness from a delayed old positive reply", async () => {
  const fake = browser();
  const { controller, model } = mount(fake);
  await advance();
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === "owned-0";
  await advance(2000);
  const first = fake.heldCommands.shift()!;
  fake.targets[0]!.windowId = 2;
  await advance(9900);
  // The reply reflects an old request's positive observation, not a fresh check.
  first.socket.reply(first.command, { windowId: 0 });
  await advance();
  expect(controller.input).not.toBeNull();
  await advance(2099);
  expect(controller.input).not.toBeNull();
  await advance(1);
  expect(controller.input).toBeNull();
  expect(model.getSnapshot()).toMatchObject({
    status: "unavailable",
    selectedTargetId: null,
    targets: [],
  });
});

it("blocks local admission when observation age expires before its timer runs", async () => {
  const fake = browser();
  const { controller, model } = mount(fake);
  await advance();
  expect(controller.input).not.toBeNull();
  const now = performance.now();
  const clock = vi.spyOn(performance, "now").mockReturnValue(now + 12_000);
  try {
    expect(model.getSnapshot().status).toBe("streaming");
    expect(controller.input).toBeNull();
  } finally {
    clock.mockRestore();
  }
});

it("accepts negative membership despite overlapping title changes", async () => {
  const fake = browser(2);
  const { controller, model } = mount(fake);
  await advance();
  const background = fake.targets[1]!;
  background.windowId = 2;
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === background.id;
  const changed = () => {
    background.title += " updated";
    fake.sockets[0]!.emit("Target.targetInfoChanged", {
      targetInfo: info(background),
    });
  };
  changed();
  await advance();
  expect(fake.heldCommands).toHaveLength(1);
  changed();
  const held = fake.heldCommands.shift()!;
  fake.holdCommand = null;
  held.socket.reply(held.command, { windowId: 2 });
  await advance();
  expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
    "owned-0",
  ]);
  expect(controller.input).not.toBeNull();
  await advance(21_000);
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    selectedTargetId: "owned-0",
    targets: [{ id: "owned-0", title: "Owned 0" }],
  });
});

it.each(["before", "after"])(
  "keeps healthy membership progressing when titles arrive %s replies",
  async (ordering) => {
    const fake = browser(2);
    const { controller, model } = mount(fake);
    await advance();
    const target = fake.targets[1]!;
    fake.holdCommand = (command) =>
      command.method === "Browser.getWindowForTarget" &&
      command.params?.targetId === target.id;
    const changed = (tick: number) => {
      target.title = "Background " + tick;
      fake.sockets[0]!.emit("Target.targetInfoChanged", {
        targetInfo: info(target),
      });
    };
    changed(0);
    await advance();
    for (let tick = 1; tick <= 41; tick++) {
      await advance(1000);
      expect(fake.heldCommands).toHaveLength(1);
      if (ordering === "before") changed(tick);
      const held = fake.heldCommands.shift()!;
      held.socket.reply(held.command, { windowId: 0 });
      await advance();
      if (ordering === "after") {
        changed(tick);
        await advance();
      }
      expect(model.getSnapshot()).toMatchObject({
        status: "streaming",
        selectedTargetId: "owned-0",
        targets: [
          { id: "owned-0" },
          { id: target.id, title: "Background " + tick },
        ],
      });
      expect(controller.input).not.toBeNull();
    }
  },
);

it.each([false, true])(
  "keeps current checks fresh through metadata churn, selected=%s",
  async (selected) => {
    const fake = browser(2);
    const { controller, model } = mount(fake);
    await advance();
    const target = fake.targets[selected ? 0 : 1]!;
    fake.holdCommand = (command) =>
      command.method === "Browser.getWindowForTarget" &&
      command.params?.targetId === target.id &&
      fake.heldCommands.length === 0;
    const changed = () => {
      target.title += " updated";
      fake.sockets[0]!.emit("Target.targetInfoChanged", {
        targetInfo: info(target),
      });
    };
    const settle = async () => {
      expect(fake.heldCommands).toHaveLength(1);
      const held = fake.heldCommands.shift()!;
      held.socket.reply(held.command, { windowId: 0 });
      await advance();
    };
    changed();
    await advance();
    for (let tick = 1; tick <= 19; tick++) {
      await advance(2000);
      changed();
      await settle();
      if (tick % 5 === 0) {
        changed();
        await settle();
      }
      if (!selected) {
        // A current dirty check verifies a background entry. Selected checks
        // make independent progress while their background request stays held.
        await settle();
        changed();
        await advance();
      }
      expect(model.getSnapshot()).toMatchObject({
        status: "streaming",
        selectedTargetId: "owned-0",
      });
      expect(model.getSnapshot().targets).toHaveLength(2);
      expect(controller.input).not.toBeNull();
    }
  },
);

it("does not renew inventory age from a delayed background proof's receipt", async () => {
  const fake = browser(2);
  const { model } = mount(fake, { windowId: 0, paused: true });
  await advance();
  const target = fake.targets[1]!;
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === target.id;
  await advance(9000);
  fake.sockets[0]!.emit("Target.targetInfoChanged", {
    targetInfo: info(target),
  });
  await advance(9000);
  expect(fake.heldCommands).toHaveLength(1);
  const held = fake.heldCommands.shift()!;
  // The positive reply is current, but it cannot renew the last full inventory.
  held.socket.reply(held.command, { windowId: 0 });
  await advance();
  expect(fake.heldCommands).toHaveLength(1);
  await advance(1999);
  expect(model.getSnapshot().status).toBe("paused");
  await advance(1);
  expect(model.getSnapshot()).toMatchObject({
    status: "unavailable",
    selectedTargetId: null,
    targets: [],
  });
});

it("drops an expired entry's deadline when that target is destroyed", async () => {
  const fake = browser(2);
  const { controller, model } = mount(fake);
  await advance();
  const target = fake.targets[1]!;
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === target.id;
  const changed = () =>
    fake.sockets[0]!.emit("Target.targetInfoChanged", {
      targetInfo: info(target),
    });
  const settle = async () => {
    expect(fake.heldCommands).toHaveLength(1);
    const held = fake.heldCommands.shift()!;
    held.socket.reply(held.command, { windowId: 0 });
    await advance();
  };
  await advance(9000);
  changed();
  await advance();
  await advance(1000);
  changed();
  await settle();
  changed();
  await settle();
  await advance(8000);
  fake.targets.pop();
  fake.sockets[0]!.emit("Target.targetDestroyed", { targetId: target.id });
  await settle();
  fake.holdCommand = (command) => command.method === "Target.getTargets";
  await advance(2000);
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    selectedTargetId: "owned-0",
    targets: [{ id: "owned-0", title: "Owned 0" }],
  });
  expect(controller.input).not.toBeNull();
  expect(fake.heldCommands).toHaveLength(1);
  expect(fake.heldCommands[0]!.command.method).toBe("Target.getTargets");
});

it("expires old inventory when dirty work delays the next full round", async () => {
  const fake = browser();
  const { controller, model } = mount(fake);
  await advance();
  controller.setPaused(true);
  await advance(9000);
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === "owned-1";
  fake.targets[1]!.title = "Updated";
  fake.sockets[0]!.emit("Target.targetInfoChanged", {
    targetInfo: info(fake.targets[1]!),
  });
  await advance(9900);
  expect(fake.heldCommands).toHaveLength(1);
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === "owned-2";
  const dirty = fake.heldCommands.shift()!;
  dirty.socket.reply(dirty.command, { windowId: 0 });
  await advance();
  expect(fake.heldCommands).toHaveLength(1);
  await advance(1099);
  expect(model.getSnapshot().status).toBe("paused");
  await advance(1);
  expect(model.getSnapshot()).toMatchObject({
    status: "unavailable",
    targets: [],
  });
  const full = fake.heldCommands.shift()!;
  full.socket.reply(full.command, { windowId: 0 });
  await advance();
  expect(model.getSnapshot().targets).toEqual([]);
});

it("does not resurrect an initially unknown destroyed target from a held bootstrap", async () => {
  const fake = browser(2);
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget";
  const { model } = mount(fake);
  await advance();
  expect(fake.heldCommands).toHaveLength(2);
  fake.targets.pop();
  fake.sockets[0]!.emit("Target.targetDestroyed", { targetId: "owned-1" });
  fake.holdCommand = null;
  for (const held of fake.heldCommands.splice(0))
    held.socket.reply(held.command, { windowId: 0 });
  await advance();
  expect(model.getSnapshot().targets.map((target) => target.id)).toEqual([
    "owned-0",
  ]);
});

it("does not let a full result overwrite newer metadata from its earlier batch", async () => {
  const fake = browser();
  const { model } = mount(fake);
  await advance();
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId === "owned-19";
  await advance(10_000);
  expect(fake.heldCommands).toHaveLength(1);
  fake.targets[0]!.title = "Newer title";
  fake.sockets[0]!.emit("Target.targetInfoChanged", {
    targetInfo: info(fake.targets[0]!),
  });
  fake.holdCommand = null;
  const held = fake.heldCommands.shift()!;
  held.socket.reply(held.command, { windowId: 0 });
  await advance();
  expect(model.getSnapshot().targets[0]!.title).toBe("Newer title");
});

it("drains large coalesced event inventories without starving selected input or checks", async () => {
  const fake = browser(1);
  const { controller, model } = mount(fake);
  await advance();
  const queries = count(fake, "Target.getTargets");
  fake.holdCommand = (command) =>
    command.method === "Browser.getWindowForTarget" &&
    command.params?.targetId !== "owned-0";
  for (let index = 0; index < 700; index++) {
    const target = { id: "new-" + index, title: "New", windowId: 0 };
    fake.targets.push(target);
    fake.sockets[0]!.emit("Target.targetCreated", {
      targetInfo: info(target),
    });
  }
  await advance(2000);
  expect(fake.heldCommands).toHaveLength(1);
  expect(
    fake.sockets[0]!.commands.filter(
      (command) => command.method === "Browser.getWindowForTarget",
    ).at(-1)?.params?.targetId,
  ).toBe("owned-0");
  controller.input!.text("Selected input");
  await advance();
  expect(count(fake, "Input.insertText")).toBe(1);
  while (fake.heldCommands.length) {
    expect(fake.heldCommands.length).toBeLessThanOrEqual(4);
    for (const held of fake.heldCommands.splice(0))
      held.socket.reply(held.command, { windowId: 0 });
    await advance();
  }
  expect(model.getSnapshot().targets).toHaveLength(701);
  expect(model.getSnapshot().status).toBe("streaming");
  expect(count(fake, "Target.getTargets")).toBe(queries);
  fake.targets.pop();
  fake.sockets[0]!.emit("Target.targetDestroyed", { targetId: "new-699" });
  expect(model.getSnapshot().targets).toHaveLength(700);
  expect(
    model.getSnapshot().targets.some((target) => target.id === "new-699"),
  ).toBe(false);
});

it("bounds retained event data by memory rather than target count and releases pending work", async () => {
  const fake = browser(1);
  const { model } = mount(fake);
  await advance();
  fake.holdMethod = "Browser.getWindowForTarget";
  const longId = "x".repeat(1024 * 1024);
  for (
    let index = 0;
    index < 9 && model.getSnapshot().status === "streaming";
    index++
  )
    fake.sockets[0]!.emit("Target.targetCreated", {
      targetInfo: { targetId: longId + index, type: "page", title: "New" },
    });
  await advance();
  expect(model.getSnapshot()).toMatchObject({
    status: "unavailable",
    targets: [],
    error: {
      kind: "protocol",
      message: "Browser target inventory exceeds the discovery memory budget.",
    },
  });
  expect(fake.heldCommands.length).toBeLessThanOrEqual(4);
  const queries = count(fake, "Browser.getWindowForTarget");
  for (const held of fake.heldCommands.splice(0))
    held.socket.reply(held.command, { windowId: 0 });
  await advance();
  expect(count(fake, "Browser.getWindowForTarget")).toBe(queries);
  expect(model.getSnapshot().targets).toEqual([]);
});

it("preserves more than 512 retirements against a late bootstrap response", async () => {
  const fake = browser(701);
  const listed = fake.targets.map(info);
  fake.holdMethod = "Target.getTargets";
  const { model } = mount(fake);
  await advance();
  expect(fake.heldCommands).toHaveLength(1);
  for (const target of fake.targets.slice(1))
    fake.sockets[0]!.emit("Target.targetDestroyed", { targetId: target.id });
  fake.targets = fake.targets.slice(0, 1);
  fake.holdMethod = null;
  const held = fake.heldCommands.shift()!;
  held.socket.reply(held.command, { targetInfos: listed });
  await advance();
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    targets: [{ id: "owned-0", title: "Owned 0" }],
  });
});

it.each([{ windowId: 0 }, {}])(
  "creates and selects a new tab from a large inventory %j",
  async (options) => {
    const fake = browser(600);
    const { controller, model } = mount(fake, options);
    await advance();
    expect(model.getSnapshot().targets).toHaveLength(600);
    controller.createTab();
    await advance();
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "new-1",
    });
    expect(model.getSnapshot().targets).toHaveLength(601);
  },
);

it("rejects retained initial data exceeding its memory budget before window lookups", async () => {
  const fake = browser(9);
  const longId = "x".repeat(1024 * 1024);
  for (const [index, target] of fake.targets.entries())
    target.id = longId + index;
  const { model } = mount(fake);
  await advance();
  expect(model.getSnapshot()).toMatchObject({
    status: "unavailable",
    targets: [],
    error: {
      kind: "protocol",
      message: "Browser target inventory exceeds the discovery memory budget.",
    },
  });
  expect(count(fake, "Browser.getWindowForTarget")).toBe(0);
});

it.each([{}, { targetInfos: null }, { targetInfos: {} }])(
  "still rejects malformed inventory shapes %j",
  async (result) => {
    const fake = browser(1);
    fake.holdMethod = "Target.getTargets";
    const { model } = mount(fake);
    await advance();
    const held = fake.heldCommands.shift()!;
    held.socket.reply(held.command, result);
    await advance();
    expect(model.getSnapshot()).toMatchObject({
      status: "unavailable",
      targets: [],
      error: { kind: "protocol", message: "Invalid browser target list." },
    });
  },
);

it("coalesces malformed events and releases only its own work on disconnect", async () => {
  const fake = browser();
  const first = mount(fake);
  const second = mount(fake);
  await advance();
  for (let index = 0; index < 10; index++)
    fake.sockets[0]!.emit("Target.targetInfoChanged", {});
  await advance();
  expect(first.model.getSnapshot().targets).toHaveLength(20);
  fake.sockets[0]!.close();
  const firstReads = fake.sockets[0]!.commands.length;
  await advance(20_000);
  expect(fake.sockets[0]!.commands).toHaveLength(firstReads);
  expect(second.model.getSnapshot().status).toBe("streaming");
  expect(count(fake, "Target.closeTarget")).toBe(0);
});

it("keeps superseded scans from failing a replacement during unrelated target churn", async () => {
  const fake = browser(2);
  const { controller, model } = mount(fake);
  await advance();
  fake.holdMethod = "Browser.getWindowForTarget";
  fake.sockets[0]!.emit("Target.targetInfoChanged", {});
  await advance();
  expect(fake.heldCommands).toHaveLength(2);
  fake.holdMethod = null;
  controller.closeTab("owned-0");
  await advance();
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    selectedTargetId: "owned-1",
  });
  for (let index = 0; index < 513; index++)
    fake.sockets[0]!.emit("Target.targetDestroyed", {
      targetId: "retired-worker-" + index,
    });
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    selectedTargetId: "owned-1",
  });
  for (const held of fake.heldCommands.splice(0)) {
    if (held.command.params?.targetId === "owned-0")
      held.socket.reject(held.command, -32000);
    else held.socket.reply(held.command, { windowId: 0 });
  }
  await advance();
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    selectedTargetId: "owned-1",
    error: null,
  });
});
