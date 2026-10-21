import { afterEach, expect, it, vi } from "vitest";
import { CdpClient } from "../../src/cdp/client";
import { InputSession } from "../../src/input/session";
import { createViewerModel } from "../../src/viewer/model";
import { FakeSocket } from "./wire";
import type { WireCommand } from "./wire";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((close) => close());
  vi.useRealTimers();
});

async function fixture(requestTimeout = 1000) {
  const held: WireCommand[] = [];
  let hold = "";
  const socket = new FakeSocket((command, wire) => {
    queueMicrotask(() => {
      if (command.method === hold) {
        held.push(command);
        return;
      }
      if (
        command.method === "Runtime.evaluate" &&
        !String(command.params?.expression).startsWith(
          "/* cdp-viewer selection */",
        )
      ) {
        wire.reply(command, { result: { type: "object", value: null } });
        return;
      }
      const results: Record<string, object> = {
        "Page.getFrameTree": { frameTree: { frame: { id: "main" } } },
        "Page.getNavigationHistory": { entries: [], currentIndex: -1 },
        "Page.createIsolatedWorld": { executionContextId: 19 },
        "Runtime.evaluate": {
          result: { type: "object", objectId: "selection-1" },
        },
        "Runtime.callFunctionOn": {
          result: {
            type: "object",
            value: { status: "ok", text: "owned text" },
          },
        },
      };
      wire.reply(command, results[command.method] ?? {});
    });
  });
  const client = new CdpClient(
    "wss://fixture.invalid",
    () => socket.asWebSocket(),
    requestTimeout,
  );
  socket.open();
  await client.opened;
  const error = vi.fn();
  const input = new InputSession(
    client,
    "session",
    async () => true,
    () => {},
    () => {},
    () => {},
    error,
  );
  cleanup.push(() => {
    input.dispose();
    client.close();
  });
  await input.start();
  return {
    input,
    socket,
    held,
    error,
    hold: (method: string) => {
      hold = method;
    },
  };
}

it("waits for earlier selection/edit acknowledgements and releases the snapshot", async () => {
  const { input, socket, held, hold } = await fixture();
  hold("Input.dispatchKeyEvent");
  input.key({ type: "rawKeyDown", key: "a", commands: ["selectAll"] });
  await vi.waitFor(() => expect(held).toHaveLength(1));
  const read = input.selection(input.owner!);
  expect(
    socket.commands.filter((c) => c.method === "Page.createIsolatedWorld"),
  ).toHaveLength(0);
  socket.reply(held[0]!);
  await expect(read).resolves.toEqual({ status: "ok", text: "owned text" });
  expect(
    socket.commands.filter((c) => c.method === "Runtime.releaseObject"),
  ).toMatchObject([
    { sessionId: "session", params: { objectId: "selection-1" } },
  ]);
  expect(
    socket.commands.find((c) => c.method === "Page.createIsolatedWorld")!
      .params,
  ).not.toHaveProperty("grantUniveralAccess");
});

it.each(["blur", "navigation", "target replacement"] as const)(
  "settles a queued read immediately on %s even while an earlier ack is held",
  async (transition) => {
    const { input, socket, held, hold } = await fixture();
    hold("Input.insertText");
    input.text("previous");
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const read = input.selection(input.owner!);
    const rejected = expect(read).rejects.toThrow("cancelled");
    if (transition === "blur") input.blur();
    else if (transition === "navigation") input.navigate("reload");
    else input.dispose("target-replaced");
    await rejected;
    socket.reply(held[0]!);
    expect(
      socket.commands.filter((c) => c.method === "Page.createIsolatedWorld"),
    ).toHaveLength(0);
  },
);

it("releases a late captured handle through its original session after blur", async () => {
  const { input, socket, held, hold } = await fixture();
  hold("Runtime.evaluate");
  const read = input.selection(input.owner!);
  const rejected = expect(read).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(held).toHaveLength(1));
  input.blur();
  await rejected;
  socket.reply(held[0]!, {
    result: { type: "object", objectId: "late-selection" },
  });
  await vi.waitFor(() =>
    expect(socket.commands).toContainEqual(
      expect.objectContaining({
        method: "Runtime.releaseObject",
        sessionId: "session",
        params: { objectId: "late-selection" },
      }),
    ),
  );
  expect(
    socket.commands.filter((c) => c.method === "Runtime.callFunctionOn"),
  ).toHaveLength(0);
});

it("rejects a child-navigation read without resetting otherwise usable input", async () => {
  const { input, socket, held, hold, error } = await fixture();
  hold("Runtime.evaluate");
  const read = input.selection(input.owner!);
  const rejected = expect(read).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(held).toHaveLength(1));
  input.event({
    method: "Page.frameNavigated",
    sessionId: "session",
    params: { frame: { id: "child", parentId: "main" } },
  });
  socket.reply(held[0]!, {
    result: { type: "object", objectId: "child-selection" },
  });
  await rejected;
  expect(error).not.toHaveBeenCalled();
  input.text("next");
  await vi.waitFor(() =>
    expect(socket.commands).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "next" },
      }),
    ),
  );
});

it("handles unsupported selection commands without changing the input owner", async () => {
  const { input, socket, held, hold, error } = await fixture();
  hold("Page.createIsolatedWorld");
  const owner = input.owner!;
  const read = input.selection(owner);
  const rejected = expect(read).rejects.toThrow();
  await vi.waitFor(() => expect(held).toHaveLength(1));
  socket.reject(held[0]!);
  await rejected;
  expect(input.owner).toBe(owner);
  expect(error).not.toHaveBeenCalled();
});

it("settles a timed-out selection and releases a handle arriving after its deadline", async () => {
  vi.useFakeTimers();
  const { input, socket, held, hold, error } = await fixture(50);
  hold("Runtime.evaluate");
  const owner = input.owner!;
  const read = input.selection(owner);
  const rejected = expect(read).rejects.toThrow("timed out");
  await vi.waitFor(() => expect(held).toHaveLength(1), {
    interval: 1,
    timeout: 20,
  });
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  socket.reply(held[0]!, {
    result: { type: "object", objectId: "after-deadline" },
  });
  await vi.waitFor(
    () =>
      expect(socket.commands).toContainEqual(
        expect.objectContaining({
          method: "Runtime.releaseObject",
          sessionId: "session",
          params: { objectId: "after-deadline" },
        }),
      ),
    { interval: 1, timeout: 20 },
  );
  expect(input.owner).toBe(owner);
  expect(error).not.toHaveBeenCalled();
});

it("leaves exceptional result handles with the queue's cleanup owner", async () => {
  const { input, socket, held, hold, error } = await fixture();
  hold("Runtime.evaluate");
  const read = input.selection(input.owner!);
  const rejected = expect(read).rejects.toThrow("Selection unavailable");
  await vi.waitFor(() => expect(held).toHaveLength(1));
  socket.reply(held[0]!, {
    result: { type: "object", objectId: "exception-result" },
    exceptionDetails: {
      exception: { type: "object", objectId: "exception-detail" },
    },
  });
  await rejected;
  const released = socket.commands
    .filter((command) => command.method === "Runtime.releaseObject")
    .map((command) => command.params!.objectId);
  expect(released).toEqual(["exception-result", "exception-detail"]);
  expect(error).not.toHaveBeenCalled();
});

it("keeps recovery text private and isolated from status snapshots and sibling models", () => {
  const first = createViewerModel();
  const second = createViewerModel();
  const status = vi.fn();
  const unsubscribe = first.subscribe(status);
  const old = first.getSnapshot();
  first.run(first.setClipboard$, {
    text: "owned recovery",
    message: "Copy manually",
  });
  expect(first.getSnapshot()).toBe(old);
  expect(status).not.toHaveBeenCalled();
  expect(second.read(second.clipboard$)).toBeNull();
  first.transition({ type: "reset" });
  expect(first.read(first.clipboard$)).toBeNull();
  unsubscribe();
});

it("preserves clipboard diagnostics through shortcut release until a new input action", async () => {
  const { input, socket, error } = await fixture();
  input.clipboardError("Clipboard text exceeds the supported size.");
  input.key({ type: "keyUp", key: "Control", code: "ControlLeft" });
  await vi.waitFor(() =>
    expect(socket.commands).toContainEqual(
      expect.objectContaining({ method: "Input.dispatchKeyEvent" }),
    ),
  );
  expect(error).toHaveBeenCalledTimes(1);
  expect(error.mock.calls[0]![0]).toMatchObject({
    message: "Clipboard text exceeds the supported size.",
  });
  input.text("next owned input");
  await vi.waitFor(() => expect(error).toHaveBeenLastCalledWith(null));
});
