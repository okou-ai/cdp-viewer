import { afterEach, expect, it, vi } from "vitest";
import { ProbeHost } from "../experiments/probe-host";
import type { ProbeReply } from "../experiments/guarded-probe";
import type { NativeAction } from "../experiments/native-actions";
import { FakeBrowser } from "./wire";
import type { FakeSocket, WireCommand } from "./wire";

const hosts: ProbeHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

async function fixture() {
  const browser = new FakeBrowser();
  const snapshots: { command: WireCommand; socket: FakeSocket }[] = [];
  let holdSelection = false;
  let text = "owned selection";
  let object = 0;
  const host = new ProbeHost("wss://fixture.invalid", (url) => {
    const socket = browser.factory(url) as unknown as FakeSocket;
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      const command = JSON.parse(raw) as WireCommand;
      if (
        command.method === "Runtime.evaluate" &&
        String(command.params?.expression).startsWith(
          "/* cdp-viewer selection */",
        )
      ) {
        socket.commands.push(command);
        snapshots.push({ command, socket });
        if (!holdSelection)
          queueMicrotask(() =>
            socket.reply(command, {
              result: { objectId: "selection-" + ++object },
            }),
          );
      } else if (
        command.method === "Runtime.callFunctionOn" &&
        String(command.params?.objectId).startsWith("selection-")
      ) {
        socket.commands.push(command);
        queueMicrotask(() =>
          socket.reply(command, { result: { value: { status: "ok", text } } }),
        );
      } else send(raw);
    };
    return socket.asWebSocket();
  });
  hosts.push(host);
  const replies: ProbeReply[] = [];
  const next = new Map<string, number>();
  const confirmed = new Map<string, number>();
  const completed = new Map<string, Set<number>>();
  const probe = await host.admit({
    targetId: "page-a",
    windowId: 0,
    mode: "composition",
    reply: (value) => {
      replies.push(value);
      if (value.type === "ack" && value.generation) {
        let values = completed.get(value.generation);
        if (!values) completed.set(value.generation, (values = new Set()));
        values.add(value.sequence);
        let through = confirmed.get(value.generation) ?? 0;
        while (values.delete(through + 1)) through++;
        confirmed.set(value.generation, through);
      }
    },
  });
  const send = (
    actions: NativeAction[],
    generation = probe.generation,
    acknowledged = confirmed.get(generation) ?? 0,
  ) => {
    const sequence = (next.get(generation) ?? 0) + 1;
    next.set(generation, sequence);
    return probe.receive(
      JSON.stringify({
        kind: "batch",
        owner: probe.owner,
        generation,
        sequence,
        acknowledged,
        actions,
      }),
    );
  };
  return {
    browser,
    host,
    probe,
    replies,
    snapshots,
    send,
    socket: browser.sockets[0]!,
    hold: () => {
      holdSelection = true;
    },
    text: (value: string) => {
      text = value;
    },
    selection: () => replies.filter((r) => r.type === "selection"),
    ready: () => replies.filter((r) => r.type === "ready"),
    acks: () => replies.filter((r) => r.type === "ack"),
  };
}

it("orders selection after prior native replies and tags earlier edit invalidation before the new copy", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Input.insertText";
  expect(
    a.send([
      { kind: "text", text: "before" },
      { kind: "selection", request: 1 },
    ]),
  ).toBe(true);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  expect(a.snapshots).toHaveLength(0);
  expect(a.replies).toContainEqual({
    type: "clipboard-reset",
    generation: a.probe.generation,
    through: 0,
  });
  const write = a.browser.heldCommands[0]!;
  write.socket.reply(write.command);
  await vi.waitFor(() => expect(a.selection()).toHaveLength(1));
  expect(a.selection()[0]).toEqual({
    type: "selection",
    generation: a.probe.generation,
    request: 1,
    result: { status: "ok", text: "owned selection" },
  });
  expect(
    a.socket.commands.filter((c) => c.method === "Runtime.releaseObject"),
  ).toHaveLength(1);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
});

it("supersedes a held selection without returning its text and releases its original object", async () => {
  const a = await fixture();
  a.hold();
  a.send([{ kind: "selection", request: 1 }]);
  await vi.waitFor(() => expect(a.snapshots).toHaveLength(1));
  a.send([{ kind: "selection", request: 2 }]);
  const old = a.snapshots[0]!;
  old.socket.reply(old.command, { result: { objectId: "selection-old" } });
  await vi.waitFor(() => expect(a.snapshots).toHaveLength(2));
  expect(a.selection()).toHaveLength(0);
  a.text("latest only");
  const fresh = a.snapshots[1]!;
  fresh.socket.reply(fresh.command, { result: { objectId: "selection-new" } });
  await vi.waitFor(() => expect(a.selection()).toHaveLength(1));
  expect(a.selection()[0]).toMatchObject({
    request: 2,
    result: { text: "latest only" },
  });
  expect(
    a.socket.commands
      .filter((c) => c.method === "Runtime.releaseObject")
      .map((c) => c.params?.objectId),
  ).toEqual(["selection-old", "selection-new"]);
});

it("releases a late selection handle after document loss without granting a replacement its result", async () => {
  const a = await fixture();
  a.hold();
  const generation = a.probe.generation;
  a.send([{ kind: "selection", request: 1 }]);
  await vi.waitFor(() => expect(a.snapshots).toHaveLength(1));
  const old = a.snapshots[0]!;
  a.socket.emit("Runtime.executionContextsCleared", {}, old.command.sessionId);
  old.socket.reply(old.command, { result: { objectId: "selection-old" } });
  await vi.waitFor(() => expect(a.ready()).toHaveLength(1));
  expect(a.selection()).toHaveLength(0);
  expect(
    a.socket.commands
      .filter((c) => c.method === "Runtime.releaseObject")
      .map((c) => c.params?.objectId),
  ).toEqual(["selection-old"]);
  expect(a.send([{ kind: "text", text: "stale" }], generation)).toBe(false);
  expect(a.send([{ kind: "text", text: "fresh" }])).toBe(true);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
});

it("reports a read failure without replay and leaves later ordinary input usable", async () => {
  const a = await fixture();
  a.hold();
  a.send([{ kind: "selection", request: 1 }]);
  await vi.waitFor(() => expect(a.snapshots).toHaveLength(1));
  const read = a.snapshots[0]!;
  read.socket.reject(read.command, -32000);
  await vi.waitFor(() =>
    expect(a.selection()).toEqual([
      {
        type: "selection",
        generation: a.probe.generation,
        request: 1,
        result: null,
      },
    ]),
  );
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
  expect(a.send([{ kind: "text", text: "still usable" }])).toBe(true);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(2));
  expect(a.snapshots).toHaveLength(1);
  expect(a.replies).not.toContainEqual({ type: "revoked" });
});

it("does not publish ready before the navigation enqueued after its transition has replied", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Page.navigate";
  const old = a.probe.generation;
  expect(
    a.send([
      { kind: "navigate", action: { url: "https://fixture.invalid/next" } },
    ]),
  ).toBe(true);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  expect(a.ready()).toHaveLength(0);
  const navigation = a.browser.heldCommands[0]!;
  navigation.socket.reply(navigation.command, { frameId: "main" });
  await vi.waitFor(() => expect(a.ready()).toHaveLength(1));
  expect(a.probe.generation).not.toBe(old);
  expect(a.send([{ kind: "text", text: "stale" }], old)).toBe(false);
  expect(a.send([{ kind: "text", text: "after navigation" }])).toBe(true);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
});

it("waits for earlier native effects before navigation and never retries a rejected command", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Input.insertText";
  a.send([{ kind: "text", text: "ordered" }]);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  expect(a.send([{ kind: "navigate", action: "reload" }])).toBe(true);
  expect(
    a.socket.commands.filter((c) => c.method === "Page.reload"),
  ).toHaveLength(0);
  const input = a.browser.heldCommands[0]!;
  a.browser.holdMethod = "Page.reload";
  input.socket.reply(input.command);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(2));
  const navigation = a.browser.heldCommands[1]!;
  navigation.socket.reject(navigation.command, -32000);
  await vi.waitFor(() => expect(a.replies).toContainEqual({ type: "revoked" }));
  expect(a.ready()).toHaveLength(0);
  expect(
    a.socket.commands.filter((c) => c.method === "Page.reload"),
  ).toHaveLength(1);
  expect(await a.host.retire(a.probe)).toBe(false);
});

it("accepts a maximum-size plain-text action even when JSON escaping expands it", async () => {
  const a = await fixture();
  const text = "\u0000".repeat(64 * 1024);
  expect(a.send([{ kind: "text", text }])).toBe(true);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
  expect(
    a.socket.commands
      .filter((c) => c.method === "Input.insertText")
      .map((c) => c.params?.text),
  ).toEqual([text]);
});

it("includes selection in the shared logical credit ceiling", async () => {
  const a = await fixture();
  const move: NativeAction = {
    kind: "pointer",
    type: "mouseMoved",
    point: { x: 0.5, y: 0.5 },
    details: { modifiers: 0 },
  };
  for (let n = 0; n < 4; n++) {
    const actions: NativeAction[] = Array.from({ length: 16 }, () => move);
    if (n === 3) actions[15] = { kind: "selection", request: 1 };
    expect(a.send(actions, a.probe.generation, 0)).toBe(true);
    await vi.waitFor(() => expect(a.acks()).toHaveLength(n + 1));
  }
  expect(a.probe.peakOutstanding).toBe(64);
  expect(
    a.send([{ kind: "selection", request: 2 }], a.probe.generation, 0),
  ).toBe(false);
});

it.each(
  [
    [{ kind: "selection", request: 0 }],
    [{ kind: "selection", request: 1.5 }],
    [{ kind: "selection", request: 2 }],
    [
      { kind: "selection", request: 1 },
      { kind: "selection", request: 1 },
    ],
    [{ kind: "navigate", action: ["reload"] }],
    [{ kind: "navigate", action: { url: ["https://fixture.invalid"] } }],
    [{ kind: "navigate", action: { url: "x".repeat(64 * 1024 + 1) } }],
    [
      { kind: "navigate", action: "reload" },
      { kind: "text", text: "must not reach a new owner" },
    ],
  ].map((actions) => ({ actions })),
)(
  "rejects malformed interaction batches before any effect: %#",
  async ({ actions }) => {
    const a = await fixture();
    expect(
      a.probe.receive(
        JSON.stringify({
          kind: "batch",
          owner: a.probe.owner,
          generation: a.probe.generation,
          sequence: 1,
          acknowledged: 0,
          actions,
        }),
      ),
    ).toBe(false);
    expect(
      a.socket.commands.some(
        (c) =>
          c.method.startsWith("Input.") ||
          c.method === "Page.navigate" ||
          c.method === "Page.reload",
      ),
    ).toBe(false);
  },
);
