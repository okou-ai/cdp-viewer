import { afterEach, expect, it, vi } from "vitest";
import { CdpClient } from "../../src/cdp/client";
import { CdpFault } from "../../src/cdp/errors";
import { InputSession } from "../../src/input/session";
import { FakeBrowser } from "./wire";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((close) => close());
});

function history(url = "https://fixture.invalid/current", currentIndex = 1) {
  return {
    currentIndex,
    entries: [
      { id: 11, url: "https://fixture.invalid/previous", title: "Previous" },
      { id: 22, url, title: "Current" },
      { id: 33, url: "https://fixture.invalid/next", title: "Next" },
    ],
  };
}

async function fixture({
  windowId,
  holdHistory = false,
  browser = new FakeBrowser(),
}: {
  windowId?: number;
  holdHistory?: boolean;
  browser?: FakeBrowser;
} = {}) {
  if (holdHistory) browser.holdMethod = "Page.getNavigationHistory";
  const client = new CdpClient("wss://fixture.invalid", browser.factory);
  await client.opened;
  const socket = browser.sockets.at(-1)!;
  const sessionId = `session-${browser.sockets.length}`;
  const changed = vi.fn();
  const error = vi.fn();
  const input = new InputSession(
    client,
    sessionId,
    async () => {
      if (windowId !== undefined) {
        const result = await client.request("Browser.getWindowForTarget", {
          targetId: windowId === 2 ? "page-b" : "page-a",
        });
        if (result.windowId !== windowId)
          throw new CdpFault("scope", "Target left the selected window.");
      }
      return true;
    },
    changed,
    () => {},
    () => {},
    error,
  );
  cleanup.push(() => {
    input.dispose();
    client.close();
  });
  const held = () =>
    browser.heldCommands.filter(
      (value) =>
        value.socket === socket &&
        value.command.method === "Page.getNavigationHistory",
    );
  const event = (method = "Page.loadEventFired", params: object = {}) =>
    input.event({ method, params: { ...params }, sessionId });
  await input.start();
  if (holdHistory) await vi.waitFor(() => expect(held()).toHaveLength(1));
  else await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  changed.mockClear();
  return {
    browser,
    client,
    socket,
    input,
    changed,
    error,
    held,
    event,
    // A later peer reply synchronizes prior history-response continuations.
    settled: () => client.request("Browser.getVersion", undefined),
  };
}

it.each([undefined, 0])(
  "sends ordered native input while optional history is pending (window %s)",
  async (windowId) => {
    const { socket, input, held, error } = await fixture({
      ...(windowId === undefined ? {} : { windowId }),
      holdHistory: true,
    });
    input.key({ type: "rawKeyDown", key: "a", code: "KeyA" });
    input.text("text");
    input.pointer(
      "mousePressed",
      { x: 0.25, y: 0.5 },
      { button: "left", buttons: 1 },
    );
    input.key({ type: "keyUp", key: "a", code: "KeyA" });
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method.startsWith("Input.")),
      ).toHaveLength(4),
    );
    expect(
      socket.commands
        .filter((c) => c.method.startsWith("Input."))
        .map((c) => [c.method, c.params?.type]),
    ).toEqual([
      ["Input.dispatchKeyEvent", "rawKeyDown"],
      ["Input.insertText", undefined],
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchKeyEvent", "keyUp"],
    ]);
    expect(held()).toHaveLength(1);
    expect(error).not.toHaveBeenCalledWith(expect.any(CdpFault));
  },
);

it("does not serialize input behind an optional window lookup", async () => {
  const { browser, socket, input, event } = await fixture({ windowId: 0 });
  browser.holdMethod = "Browser.getWindowForTarget";
  event();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  browser.holdMethod = null;
  input.text("freshly guarded input");
  await vi.waitFor(() =>
    expect(socket.commands.some((c) => c.method === "Input.insertText")).toBe(
      true,
    ),
  );
  expect(
    socket.commands.filter((c) => c.method === "Browser.getWindowForTarget"),
  ).toHaveLength(3);
  const pending = browser.heldCommands[0]!;
  pending.socket.reply(pending.command, { windowId: 0 });
});

it("keeps one active read and the newest refresh without publishing superseded UI", async () => {
  const { socket, held, event, changed, settled } = await fixture({
    holdHistory: true,
  });
  for (let index = 0; index < 100; index++) event();
  await settled();
  expect(held()).toHaveLength(1);
  socket.reply(held()[0]!.command, history("https://fixture.invalid/stale"));
  await vi.waitFor(() => expect(held()).toHaveLength(2));
  expect(changed).not.toHaveBeenCalled();
  socket.reply(held()[1]!.command, history());
  await vi.waitFor(() =>
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      url: "https://fixture.invalid/current",
      canGoBack: true,
      canGoForward: true,
    }),
  );
  expect(held()).toHaveLength(2);
});

it("replaces a superseded scope lookup with the latest refresh before reading history", async () => {
  const { browser, socket, event, changed } = await fixture({ windowId: 0 });
  browser.holdMethod = "Browser.getWindowForTarget";
  event();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  event();
  const previous = browser.heldCommands[0]!;
  previous.socket.reply(previous.command, { windowId: 0 });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
  expect(
    socket.commands.filter((c) => c.method === "Page.getNavigationHistory"),
  ).toHaveLength(1);
  const latest = browser.heldCommands[1]!;
  browser.holdMethod = null;
  latest.socket.reply(latest.command, { windowId: 0 });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
});

it("refreshes the new focus owner after blur instead of losing initial navigation UI", async () => {
  const { input, socket, held, changed } = await fixture({ holdHistory: true });
  input.blur();
  socket.reply(held()[0]!.command, history("https://fixture.invalid/stale"));
  await vi.waitFor(() => expect(held()).toHaveLength(2));
  expect(changed).not.toHaveBeenCalled();
  socket.reply(held()[1]!.command, history());
  await vi.waitFor(() =>
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://fixture.invalid/current" }),
    ),
  );
});

it.each([
  ["Page.frameStartedNavigating", { frameId: "main" }],
  ["Page.frameNavigated", { frame: { id: "main" } }],
  ["Page.navigatedWithinDocument", { frameId: "main" }],
  ["Runtime.executionContextsCleared", {}],
] as const)("rejects late history after %s", async (method, params) => {
  const { socket, held, event, changed, settled } = await fixture({
    holdHistory: true,
  });
  event(method, params);
  changed.mockClear();
  socket.reply(held()[0]!.command, history("https://fixture.invalid/stale"));
  await settled();
  expect(changed).not.toHaveBeenCalled();
  event();
  await vi.waitFor(() => expect(held()).toHaveLength(2));
  socket.reply(held()[1]!.command, history());
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
});

it.each(["target-replaced", "paused", "disconnected", "disposed"] as const)(
  "rejects late history after %s",
  async (reason) => {
    const { input, socket, held, changed, settled } = await fixture({
      holdHistory: true,
    });
    input.dispose(reason);
    changed.mockClear();
    socket.reply(held()[0]!.command, history("https://fixture.invalid/stale"));
    await settled();
    expect(changed).not.toHaveBeenCalled();
    expect(held()).toHaveLength(1);
  },
);

it("keeps optional history failure separate from input and its current diagnostic", async () => {
  const { input, socket, held, error } = await fixture({ holdHistory: true });
  input.clipboardError("Existing clipboard diagnostic");
  socket.reject(held()[0]!.command, -32000);
  input.key({ type: "keyUp", key: "Shift", code: "ShiftLeft" });
  await vi.waitFor(() =>
    expect(
      socket.commands.some((c) => c.method === "Input.dispatchKeyEvent"),
    ).toBe(true),
  );
  expect(error).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: "Existing clipboard diagnostic" }),
  );
  input.text("still works");
  await vi.waitFor(() =>
    expect(socket.commands.some((c) => c.method === "Input.insertText")).toBe(
      true,
    ),
  );
});

it("keeps required input scope failures while ignoring optional lookup failures", async () => {
  const { browser, event, input, error, settled } = await fixture({
    windowId: 0,
  });
  browser.unsupportedWindows = true;
  event();
  await settled();
  expect(error).not.toHaveBeenCalled();
  input.text("must remain guarded");
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
});

it("retains the newest requested refresh when the active history read fails", async () => {
  const { socket, held, event, changed, error } = await fixture({
    holdHistory: true,
  });
  event();
  socket.reject(held()[0]!.command, -32000);
  await vi.waitFor(() => expect(held()).toHaveLength(2));
  socket.reply(held()[1]!.command, history());
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(error).not.toHaveBeenCalled();
});

it("refreshes navigation UI after input failure without replaying the failed input", async () => {
  const { browser, input, socket, held, changed, error } = await fixture({
    holdHistory: true,
  });
  browser.holdMethod = "Input.insertText";
  input.text("uncertain input");
  await vi.waitFor(() =>
    expect(
      browser.heldCommands.some((c) => c.command.method === "Input.insertText"),
    ).toBe(true),
  );
  const pending = browser.heldCommands.find(
    (c) => c.command.method === "Input.insertText",
  )!;
  socket.reject(pending.command, -32000);
  await vi.waitFor(() =>
    expect(error).toHaveBeenCalledWith(expect.any(CdpFault)),
  );
  const fault = error.mock.calls.at(-1)?.[0];
  browser.holdMethod = "Page.getNavigationHistory";
  socket.reply(held()[0]!.command, history("https://fixture.invalid/stale"));
  await vi.waitFor(() => expect(held()).toHaveLength(2));
  expect(changed).not.toHaveBeenCalled();
  socket.reply(held()[1]!.command, history());
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(error.mock.calls.at(-1)?.[0]).toBe(fault);
  expect(
    socket.commands.filter((c) => c.method === "Input.insertText"),
  ).toHaveLength(1);
});

it("clears obsolete navigation UI when current history is empty", async () => {
  const { browser, socket, held, event, changed } = await fixture();
  browser.holdMethod = "Page.getNavigationHistory";
  event();
  await vi.waitFor(() => expect(held()).toHaveLength(1));
  socket.reply(held()[0]!.command, { entries: [], currentIndex: -1 });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(null));
});

it.each(["back", "forward"] as const)(
  "%s waits for preceding input and reads current action history independently",
  async (action) => {
    const { browser, input, socket, held } = await fixture({
      windowId: 0,
      holdHistory: true,
    });
    browser.holdMethod = "Input.insertText";
    input.text("previous input");
    await vi.waitFor(() =>
      expect(
        browser.heldCommands.filter(
          (c) => c.command.method === "Input.insertText",
        ),
      ).toHaveLength(1),
    );
    const pending = browser.heldCommands.find(
      (c) => c.command.method === "Input.insertText",
    )!;
    browser.holdMethod = "Page.getNavigationHistory";
    input.navigate(action);
    expect(held()).toHaveLength(1);
    socket.reply(pending.command);
    await vi.waitFor(() => expect(held()).toHaveLength(2));
    socket.reply(held()[1]!.command, history());
    await vi.waitFor(() =>
      expect(
        socket.commands.find((c) => c.method === "Page.navigateToHistoryEntry")
          ?.params,
      ).toEqual({ entryId: action === "back" ? 11 : 33 }),
    );
  },
);

it("keeps different-window viewers independent while one history owner is disposed", async () => {
  const browser = new FakeBrowser();
  const a = await fixture({ browser, windowId: 0, holdHistory: true });
  const b = await fixture({ browser, windowId: 2, holdHistory: true });
  b.socket.reply(b.held()[0]!.command, history());
  await vi.waitFor(() => expect(b.changed).toHaveBeenCalledOnce());
  a.input.dispose();
  a.client.close();
  b.input.text("sibling survives");
  await vi.waitFor(() =>
    expect(b.socket.commands.some((c) => c.method === "Input.insertText")).toBe(
      true,
    ),
  );
  a.socket.reply(
    a.held()[0]!.command,
    history("https://fixture.invalid/stale"),
  );
  await b.settled();
  expect(a.changed.mock.calls).toEqual([[null]]);
  expect(b.changed).toHaveBeenCalledOnce();
  expect(
    browser.sockets
      .flatMap((s) => s.commands)
      .some((c) => ["Browser.close", "Target.closeTarget"].includes(c.method)),
  ).toBe(false);
});
