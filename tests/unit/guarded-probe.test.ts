import { afterEach, expect, it, vi } from "vitest";
import { GuardedProbe } from "../experiments/guarded-probe";
import type { ProbeReply } from "../experiments/guarded-probe";
import { FakeBrowser } from "./wire";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

const backspace = {
  kind: "key",
  key: {
    type: "rawKeyDown",
    key: "Backspace",
    code: "Backspace",
    modifiers: 0,
    windowsVirtualKeyCode: 8,
  },
};

async function fixture(browser = new FakeBrowser(), windowId = 0) {
  let acknowledged = 0;
  const completed = new Set<number>();
  const reply = vi.fn((value: ProbeReply) => {
    if (value.type === "ack") {
      completed.add(value.sequence);
      while (completed.delete(acknowledged + 1)) acknowledged++;
    }
  });
  const probe = await GuardedProbe.open({
    endpoint: "wss://fixture.invalid",
    targetId: windowId === 2 ? "page-b" : "page-a",
    windowId,
    reply,
    factory: browser.factory,
  });
  cleanup.push(() => probe.close());
  const socket = browser.sockets.at(-1)!;
  let sequence = 0;
  const send = (action: object) =>
    probe.receive(
      JSON.stringify({
        owner: probe.owner,
        sequence: ++sequence,
        acknowledged,
        ...action,
      }),
    );
  return { probe, browser, socket, reply, send };
}

it("preserves ordered native sends, fresh guards and real reply accounting", async () => {
  const { probe, socket, reply, send } = await fixture();
  const start = socket.commands.length;
  expect(send(backspace)).toBe(true);
  expect(send({ kind: "text", text: "native text" })).toBe(true);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
  expect(reply.mock.calls.map(([value]) => value)).toEqual([
    { type: "ack", sequence: 1, ok: true },
    { type: "ack", sequence: 2, ok: true },
  ]);
  const commands = socket.commands.slice(start);
  expect(
    commands.filter((c) => c.method === "Browser.getWindowForTarget"),
  ).toHaveLength(2);
  expect(
    commands.filter((c) => c.method.startsWith("Input.")).map((c) => c.method),
  ).toEqual(["Input.dispatchKeyEvent", "Input.insertText"]);
  expect(probe.peakOutstanding).toBe(2);
});

it.each([
  { owner: "foreign", sequence: 1, kind: "text", text: "blocked" },
  { sequence: 2, kind: "text", text: "blocked" },
  { sequence: 1, kind: "text", text: "" },
  { sequence: 1, kind: "text", text: "x".repeat(64 * 1024 + 1) },
  { sequence: 1, kind: "cdp", method: "Browser.close" },
  { sequence: 1, acknowledged: 1, kind: "text", text: "unearned credit" },
  { sequence: 1, ...backspace, key: { ...backspace.key, modifiers: 16 } },
])(
  "rejects invalid admission/payload without native writes: %j",
  async (value) => {
    const { probe, socket, reply } = await fixture();
    expect(
      probe.receive(
        JSON.stringify({ owner: probe.owner, acknowledged: 0, ...value }),
      ),
    ).toBe(false);
    expect(reply).toHaveBeenCalledExactlyOnceWith({ type: "revoked" });
    expect(socket.commands.some((c) => c.method.startsWith("Input."))).toBe(
      false,
    );
    expect(
      socket.commands.some((c) =>
        ["Browser.close", "Target.closeTarget"].includes(c.method),
      ),
    ).toBe(false);
  },
);

it("rejects duplicate intent without replaying an acknowledged native edit", async () => {
  const { probe, socket, reply, send } = await fixture();
  expect(send({ kind: "text", text: "once" })).toBe(true);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
  expect(
    probe.receive(
      JSON.stringify({
        owner: probe.owner,
        sequence: 1,
        acknowledged: 1,
        kind: "text",
        text: "once",
      }),
    ),
  ).toBe(false);
  expect(
    socket.commands.filter((c) => c.method === "Input.insertText"),
  ).toHaveLength(1);
});

it("bounds queued and in-flight intents together and discards overflow", async () => {
  const { probe, browser, socket, reply, send } = await fixture();
  browser.holdMethod = "Browser.getWindowForTarget";
  expect(send({ kind: "text", text: "held" })).toBe(true);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  for (let index = 1; index < 64; index++)
    expect(send({ kind: "text", text: "queued" })).toBe(true);
  expect(send({ kind: "text", text: "overflow" })).toBe(false);
  expect(probe.peakOutstanding).toBe(64);
  expect(reply).toHaveBeenCalledWith({ type: "revoked" });
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, { windowId: 0 });
  expect(
    socket.commands.filter((c) => c.method === "Input.insertText"),
  ).toHaveLength(0);
});

it("does not release wire-window credit until the client confirms actual acknowledgements", async () => {
  const browser = new FakeBrowser();
  let answered!: () => void;
  const probe = await GuardedProbe.open({
    endpoint: "wss://fixture.invalid",
    targetId: "page-a",
    windowId: 0,
    factory: browser.factory,
    reply: (value) => {
      if (value.type === "ack") answered();
    },
  });
  cleanup.push(() => probe.close());
  for (let sequence = 1; sequence <= 64; sequence++) {
    const ack = new Promise<void>((resolve) => {
      answered = resolve;
    });
    expect(
      probe.receive(
        JSON.stringify({
          owner: probe.owner,
          sequence,
          acknowledged: 0,
          kind: "text",
          text: "native",
        }),
      ),
    ).toBe(true);
    await ack;
  }
  expect(probe.peakOutstanding).toBe(1);
  expect(
    probe.receive(
      JSON.stringify({
        owner: probe.owner,
        sequence: 65,
        acknowledged: 0,
        kind: "text",
        text: "overflow in reply transit",
      }),
    ),
  ).toBe(false);
  expect(
    browser.sockets[0]!.commands.filter((c) => c.method === "Input.insertText"),
  ).toHaveLength(64);
});

it.each(["Browser.getWindowForTarget", "Input.dispatchKeyEvent"] as const)(
  "holds A's actual %s boundary while another window continues",
  async (method) => {
    const browser = new FakeBrowser();
    const a = await fixture(browser);
    const b = await fixture(browser, 2);
    const held = a.probe.holdNext(method);
    expect(a.send(backspace)).toBe(true);
    await held.held;
    expect(a.reply).not.toHaveBeenCalled();
    expect(b.send({ kind: "text", text: "independent" })).toBe(true);
    await vi.waitFor(() =>
      expect(b.reply).toHaveBeenCalledWith({
        type: "ack",
        sequence: 1,
        ok: true,
      }),
    );
    held.release();
    await vi.waitFor(() =>
      expect(a.reply).toHaveBeenCalledWith({
        type: "ack",
        sequence: 1,
        ok: true,
      }),
    );
  },
);

it("revokes queued work after a failed input reply without replay", async () => {
  const { probe, browser, socket, reply, send } = await fixture();
  browser.holdMethod = "Input.insertText";
  send({ kind: "text", text: "uncertain" });
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  const held = browser.heldCommands[0]!;
  socket.reject(held.command, -32000);
  await vi.waitFor(() =>
    expect(reply).toHaveBeenCalledWith({ type: "revoked" }),
  );
  expect(send({ kind: "text", text: "never replay" })).toBe(false);
  expect(
    socket.commands.filter((c) => c.method === "Input.insertText"),
  ).toHaveLength(1);
  probe.close();
});

it("does not let an old fixture release unblock a newer held response", async () => {
  const browser = new FakeBrowser();
  const a = await fixture(browser);
  const b = await fixture(browser, 2);
  const first = a.probe.holdNext("Browser.getWindowForTarget");
  a.send({ kind: "text", text: "first" });
  await first.held;
  first.release();
  await vi.waitFor(() => expect(a.reply).toHaveBeenCalledOnce());
  const second = a.probe.holdNext("Browser.getWindowForTarget");
  a.send({ kind: "text", text: "second" });
  await second.held;
  first.release();
  b.send({ kind: "text", text: "synchronization round trip" });
  await vi.waitFor(() => expect(b.reply).toHaveBeenCalledOnce());
  expect(a.reply).toHaveBeenCalledOnce();
  second.release();
  await vi.waitFor(() => expect(a.reply).toHaveBeenCalledTimes(2));
});

it("disconnects one owner and ignores a held old reply without affecting its sibling", async () => {
  const browser = new FakeBrowser();
  const a = await fixture(browser);
  const b = await fixture(browser, 2);
  const held = a.probe.holdNext("Browser.getWindowForTarget");
  a.send({ kind: "text", text: "discarded" });
  await held.held;
  a.probe.close();
  held.release();
  expect(b.send({ kind: "text", text: "survives" })).toBe(true);
  await vi.waitFor(() => expect(b.reply).toHaveBeenCalledOnce());
  expect(a.socket.commands.some((c) => c.method === "Input.insertText")).toBe(
    false,
  );
  expect(a.reply).not.toHaveBeenCalled();
});
