import { afterEach, expect, it, vi } from "vitest";
import { ProbeHost } from "../experiments/probe-host";
import type { ProbeReply } from "../experiments/guarded-probe";
import type { NativeAction } from "../experiments/native-actions";
import { FakeBrowser } from "./wire";

const hosts: ProbeHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const move = (x: number): NativeAction => ({
  kind: "pointer",
  type: "mouseMoved",
  point: { x, y: 0.5 },
  details: { modifiers: 0, button: "none", buttons: 0 },
});
const wheel = (dy: number): NativeAction => ({
  kind: "pointer",
  type: "mouseWheel",
  point: { x: 0.5, y: 0.5 },
  details: { modifiers: 0, deltaX: 0, deltaY: dy },
});
const shift: NativeAction = {
  kind: "key",
  key: {
    type: "rawKeyDown",
    key: "Shift",
    code: "ShiftLeft",
    modifiers: 8,
    windowsVirtualKeyCode: 16,
  },
};

async function fixture(
  browser = new FakeBrowser(),
  targetId = "page-a",
  windowId = 0,
  existing?: ProbeHost,
) {
  const host =
    existing ?? new ProbeHost("wss://fixture.invalid", browser.factory);
  if (!existing) hosts.push(host);
  const replies: ProbeReply[] = [];
  let acknowledged = 0;
  const completed = new Set<number>();
  const probe = await host.admit({
    targetId,
    windowId,
    mode: "native",
    reply: (value) => {
      replies.push(value);
      if (value.type === "ack") {
        completed.add(value.sequence);
        while (completed.delete(acknowledged + 1)) acknowledged++;
      }
    },
  });
  let sequence = 0;
  const send = (actions: NativeAction[], confirm = acknowledged) =>
    probe.receive(
      JSON.stringify({
        kind: "batch",
        owner: probe.owner,
        sequence: ++sequence,
        acknowledged: confirm,
        actions,
      }),
    );
  return {
    host,
    browser,
    probe,
    replies,
    send,
    socket: browser.sockets.at(-1)!,
  };
}

it("acknowledges a logical coalesced batch only after every actual native reply", async () => {
  const a = await fixture();
  const held = a.probe.holdNext("Browser.getWindowForTarget");
  expect(a.send([move(0.1), move(0.2), move(0.3), wheel(20), wheel(30)])).toBe(
    true,
  );
  await held.held;
  a.browser.holdMethod = "Input.dispatchMouseEvent";
  held.release();
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(3));
  // Active move is immutable; two queued moves coalesce and wheels sum.
  expect(a.browser.heldCommands.map((v) => v.command.params?.type)).toEqual([
    "mouseMoved",
    "mouseMoved",
    "mouseWheel",
  ]);
  expect(a.browser.heldCommands.at(-1)!.command.params?.deltaY).toBe(50);
  expect(a.replies).toEqual([]);
  for (const value of a.browser.heldCommands.slice(0, 2))
    value.socket.reply(value.command);
  expect(a.replies).toEqual([]);
  const last = a.browser.heldCommands.at(-1)!;
  last.socket.reply(last.command);
  await vi.waitFor(() =>
    expect(a.replies).toEqual([{ type: "ack", sequence: 1, ok: true }]),
  );
  expect(a.probe.peakOutstanding).toBe(5);
});

it("keeps click/key/text effects ordered and strips arbitrary client CDP fields", async () => {
  const a = await fixture();
  const extra = {
    kind: "pointer",
    type: "mousePressed",
    point: { x: 0.25, y: 0.5 },
    details: {
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
      sessionId: "foreign",
      targetId: "page-b",
    },
  } as const;
  expect(
    a.send([
      extra,
      {
        ...extra,
        type: "mouseReleased",
        details: { ...extra.details, buttons: 0 },
      },
      {
        kind: "key",
        key: {
          type: "keyDown",
          key: "x",
          code: "KeyX",
          text: "x",
          unmodifiedText: "x",
          autoRepeat: false,
          modifiers: 0,
          windowsVirtualKeyCode: 88,
        },
      },
      { kind: "text", text: "commit" },
    ]),
  ).toBe(true);
  await vi.waitFor(() => expect(a.replies).toHaveLength(1));
  const writes = a.socket.commands.filter((c) => c.method.startsWith("Input."));
  expect(writes.map((c) => c.method)).toEqual([
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
  ]);
  expect(writes[0]!.params).not.toHaveProperty("targetId");
  expect(writes[0]!.params).not.toHaveProperty("sessionId");
  expect(new Set(writes.map((c) => c.sessionId)).size).toBe(1);
});

it("cancels a pending fence and unsent coalesced actions on retirement", async () => {
  const a = await fixture();
  const held = a.probe.holdNext("Browser.getWindowForTarget");
  a.send([move(0.1), move(0.2), { kind: "text", text: "discarded" }]);
  await held.held;
  expect(await a.host.retire(a.probe)).toBe(true);
  held.release();
  expect(a.replies).toEqual([{ type: "revoked" }]);
  expect(
    a.socket.commands.filter((c) => c.method.startsWith("Input.")),
  ).toEqual([]);
});

it("fails a whole batch after one rejected native effect without replay", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Input.dispatchMouseEvent";
  a.send([move(0.1), wheel(10)]);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(2));
  const first = a.browser.heldCommands[0]!;
  first.socket.reject(first.command, -32000);
  await vi.waitFor(() => expect(a.replies).toEqual([{ type: "revoked" }]));
  expect(a.send([{ kind: "text", text: "never replay" }])).toBe(false);
  expect(await a.host.retire(a.probe)).toBe(false);
});

it("does not let one window's held completion block a sibling", async () => {
  const a = await fixture();
  const b = await fixture(a.browser, "page-b", 2, a.host);
  const held = a.probe.holdNext("Input.dispatchKeyEvent");
  a.send([shift]);
  await held.held;
  b.send([{ kind: "text", text: "independent" }]);
  await vi.waitFor(() => expect(b.replies).toHaveLength(1));
  expect(a.replies).toEqual([]);
  const retiring = a.host.retire(a.probe);
  await expect(
    a.host.admit({
      targetId: "page-a",
      windowId: 0,
      mode: "native",
      reply: () => {},
    }),
  ).rejects.toThrow("unsettled owner");
  held.release();
  expect(await retiring).toBe(true);
  expect(
    a.socket.commands.filter((c) => c.params?.type === "keyUp"),
  ).toHaveLength(1);
});

it("bounds logical actions even when their coalesced receipts are in reply transit", async () => {
  const a = await fixture();
  for (let n = 0; n < 4; n++) {
    expect(
      a.send(
        Array.from({ length: 16 }, (_, i) => move(i / 16)),
        0,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(a.replies).toHaveLength(n + 1));
  }
  expect(a.probe.peakOutstanding).toBe(64);
  expect(a.send([move(0.5)], 0)).toBe(false);
  expect(a.replies.at(-1)).toEqual({ type: "revoked" });
});

it("waits for owned button and modifier cleanup before releasing the reservation", async () => {
  const a = await fixture();
  a.send([
    shift,
    {
      kind: "pointer",
      type: "mousePressed",
      point: { x: 0.2, y: 0.3 },
      details: { button: "left", buttons: 1, clickCount: 1, modifiers: 8 },
    },
  ]);
  await vi.waitFor(() => expect(a.replies).toHaveLength(1));
  a.browser.holdMethod = "Input.dispatchMouseEvent";
  const retiring = a.host.retire(a.probe);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  const release = a.browser.heldCommands[0]!;
  expect(release.command.params).toMatchObject({
    type: "mouseReleased",
    button: "left",
    buttons: 0,
  });
  expect(
    a.socket.commands.filter((c) => c.params?.type === "keyUp"),
  ).toHaveLength(1);
  await expect(
    a.host.admit({
      targetId: "page-a",
      windowId: 0,
      mode: "native",
      reply: () => {},
    }),
  ).rejects.toThrow("unsettled owner");
  release.socket.reply(release.command);
  expect(await retiring).toBe(true);
});

it("enforces actual queue capacity including fences and discards an overflowing held burst", async () => {
  const a = await fixture();
  const held = a.probe.holdNext("Browser.getWindowForTarget");
  const actions = Array.from({ length: 16 }, () => ({
    kind: "text" as const,
    text: "queued",
  }));
  expect(a.send(actions)).toBe(true);
  await held.held;
  expect(a.send(actions)).toBe(true);
  expect(a.send(actions)).toBe(true);
  expect(a.send(actions)).toBe(false);
  held.release();
  expect(a.replies).toEqual([{ type: "revoked" }]);
  expect(a.socket.commands.some((c) => c.method.startsWith("Input."))).toBe(
    false,
  );
});

it.each(
  [
    [],
    Array.from({ length: 17 }, () => move(0.5)),
    [
      {
        kind: "pointer",
        type: "mouseMoved",
        point: { x: 2, y: 0 },
        details: { modifiers: 0 },
      },
    ],
    [
      {
        kind: "pointer",
        type: "mouseWheel",
        point: { x: 0, y: 0 },
        details: { modifiers: 0, deltaX: 0, deltaY: "Infinity" },
      },
    ],
    [{ kind: "key", key: { ...shift.key, commands: ["deleteBackward"] } }],
    [{ kind: "key", key: { ...shift.key, type: ["rawKeyDown"] } }],
    [{ kind: "key", key: { ...shift.key, commands: [["selectAll"]] } }],
    [
      {
        kind: "pointer",
        type: ["mouseMoved"],
        point: { x: 0.5, y: 0.5 },
        details: { modifiers: 0 },
      },
    ],
    [{ kind: "preedit", text: "outside scope" }],
  ].map((actions) => ({ actions })),
)("rejects invalid or unsupported native batches: %j", async ({ actions }) => {
  const a = await fixture();
  expect(
    a.probe.receive(
      JSON.stringify({
        kind: "batch",
        owner: a.probe.owner,
        sequence: 1,
        acknowledged: 0,
        actions,
      }),
    ),
  ).toBe(false);
  expect(a.socket.commands.some((c) => c.method.startsWith("Input."))).toBe(
    false,
  );
});
