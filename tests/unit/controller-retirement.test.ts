import { afterEach, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";
import { NativeInput } from "../../src/input/native";
import type { InputTransition } from "../../src/input/lifecycle";

const controllers: ViewerController[] = [];
const adapters: NativeInput[] = [];
afterEach(() => {
  adapters.splice(0).forEach((adapter) => adapter.dispose());
  controllers.splice(0).forEach((controller) => controller.close());
  document.body.replaceChildren();
});

async function mount(
  callbacks: {
    onInputReset?: (reason: InputTransition) => void;
    onClipboardReset?: () => void;
  } = {},
) {
  const browser = new FakeBrowser();
  browser.targets[1]!.windowId = 0;
  const model = createViewerModel();
  const controller = new ViewerController(
    model,
    {
      push: (_data, paint) => paint({ width: 800, height: 600 }),
      reset() {},
      dispose() {},
    },
    {
      url: "wss://fixture.invalid/",
      windowId: 0,
      interactive: true,
      socketFactory: browser.factory,
      ...callbacks,
    },
  );
  controllers.push(controller);
  controller.start();
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  return { browser, model, controller, socket: browser.sockets[0]! };
}

it("waits for original retirement before same-target reuse while another target progresses", async () => {
  const { browser, controller, model, socket } = await mount();
  const old = controller.input!;
  browser.holdMethod = "Input.imeSetComposition";
  old.preedit("n", old.owner!);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.select("page-b");
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  expect(
    socket.commands.filter(
      (c) =>
        c.method === "Page.stopScreencast" && c.sessionId === old.sessionId,
    ),
  ).toHaveLength(1);
  expect(
    socket.commands.some(
      (c) =>
        c.method === "Target.detachFromTarget" &&
        c.params?.sessionId === old.sessionId,
    ),
  ).toBe(false);
  const other = controller.input!;
  other.text("independent target");
  await other.completion(other.owner!);
  expect(
    socket.commands.find((c) => c.method === "Input.insertText"),
  ).toMatchObject({
    sessionId: other.sessionId,
    params: { text: "independent target" },
  });
  controller.select("page-a");
  await vi.waitFor(() =>
    expect(
      socket.commands.some(
        (c) =>
          c.method === "Target.detachFromTarget" &&
          c.params?.sessionId === other.sessionId,
      ),
    ).toBe(true),
  );
  expect(controller.input).toBeNull();
  expect(
    socket.commands.filter(
      (c) =>
        c.method === "Target.attachToTarget" && c.params?.targetId === "page-a",
    ),
  ).toHaveLength(1);
  browser.holdMethod = null;
  for (const held of browser.heldCommands) held.socket.reply(held.command);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  expect(controller.input!.sessionId).not.toBe(old.sessionId);
  expect(
    socket.commands.filter(
      (c) =>
        c.method === "Page.stopScreencast" && c.sessionId === old.sessionId,
    ),
  ).toHaveLength(1);
  expect(
    socket.commands.filter(
      (c) =>
        c.method === "Target.attachToTarget" && c.params?.targetId === "page-a",
    ),
  ).toHaveLength(2);
  expect(
    socket.commands.filter(
      (c) =>
        c.method === "Target.detachFromTarget" &&
        c.params?.sessionId === old.sessionId,
    ),
  ).toHaveLength(1);
});

it.each([false, true])(
  "denies same-target reuse after failed cleanup (navigation: %s) without blocking another target",
  async (navigation) => {
    const { browser, controller, model, socket } = await mount();
    const old = controller.input!;
    old.key({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
    await old.completion(old.owner!);
    browser.holdMethod = "Input.dispatchKeyEvent";
    controller.select("page-b");
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const release = browser.heldCommands[0]!;
    expect(release.command).toMatchObject({
      sessionId: old.sessionId,
      params: { type: "keyUp" },
    });
    if (navigation)
      socket.emit(
        "Page.navigatedWithinDocument",
        { frameId: "main", url: "https://fixture.invalid/#section" },
        old.sessionId,
      );
    browser.holdMethod = null;
    release.socket.reject(release.command, -32000);
    await vi.waitFor(() =>
      expect(
        socket.commands.some(
          (c) =>
            c.method === "Target.detachFromTarget" &&
            c.params?.sessionId === old.sessionId,
        ),
      ).toBe(true),
    );
    controller.select("page-a");
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe("error"));
    expect(controller.input).toBeNull();
    expect(
      socket.commands.filter(
        (c) =>
          c.method === "Target.attachToTarget" &&
          c.params?.targetId === "page-a",
      ),
    ).toHaveLength(1);
    controller.select("page-b");
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const other = controller.input!;
    other.text("still usable");
    await other.completion(other.owner!);
    expect(
      socket.commands
        .filter((c) => c.method === "Input.insertText")
        .map((c) => c.params?.text),
    ).toEqual(["still usable"]);
  },
);

it.each(["Page.navigatedWithinDocument", "Page.frameStartedNavigating"])(
  "retains cleanup across %s before reusing the target",
  async (method) => {
    const { browser, controller, model, socket } = await mount();
    const old = controller.input!;
    old.key({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
    await old.completion(old.owner!);
    browser.holdMethod = "Input.dispatchKeyEvent";
    controller.select("page-b");
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    socket.emit(
      method,
      { frameId: "main", url: "https://fixture.invalid/#section" },
      old.sessionId,
    );
    const other = controller.input!;
    other.text("independent navigation");
    await other.completion(other.owner!);
    expect(
      socket.commands.some(
        (c) =>
          c.method === "Target.detachFromTarget" &&
          c.params?.sessionId === old.sessionId,
      ),
    ).toBe(false);
    browser.holdMethod = null;
    const release = browser.heldCommands[0]!;
    release.socket.reply(release.command);
    await vi.waitFor(() =>
      expect(
        socket.commands.some(
          (c) =>
            c.method === "Target.detachFromTarget" &&
            c.params?.sessionId === old.sessionId,
        ),
      ).toBe(true),
    );
    controller.select("page-a");
    await vi.waitFor(() =>
      expect(model.getSnapshot()).toMatchObject({
        status: "streaming",
        selectedTargetId: "page-a",
      }),
    );
    expect(controller.input!.sessionId).not.toBe(old.sessionId);
  },
);

it("joins late preedit cleanup after same-document navigation before target reuse", async () => {
  const { browser, controller, model, socket } = await mount();
  const old = controller.input!;
  browser.holdMethod = "Input.imeSetComposition";
  old.preedit("n", old.owner!);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.select("page-b");
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  socket.emit(
    "Page.navigatedWithinDocument",
    { frameId: "main", url: "https://fixture.invalid/#section" },
    old.sessionId,
  );
  const other = controller.input!;
  other.text("independent preedit");
  await other.completion(other.owner!);
  controller.select("page-a");
  expect(controller.input).toBeNull();
  const preedit = browser.heldCommands[0]!;
  preedit.socket.reply(preedit.command);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(3));
  const cleanup = browser.heldCommands[1]!;
  cleanup.socket.reply(cleanup.command);
  const lateCleanup = browser.heldCommands[2]!;
  expect(lateCleanup.command).toMatchObject({
    sessionId: old.sessionId,
    method: "Input.imeSetComposition",
    params: { text: "" },
  });
  await vi.waitFor(() =>
    expect(
      socket.commands.some(
        (c) =>
          c.method === "Target.detachFromTarget" &&
          c.params?.sessionId === other.sessionId,
      ),
    ).toBe(true),
  );
  expect(
    socket.commands.some(
      (c) =>
        c.method === "Target.detachFromTarget" &&
        c.params?.sessionId === old.sessionId,
    ),
  ).toBe(false);
  expect(
    socket.commands.filter(
      (c) =>
        c.method === "Target.attachToTarget" && c.params?.targetId === "page-a",
    ),
  ).toHaveLength(1);
  browser.holdMethod = null;
  lateCleanup.socket.reply(lateCleanup.command);
  await vi.waitFor(() =>
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "page-a",
    }),
  );
  expect(controller.input!.sessionId).not.toBe(old.sessionId);
});

it("keeps retiring-session document events from granting late preedit cleanup a new document", async () => {
  const { browser, controller, model, socket } = await mount();
  const old = controller.input!;
  browser.holdMethod = "Input.imeSetComposition";
  old.preedit("n", old.owner!);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.select("page-b");
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  socket.emit(
    "Page.frameNavigated",
    { frame: { id: "replacement-document" } },
    old.sessionId,
  );
  const other = controller.input!;
  other.text("current owner");
  await other.completion(other.owner!);
  expect(
    socket.commands.some(
      (c) =>
        c.method === "Target.detachFromTarget" &&
        c.params?.sessionId === old.sessionId,
    ),
  ).toBe(false);
  browser.holdMethod = null;
  for (const held of browser.heldCommands) held.socket.reply(held.command);
  await vi.waitFor(() =>
    expect(
      socket.commands.some(
        (c) =>
          c.method === "Target.detachFromTarget" &&
          c.params?.sessionId === old.sessionId,
      ),
    ).toBe(true),
  );
  expect(
    socket.commands.filter((c) => c.method === "Input.imeSetComposition"),
  ).toHaveLength(2);
  expect(model.getSnapshot()).toMatchObject({
    status: "streaming",
    selectedTargetId: "page-b",
  });
});

it("keeps late retirement callbacks from resetting the current native composition", async () => {
  let adapter: NativeInput | undefined;
  const { browser, controller, model, socket } = await mount({
    onInputReset: (reason) => adapter?.reset(reason),
    onClipboardReset: () => adapter?.clearClipboard(),
  });
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  const proxy = document.createElement("textarea");
  stage.append(canvas, proxy);
  document.body.append(stage);
  adapter = new NativeInput(
    canvas,
    proxy,
    () => controller.input,
    () => {},
  );
  adapters.push(adapter);
  const old = controller.input!;
  browser.holdMethod = "Input.imeSetComposition";
  old.preedit("held", old.owner!);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.select("page-b");
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  browser.holdMethod = null;
  const current = controller.input!;
  proxy.focus();
  proxy.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  proxy.value = "current preedit";
  proxy.setSelectionRange(proxy.value.length, proxy.value.length);
  proxy.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      isComposing: true,
      inputType: "insertCompositionText",
    }),
  );
  await vi.waitFor(() =>
    expect(
      socket.commands.some(
        (c) =>
          c.method === "Input.imeSetComposition" &&
          c.sessionId === current.sessionId &&
          c.params?.text === "current preedit",
      ),
    ).toBe(true),
  );
  for (const held of browser.heldCommands) held.socket.reply(held.command);
  await vi.waitFor(() =>
    expect(
      socket.commands.some(
        (c) =>
          c.method === "Target.detachFromTarget" &&
          c.params?.sessionId === old.sessionId,
      ),
    ).toBe(true),
  );
  expect(document.activeElement).toBe(proxy);
  expect(proxy.value).toBe("current preedit");
  proxy.value = "current commit";
  const end = new Event("compositionend", { bubbles: true });
  Object.defineProperty(end, "data", { value: "current commit" });
  proxy.dispatchEvent(end);
  await current.completion(current.owner!);
  expect(
    socket.commands.filter((c) => c.method === "Input.insertText"),
  ).toEqual([
    expect.objectContaining({
      sessionId: current.sessionId,
      params: { text: "current commit" },
    }),
  ]);
});

it("invalidates a prepared input owner synchronously when selection changes", async () => {
  let lossMark: number | undefined;
  const { controller, model, socket } = await mount({
    onInputReset: (reason) => {
      if (reason === "target-replaced") lossMark = socket.commands.length;
    },
  });
  const old = controller.input!;
  old.key({ type: "rawKeyDown", key: "Backspace", code: "Backspace" });
  queueMicrotask(() => queueMicrotask(() => controller.select("page-b")));
  await vi.waitFor(() =>
    expect(model.getSnapshot()).toMatchObject({
      status: "streaming",
      selectedTargetId: "page-b",
    }),
  );
  expect(lossMark).toBeDefined();
  expect(
    socket.commands
      .slice(lossMark)
      .filter(
        (c) =>
          c.sessionId === old.sessionId &&
          c.method === "Input.dispatchKeyEvent" &&
          c.params?.type !== "keyUp",
      ),
  ).toEqual([]);
});
