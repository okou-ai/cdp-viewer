import { afterEach, expect, it, vi } from "vitest";
import { ProbeHost } from "../experiments/probe-host";
import type { ProbeReply } from "../experiments/guarded-probe";
import type { NativeAction } from "../experiments/native-actions";
import { FakeBrowser } from "./wire";

const hosts: ProbeHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const preview = (text: string): NativeAction => ({
  kind: "preedit",
  text,
  selectionStart: text.length,
  selectionEnd: text.length,
});

async function fixture(
  browser = new FakeBrowser(),
  targetId = "page-a",
  windowId = 0,
  existing?: ProbeHost,
  transitionDeadlineMs?: number,
) {
  const host =
    existing ?? new ProbeHost("wss://fixture.invalid", browser.factory);
  if (!existing) hosts.push(host);
  const replies: ProbeReply[] = [];
  const next = new Map<string, number>();
  const acknowledged = new Map<string, number>();
  const completed = new Map<string, Set<number>>();
  const probe = await host.admit({
    targetId,
    windowId,
    mode: "composition",
    ...(transitionDeadlineMs !== undefined ? { transitionDeadlineMs } : {}),
    reply: (value) => {
      replies.push(value);
      if (value.type === "ack" && value.generation) {
        let set = completed.get(value.generation);
        if (!set) completed.set(value.generation, (set = new Set()));
        set.add(value.sequence);
        let through = acknowledged.get(value.generation) ?? 0;
        while (set.delete(through + 1)) through++;
        acknowledged.set(value.generation, through);
      }
    },
  });
  const send = (
    actions: NativeAction[],
    generation = probe.generation,
    confirm = acknowledged.get(generation) ?? 0,
  ) => {
    const sequence = (next.get(generation) ?? 0) + 1;
    next.set(generation, sequence);
    return probe.receive(
      JSON.stringify({
        kind: "batch",
        owner: probe.owner,
        generation,
        sequence,
        acknowledged: confirm,
        actions,
      }),
    );
  };
  const blur = (generation = probe.generation) =>
    probe.receive(
      JSON.stringify({ kind: "blur", owner: probe.owner, generation }),
    );
  return {
    host,
    browser,
    probe,
    replies,
    send,
    blur,
    socket: browser.sockets.at(-1)!,
    acks: () => replies.filter((r) => r.type === "ack"),
    ready: () => replies.filter((r) => r.type === "ready"),
  };
}

it("keeps a new focus generation unavailable until late original composition cancellation is acknowledged", async () => {
  const a = await fixture();
  const old = a.probe.generation;
  a.browser.holdMethod = "Input.imeSetComposition";
  expect(a.send([preview("old")])).toBe(true);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  expect(a.blur()).toBe(true);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(2));
  expect(a.replies).toContainEqual({
    type: "suspended",
    previous: old,
    ...a.probe.ownership,
    reason: "blur",
  });
  const [original, immediate] = a.browser.heldCommands;
  immediate!.socket.reply(immediate!.command);
  expect(a.ready()).toHaveLength(0);
  expect(a.send([{ kind: "commit", text: "stale" }], old)).toBe(false);
  original!.socket.reply(original!.command);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(3));
  expect(a.browser.heldCommands.map((v) => v.command.params?.text)).toEqual([
    "old",
    "",
    "",
  ]);
  expect(a.ready()).toHaveLength(0);
  expect(a.acks()).toHaveLength(0);
  const late = a.browser.heldCommands[2]!;
  late.socket.reply(late.command);
  await vi.waitFor(() =>
    expect(a.ready()).toEqual([{ type: "ready", ...a.probe.ownership }]),
  );
  expect(a.probe.ownership.focus).toBe(1);
  expect(a.probe.ownership.document).toBe(0);
  expect(a.probe.generation).not.toBe(old);
  expect(a.send([{ kind: "commit", text: "old trailing" }], old)).toBe(false);
  expect(a.send([{ kind: "text", text: "new generation" }])).toBe(true);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
  expect(
    a.socket.commands
      .filter((c) => c.method === "Input.insertText")
      .map((c) => c.params?.text),
  ).toEqual(["new generation"]);
});

it("joins the late composition continuation and its final cleanup receipt before detach or readmission", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Input.imeSetComposition";
  a.send([preview("old")]);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  let retired = false;
  const retiring = a.host.retire(a.probe).then((ok) => {
    retired = true;
    return ok;
  });
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(2));
  const [original, immediate] = a.browser.heldCommands;
  immediate!.socket.reply(immediate!.command);
  original!.socket.reply(original!.command);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(3));
  expect(retired).toBe(false);
  expect(
    a.socket.commands.filter((c) => c.method === "Target.detachFromTarget"),
  ).toHaveLength(0);
  await expect(
    a.host.admit({
      targetId: "page-a",
      windowId: 0,
      mode: "composition",
      reply: () => {},
    }),
  ).rejects.toThrow("unsettled owner");
  const late = a.browser.heldCommands[2]!;
  late.socket.reply(late.command);
  expect(await retiring).toBe(true);
  expect(a.ready()).toHaveLength(0);
  expect(a.acks()).toHaveLength(0);
  expect(
    a.socket.commands.filter((c) => c.method === "Target.detachFromTarget"),
  ).toHaveLength(1);
  const replacement = await a.host.admit({
    targetId: "page-a",
    windowId: 0,
    mode: "composition",
    reply: () => {},
  });
  expect(replacement.owner).not.toBe(a.probe.owner);
  expect(await a.host.retire(a.probe)).toBe(false);
  expect(await a.host.retire(replacement)).toBe(true);
});

it("coalesces queued preedit but waits for native completion before the final commit", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Input.imeSetComposition";
  expect(a.send([preview("n"), preview("ni"), preview("nihao")])).toBe(true);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  const first = a.browser.heldCommands[0]!;
  first.socket.reply(first.command);
  expect(a.browser.heldCommands.map((c) => c.command.params?.text)).toEqual([
    "nihao",
  ]);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
  a.send([{ kind: "commit", text: "你好" }]);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(2));
  expect(
    a.socket.commands
      .filter((c) => c.method === "Input.insertText")
      .map((c) => c.params?.text),
  ).toEqual(["你好"]);
});

it("preserves final-text fallback only for definite unsupported IME", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Input.imeSetComposition";
  a.send([preview("ni")]);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  const first = a.browser.heldCommands[0]!;
  first.socket.reject(first.command, -32601);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
  a.send([preview("ignored preview"), { kind: "commit", text: "你" }]);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(2));
  expect(
    a.socket.commands.filter((c) => c.method === "Input.imeSetComposition"),
  ).toHaveLength(1);
  expect(
    a.socket.commands
      .filter((c) => c.method === "Input.insertText")
      .map((c) => c.params?.text),
  ).toEqual(["你"]);
  const retired = await a.host.retire(a.probe);
  expect(retired).toBe(true);
});

it("does not treat rejected cleanup as unsupported fallback after IME was accepted", async () => {
  const a = await fixture();
  a.send([preview("accepted")]);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
  a.browser.holdMethod = "Input.imeSetComposition";
  a.blur();
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  const cleanup = a.browser.heldCommands[0]!;
  cleanup.socket.reject(cleanup.command, -32601);
  await vi.waitFor(() => expect(a.replies).toContainEqual({ type: "revoked" }));
  expect(a.ready()).toHaveLength(0);
  expect(await a.host.retire(a.probe)).toBe(false);
});

it("revokes uncertain native failures without falling back, replaying or releasing a reservation", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Input.imeSetComposition";
  a.send([preview("uncertain")]);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  a.send([{ kind: "commit", text: "never replay" }]);
  const first = a.browser.heldCommands[0]!;
  first.socket.reject(first.command, -32000);
  await vi.waitFor(() => expect(a.replies).toContainEqual({ type: "revoked" }));
  expect(a.acks()).toHaveLength(0);
  expect(
    a.socket.commands.filter((c) => c.method === "Input.insertText"),
  ).toHaveLength(0);
  expect(await a.host.retire(a.probe)).toBe(false);
  await expect(
    a.host.admit({
      targetId: "page-a",
      windowId: 0,
      mode: "composition",
      reply: () => {},
    }),
  ).rejects.toThrow("unsettled owner");
});

it("does not send old-document cancellation after document loss and rejects old generation commits", async () => {
  const a = await fixture();
  const old = a.probe.generation;
  a.browser.holdMethod = "Input.imeSetComposition";
  a.send([preview("old document")]);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  const original = a.browser.heldCommands[0]!;
  a.socket.emit(
    "Runtime.executionContextsCleared",
    {},
    original.command.sessionId,
  );
  expect(a.probe.ownership.document).toBe(1);
  expect(a.ready()).toHaveLength(0);
  original.socket.reply(original.command);
  await vi.waitFor(() => expect(a.ready()).toHaveLength(1));
  expect(a.browser.heldCommands).toHaveLength(1);
  expect(a.send([{ kind: "commit", text: "old trailing" }], old)).toBe(false);
  a.send([{ kind: "text", text: "current" }]);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
  expect(
    a.socket.commands
      .filter((c) => c.method === "Input.insertText")
      .map((c) => c.params?.text),
  ).toEqual(["current"]);
});

it("observes document loss during retirement and never sends late old cleanup into the replacement", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Input.imeSetComposition";
  a.send([preview("original document")]);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  const original = a.browser.heldCommands[0]!;
  const retiring = a.host.retire(a.probe);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(2));
  const beforeLoss = a.socket.commands.length;
  a.socket.emit(
    "Runtime.executionContextsCleared",
    {},
    original.command.sessionId,
  );
  expect(await retiring).toBe(false);
  original.socket.reply(original.command);
  expect(
    a.socket.commands
      .slice(beforeLoss)
      .filter((c) => c.method === "Input.imeSetComposition"),
  ).toHaveLength(0);
  expect(
    a.socket.commands.filter((c) => c.method === "Target.detachFromTarget"),
  ).toHaveLength(0);
  await expect(
    a.host.admit({
      targetId: "page-a",
      windowId: 0,
      mode: "composition",
      reply: () => {},
    }),
  ).rejects.toThrow("unsettled owner");
});

it("keeps a sibling lane independent while composition cleanup is held", async () => {
  const a = await fixture();
  const b = await fixture(a.browser, "page-b", 2, a.host);
  a.browser.holdMethod = "Input.imeSetComposition";
  a.send([preview("held")]);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  a.blur();
  expect(b.send([{ kind: "text", text: "sibling" }])).toBe(true);
  await vi.waitFor(() => expect(b.acks()).toHaveLength(1));
  expect(a.ready()).toHaveLength(0);
  expect(a.acks()).toHaveLength(0);
});

it("clears old logical credits only into a fresh acknowledged generation", async () => {
  const a = await fixture();
  const old = a.probe.generation;
  const moves: NativeAction[] = Array.from({ length: 16 }, (_, i) => ({
    kind: "pointer",
    type: "mouseMoved",
    point: { x: i / 16, y: 0.5 },
    details: { modifiers: 0 },
  }));
  for (let i = 0; i < 4; i++) {
    expect(a.send(moves, old, 0)).toBe(true);
    await vi.waitFor(() => expect(a.acks()).toHaveLength(i + 1));
  }
  expect(a.probe.peakOutstanding).toBe(64);
  expect(a.blur()).toBe(true);
  await vi.waitFor(() => expect(a.ready()).toHaveLength(1));
  expect(a.send([{ kind: "text", text: "fresh" }])).toBe(true);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(5));
  expect(a.acks().at(-1)).toMatchObject({
    sequence: 1,
    generation: a.probe.generation,
  });
});

it("bounds a missing nonterminal cleanup reply and retains the unavailable reservation", async () => {
  const a = await fixture(new FakeBrowser(), "page-a", 0, undefined, 250);
  a.send([preview("pending cleanup")]);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
  a.browser.holdMethod = "Input.imeSetComposition";
  expect(a.blur()).toBe(true);
  await vi.waitFor(() => expect(a.replies).toContainEqual({ type: "revoked" }));
  expect(a.ready()).toHaveLength(0);
  expect(await a.host.retire(a.probe)).toBe(false);
  await expect(
    a.host.admit({
      targetId: "page-a",
      windowId: 0,
      mode: "composition",
      reply: () => {},
    }),
  ).rejects.toThrow("unsettled owner");
});

it.each([
  { kind: "preedit", text: "x", selectionStart: -1, selectionEnd: 0 },
  { kind: "preedit", text: "x", selectionStart: 1, selectionEnd: 0 },
  { kind: "preedit", text: "x", selectionStart: 0, selectionEnd: 2 },
  { kind: "preedit", text: "x", selectionStart: 0.5, selectionEnd: 1 },
  { kind: "preedit", text: ["coerced"], selectionStart: 0, selectionEnd: 0 },
  { kind: "commit", text: "x".repeat(64 * 1024 + 1) },
])(
  "rejects malformed composition without native writes: %#",
  async (action) => {
    const a = await fixture();
    expect(
      a.probe.receive(
        JSON.stringify({
          kind: "batch",
          owner: a.probe.owner,
          generation: a.probe.generation,
          sequence: 1,
          acknowledged: 0,
          actions: [action],
        }),
      ),
    ).toBe(false);
    expect(a.socket.commands.some((c) => c.method.startsWith("Input."))).toBe(
      false,
    );
  },
);
