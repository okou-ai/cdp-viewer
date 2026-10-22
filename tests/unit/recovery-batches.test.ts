import { afterEach, expect, it, vi } from "vitest";
import { ProbeHost } from "../experiments/probe-host";
import type { ProbeReply } from "../experiments/guarded-probe";
import type { NativeAction } from "../experiments/native-actions";
import { FakeBrowser } from "./wire";
import type { FakeSocket, WireCommand } from "./wire";

const hosts: ProbeHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));
const preview = (text: string): NativeAction => ({
  kind: "preedit",
  text,
  selectionStart: text.length,
  selectionEnd: text.length,
});
const key = (name: "Shift" | "Control"): NativeAction => ({
  kind: "key",
  key: {
    type: "rawKeyDown",
    key: name,
    code: name + "Left",
    windowsVirtualKeyCode: name === "Shift" ? 16 : 17,
    modifiers: 10,
  },
});
const pointer: NativeAction = {
  kind: "pointer",
  type: "mousePressed",
  point: { x: 0.5, y: 0.5 },
  details: { button: "left", buttons: 1, clickCount: 1, modifiers: 10 },
};

async function fixture() {
  const browser = new FakeBrowser();
  const held: { command: WireCommand; socket: FakeSocket }[] = [];
  const methods = new Set<string>();
  let blocked: FakeSocket | undefined;
  const host = new ProbeHost("wss://fixture.invalid", (url) => {
    const socket = browser.factory(url) as unknown as FakeSocket;
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      const command = JSON.parse(raw) as WireCommand;
      if (socket === blocked && methods.has(command.method)) {
        socket.commands.push(command);
        held.push({ command, socket });
      } else if (command.method === "Page.getNavigationHistory") {
        socket.commands.push(command);
        queueMicrotask(() =>
          socket.reply(command, {
            currentIndex: 1,
            entries: [
              {
                id: 1,
                url: "https://fixture.invalid/previous",
                title: "Previous",
              },
              {
                id: 2,
                url: "https://fixture.invalid/current",
                title: "Current",
              },
            ],
          }),
        );
      } else if (
        command.method === "Runtime.evaluate" &&
        String(command.params?.expression).startsWith(
          "/* cdp-viewer selection */",
        )
      ) {
        socket.commands.push(command);
        queueMicrotask(() =>
          socket.reply(command, { result: { objectId: "owned-selection" } }),
        );
      } else if (
        command.method === "Runtime.callFunctionOn" &&
        command.params?.objectId === "owned-selection"
      ) {
        socket.commands.push(command);
        queueMicrotask(() =>
          socket.reply(command, {
            result: { value: { status: "ok", text: "owned" } },
          }),
        );
      } else send(raw);
    };
    return socket.asWebSocket();
  });
  hosts.push(host);
  const channel = async (targetId = "page-a", windowId = 0) => {
    const replies: ProbeReply[] = [];
    const produced: ProbeReply[] = [];
    const next = new Map<string, number>();
    const acknowledged = new Map<string, number>();
    const completed = new Map<string, Set<number>>();
    let dropAcks = false;
    const probe = await host.admit({
      targetId,
      windowId,
      mode: "composition",
      reply: (reply) => {
        produced.push(reply);
        if (dropAcks && reply.type === "ack") return;
        replies.push(reply);
        if (reply.type === "ack" && reply.generation) {
          let values = completed.get(reply.generation);
          if (!values) completed.set(reply.generation, (values = new Set()));
          values.add(reply.sequence);
          let through = acknowledged.get(reply.generation) ?? 0;
          while (values.delete(through + 1)) through++;
          acknowledged.set(reply.generation, through);
        }
      },
    });
    const socket = browser.sockets.at(-1)!;
    return {
      probe,
      socket,
      replies,
      drop: () => {
        dropAcks = true;
      },
      send: (actions: NativeAction[], generation = probe.generation) => {
        const sequence = (next.get(generation) ?? 0) + 1;
        next.set(generation, sequence);
        return probe.receive(
          JSON.stringify({
            kind: "batch",
            owner: probe.owner,
            generation,
            sequence,
            acknowledged: acknowledged.get(generation) ?? 0,
            actions,
          }),
        );
      },
      acks: () => replies.filter((reply) => reply.type === "ack"),
      completions: () =>
        produced.filter((reply) => reply.type === "ack").length,
    };
  };
  const a = await channel();
  blocked = a.socket;
  return { a, browser, host, held, methods, channel };
}

async function acquired(a: Awaited<ReturnType<typeof fixture>>["a"]) {
  expect(
    a.send([key("Shift"), key("Control"), pointer, preview("accepted")]),
  ).toBe(true);
  await vi.waitFor(() => expect(a.acks()).toHaveLength(1));
}

const denied = (host: ProbeHost, windowId = 0) =>
  expect(
    host.admit({
      targetId: "page-a",
      windowId,
      mode: "composition",
      reply: () => {},
    }),
  ).rejects.toThrow("unsettled owner");

it("joins every mixed original release and detach before reconnect, leaving sibling and replacement acquisitions intact", async () => {
  const f = await fixture();
  const b = await f.channel("page-b", 2);
  await acquired(f.a);
  await acquired(b);
  for (const method of [
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.imeSetComposition",
    "Target.detachFromTarget",
  ])
    f.methods.add(method);
  let finished = false;
  const retirement = f.host.retire(f.a.probe).then((ok) => {
    finished = true;
    return ok;
  });
  await vi.waitFor(() => expect(f.held).toHaveLength(4));
  expect(
    f.held
      .filter(({ command }) => command.params?.type === "keyUp")
      .map(({ command }) => command.params?.key)
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual(["Control", "Shift"]);
  expect(
    f.held.some(({ command }) => command.params?.type === "mouseReleased"),
  ).toBe(true);
  expect(
    f.held.some(
      ({ command }) =>
        command.method === "Input.imeSetComposition" &&
        command.params?.text === "",
    ),
  ).toBe(true);
  await denied(f.host);
  const first = f.held[0]!;
  first.socket.reply(first.command);
  expect(finished).toBe(false);
  expect(
    b.send([
      { kind: "commit", text: "sibling" },
      { kind: "selection", request: 1 },
    ]),
  ).toBe(true);
  await vi.waitFor(() => expect(b.acks()).toHaveLength(2));
  expect(
    b.replies.some(
      (reply) => reply.type === "selection" && reply.result?.text === "owned",
    ),
  ).toBe(true);
  expect(
    b.socket.commands.filter((command) => command.params?.type === "keyUp"),
  ).toHaveLength(0);
  for (const held of f.held.slice(1)) held.socket.reply(held.command);
  await vi.waitFor(() => expect(f.held).toHaveLength(5));
  const detach = f.held[4]!;
  expect(detach.command.method).toBe("Target.detachFromTarget");
  expect(finished).toBe(false);
  await denied(f.host);
  detach.socket.reply(detach.command);
  expect(await retirement).toBe(true);
  f.methods.clear();
  const replacement = await f.channel();
  await acquired(replacement);
  expect(replacement.probe.owner).not.toBe(f.a.probe.owner);
  for (const held of f.held) held.socket.reply(held.command);
  f.a.probe.close();
  expect(await f.host.retire(f.a.probe)).toBe(false);
  expect(
    replacement.socket.commands.filter(
      (command) =>
        command.params?.type === "keyUp" ||
        command.params?.type === "mouseReleased",
    ),
  ).toHaveLength(0);
  expect(replacement.send([{ kind: "commit", text: "fresh" }])).toBe(true);
  await vi.waitFor(() => expect(replacement.acks()).toHaveLength(2));
});

it("drops queued composition/text/selection/navigation behind an old native effect instead of replaying them after move", async () => {
  const f = await fixture();
  await acquired(f.a);
  const old = f.a.probe.generation;
  f.methods.add("Input.imeSetComposition");
  expect(f.a.send([preview("in-flight")])).toBe(true);
  await vi.waitFor(() => expect(f.held).toHaveLength(1));
  expect(f.held[0]!.command.params?.text).toBe("in-flight");
  expect(
    f.a.send([
      { kind: "text", text: "unsent" },
      { kind: "selection", request: 1 },
      { kind: "navigate", action: "reload" },
    ]),
  ).toBe(true);
  f.browser.targets[0]!.windowId = 2;
  const retirement = f.host.retire(f.a.probe, "target-replaced");
  await denied(f.host, 2);
  f.methods.clear();
  for (const held of f.held) held.socket.reply(held.command);
  expect(await retirement).toBe(true);
  expect(f.a.send([{ kind: "commit", text: "late" }], old)).toBe(false);
  expect(
    f.a.socket.commands.filter(
      (command) =>
        command.method === "Input.insertText" ||
        command.method === "Page.reload",
    ),
  ).toHaveLength(0);
  expect(
    f.a.replies.filter((reply) => reply.type === "selection"),
  ).toHaveLength(0);
  const replacement = await f.channel("page-a", 2);
  await acquired(replacement);
  f.a.probe.close();
  expect(await f.host.retire(f.a.probe)).toBe(false);
  expect(
    replacement.socket.commands.filter(
      (command) => command.params?.type === "keyUp",
    ),
  ).toHaveLength(0);
});

it.each(["lost", "rejected", "partial", "missing-result"] as const)(
  "keeps mixed native %s cleanup uncertain without another connection or retry",
  async (failure) => {
    const f = await fixture();
    await acquired(f.a);
    f.methods.add("Input.dispatchKeyEvent");
    f.methods.add("Input.imeSetComposition");
    const retirement = f.host.retire(f.a.probe);
    await vi.waitFor(() => expect(f.held).toHaveLength(3));
    const first = f.held[0]!;
    if (failure === "rejected" || failure === "missing-result") {
      if (failure === "rejected") first.socket.reject(first.command, -32000);
      else
        first.socket.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ id: first.command.id }),
          }),
        );
      for (const held of f.held.slice(1)) held.socket.reply(held.command);
    } else {
      if (failure === "partial") first.socket.reply(first.command);
      first.socket.close();
    }
    expect(await retirement).toBe(false);
    await denied(f.host);
    expect(f.browser.sockets).toHaveLength(1);
    expect(f.a.send([{ kind: "navigate", action: "reload" }])).toBe(false);
    expect(
      f.a.socket.commands.filter((command) => command.method === "Page.reload"),
    ).toHaveLength(0);
    for (const held of f.held) held.socket.reply(held.command);
    await denied(f.host);
  },
);

it.each(["missing-result", "non-object-result"] as const)(
  "keeps %s detach uncertain after all original input releases completed",
  async (failure) => {
    const f = await fixture();
    const b = await f.channel("page-b", 2);
    await acquired(f.a);
    await acquired(b);
    f.methods.add("Target.detachFromTarget");
    const retirement = f.host.retire(f.a.probe);
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    const detach = f.held[0]!;
    expect(detach.command.method).toBe("Target.detachFromTarget");
    await denied(f.host);
    detach.socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          id: detach.command.id,
          ...(failure === "non-object-result" ? { result: null } : {}),
        }),
      }),
    );
    expect(await retirement).toBe(false);
    await denied(f.host);
    expect(f.browser.sockets).toHaveLength(2);
    expect(
      f.a.socket.commands.filter(
        (command) => command.method === "Target.detachFromTarget",
      ),
    ).toHaveLength(1);
    detach.socket.reply(detach.command);
    await denied(f.host);
    expect(b.send([{ kind: "commit", text: "sibling remains usable" }])).toBe(
      true,
    );
    await vi.waitFor(() => expect(b.acks()).toHaveLength(2));
    expect(
      b.socket.commands.filter((command) => command.params?.type === "keyUp"),
    ).toHaveLength(0);
  },
);

it("delegates truncated native JSON to the canonical decoder without breaking its sibling lane", async () => {
  const f = await fixture();
  const b = await f.channel("page-b", 2);
  await acquired(f.a);
  await acquired(b);
  f.methods.add("Input.imeSetComposition");
  expect(f.a.send([preview("uncertain")])).toBe(true);
  await vi.waitFor(() => expect(f.held).toHaveLength(1));
  expect(() =>
    f.a.socket.dispatchEvent(new MessageEvent("message", { data: "{" })),
  ).not.toThrow();
  expect(await f.host.retire(f.a.probe)).toBe(false);
  await denied(f.host);
  expect(f.browser.sockets).toHaveLength(2);
  expect(b.send([{ kind: "commit", text: "sibling remains usable" }])).toBe(
    true,
  );
  await vi.waitFor(() => expect(b.acks()).toHaveLength(2));
  expect(b.socket.readyState).toBe(1);
  expect(
    b.socket.commands.filter((command) => command.params?.type === "keyUp"),
  ).toHaveLength(0);
});

const navigationCases = [
  {
    method: "Page.navigate",
    action: { url: "https://fixture.invalid/next" },
  },
  { method: "Page.reload", action: "reload" },
  { method: "Page.navigateToHistoryEntry", action: "back" },
] satisfies {
  method: string;
  action: Extract<NativeAction, { kind: "navigate" }>["action"];
}[];
it.each(
  navigationCases.flatMap(({ method, action }) =>
    (["lost", "rejected"] as const).map((failure) => ({
      method,
      action,
      failure,
    })),
  ),
)(
  "does not replay $method after a $failure native reply",
  async ({ method, action, failure }) => {
    const f = await fixture();
    await acquired(f.a);
    f.methods.add(method);
    expect(f.a.send([{ kind: "navigate", action }])).toBe(true);
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    const navigation = f.held[0]!;
    if (failure === "lost") navigation.socket.close();
    else navigation.socket.reject(navigation.command, -32000);
    expect(await f.host.retire(f.a.probe)).toBe(false);
    await denied(f.host);
    expect(
      f.a.socket.commands.filter((command) => command.method === method),
    ).toHaveLength(1);
    expect(f.a.replies.filter((reply) => reply.type === "ready")).toHaveLength(
      0,
    );
    expect(f.browser.sockets).toHaveLength(1);
  },
);

it("joins original cleanup and detach after a completed navigation error without replay", async () => {
  const f = await fixture();
  await acquired(f.a);
  f.methods.add("Page.navigate");
  expect(
    f.a.send([
      { kind: "navigate", action: { url: "https://fixture.invalid/next" } },
    ]),
  ).toBe(true);
  await vi.waitFor(() => expect(f.held).toHaveLength(1));
  const navigation = f.held[0]!;
  f.methods.add("Target.detachFromTarget");
  let finished = false;
  const retirement = f.host.retire(f.a.probe, "target-replaced").then((ok) => {
    finished = true;
    return ok;
  });
  navigation.socket.reply(navigation.command, {
    frameId: "main",
    errorText: "synthetic navigation failure",
  });
  await vi.waitFor(() => expect(f.held).toHaveLength(2));
  const detach = f.held[1]!;
  expect(detach.command.method).toBe("Target.detachFromTarget");
  expect(finished).toBe(false);
  await denied(f.host);
  detach.socket.reply(detach.command);
  expect(await retirement).toBe(true);
  expect(
    f.a.socket.commands.filter((command) => command.method === "Page.navigate"),
  ).toHaveLength(1);
  expect(f.a.replies.filter((reply) => reply.type === "ready")).toHaveLength(0);
  expect(f.browser.sockets).toHaveLength(1);
  const replacement = await f.channel();
  expect(replacement.probe.owner).not.toBe(f.a.probe.owner);
  expect(
    replacement.socket.commands.some(
      (command) => command.method === "Page.navigate",
    ),
  ).toBe(false);
});

it("bounds mixed unconfirmed work when native completions arrive but client acknowledgements are lost", async () => {
  const f = await fixture();
  f.a.drop();
  for (let batch = 0; batch < 4; batch++) {
    const actions: NativeAction[] = Array.from({ length: 16 }, (_, index) => ({
      kind: "text",
      text: `${batch}:${index}`,
    }));
    if (batch === 0)
      actions.splice(
        0,
        4,
        key("Shift"),
        key("Control"),
        pointer,
        preview("pending"),
      );
    if (batch === 3) actions[15] = { kind: "selection", request: 1 };
    expect(f.a.send(actions)).toBe(true);
    await vi.waitFor(() => expect(f.a.completions()).toBe(batch + 1));
  }
  expect(f.a.acks()).toHaveLength(0);
  expect(f.a.probe.peakOutstanding).toBe(64);
  expect(f.a.send([{ kind: "navigate", action: "reload" }])).toBe(false);
  expect(
    f.a.socket.commands.filter((command) => command.method === "Page.reload"),
  ).toHaveLength(0);
  expect(await f.host.retire(f.a.probe)).toBe(false);
  await denied(f.host);
  expect(f.browser.sockets).toHaveLength(1);
});
