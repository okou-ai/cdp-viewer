import { afterEach, expect, it, vi } from "vitest";
import { CdpClient } from "../../src/cdp/client";
import { InputEffects } from "../../src/input/effects";
import { InputSession } from "../../src/input/session";
import { FakeBrowser } from "./wire";

const clients: CdpClient[] = [];
afterEach(() => clients.splice(0).forEach((client) => client.close()));
const shift = { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" } as const;

async function fixture() {
  const browser = new FakeBrowser();
  const client = new CdpClient("wss://fixture.invalid", browser.factory);
  clients.push(client);
  await client.opened;
  let selected = true;
  const isCurrent = vi.fn(() => selected);
  const reset = vi.fn();
  const input = new InputSession(
    client,
    "original-session",
    isCurrent,
    () => {},
    reset,
    () => {},
    () => {},
  );
  client.onEvent((event) => input.event(event));
  client.onDisconnected(() => input.dispose("disconnected"));
  await input.start();
  return {
    browser,
    client,
    input,
    isCurrent,
    reset,
    move: () => {
      selected = false;
    },
    socket: browser.sockets[0]!,
  };
}

it("joins sent effects without acquiring current selection authority", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Input.dispatchKeyEvent";
  const owner = a.input.owner!;
  a.input.key(shift);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  const checked = a.isCurrent.mock.calls.length;
  a.move();
  const complete = a.input.completion(owner);
  const held = a.browser.heldCommands[0]!;
  held.socket.reply(held.command);
  await expect(complete).resolves.toBeUndefined();
  expect(a.isCurrent).toHaveBeenCalledTimes(checked);
});

it("publishes terminal admission before callbacks and joins original replies while a sibling progresses", async () => {
  const a = await fixture();
  const b = await fixture();
  a.browser.holdMethod = "Input.dispatchKeyEvent";
  a.input.key(shift);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  a.reset.mockImplementation(() => {
    a.input.key(shift);
    a.input.text("reentrant edit");
  });
  a.move();
  const retirement = a.input.retire("target-replaced");
  expect(a.input.retire("paused")).toBe(retirement);
  expect(a.input.owner).toBeNull();
  a.input.text("late edit");
  a.input.navigate({ url: "https://fixture.invalid/replay" });
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(2));
  let settled = false;
  retirement.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const cleanup = a.browser.heldCommands[1]!;
  cleanup.socket.reply(cleanup.command);
  b.input.text("sibling edit");
  await b.input.completion(b.input.owner!);
  expect(settled).toBe(false);
  const original = a.browser.heldCommands[0]!;
  original.socket.reply(original.command);
  await retirement;
  expect(a.input.available).toBe(false);
  expect(
    a.socket.commands
      .filter((command) => command.method.startsWith("Input."))
      .map((command) => command.params?.type),
  ).toEqual(["rawKeyDown", "keyUp"]);
  expect(
    b.socket.commands.filter(
      (command) => command.method === "Input.insertText",
    ),
  ).toHaveLength(1);
});

it("retains a late composition finally cleanup in the original completion fence", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Input.imeSetComposition";
  a.input.preedit("owned preview", a.input.owner!);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  const checked = a.isCurrent.mock.calls.length;
  const retiring = a.input.retire();
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(2));
  const cleanup = a.browser.heldCommands[1]!;
  cleanup.socket.reply(cleanup.command);
  const original = a.browser.heldCommands[0]!;
  original.socket.reply(original.command);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(3));
  let settled = false;
  retiring.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  expect(settled).toBe(false);
  const late = a.browser.heldCommands[2]!;
  expect(late.command.params?.text).toBe("");
  expect(late.command.sessionId).toBe(original.command.sessionId);
  late.socket.reply(late.command);
  await retiring;
  expect(a.isCurrent).toHaveBeenCalledTimes(checked);
});

it.each(["denied", "missing", "null", "array", "ambiguous"] as const)(
  "never confirms %s cleanup or retries it",
  async (kind) => {
    const a = await fixture();
    a.input.key(shift);
    await a.input.completion(a.input.owner!);
    a.browser.holdMethod = "Input.dispatchKeyEvent";
    const retiring = a.input.retire();
    const rejected = expect(retiring).rejects.toThrow();
    await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
    const held = a.browser.heldCommands[0]!;
    if (kind === "denied") held.socket.reject(held.command, -32000);
    else
      held.socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            id: held.command.id,
            ...(kind === "missing"
              ? {}
              : {
                  result: kind === "null" ? null : kind === "array" ? [] : {},
                  ...(kind === "ambiguous" ? { error: { code: -32000 } } : {}),
                }),
          }),
        }),
      );
    await rejected;
    expect(a.input.owner).toBeNull();
    expect(
      a.socket.commands.filter(
        (command) => command.method === "Input.dispatchKeyEvent",
      ),
    ).toHaveLength(2);
  },
);

it("rejects unsupported cleanup received before a late positive original IME reply", async () => {
  const a = await fixture();
  a.browser.holdMethod = "Input.imeSetComposition";
  a.input.preedit("pending support", a.input.owner!);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(1));
  const retirement = a.input.retire();
  const rejected = expect(retirement).rejects.toThrow("unconfirmed");
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(2));
  const cleanup = a.browser.heldCommands[1]!;
  cleanup.socket.reject(cleanup.command, -32601);
  const original = a.browser.heldCommands[0]!;
  original.socket.reply(original.command);
  await vi.waitFor(() => expect(a.browser.heldCommands).toHaveLength(3));
  const late = a.browser.heldCommands[2]!;
  late.socket.reply(late.command);
  await rejected;
});

it("bounds physical effect receipts independently of another connection", async () => {
  const a = await fixture();
  const b = await fixture();
  a.browser.holdMethod = "Input.insertText";
  const effects = new InputEffects(a.client, "original-session");
  const pending = Array.from({ length: 128 }, () =>
    effects
      .request("Input.insertText", { text: "fixture" })
      .catch(() => undefined),
  );
  await expect(
    effects.request("Input.insertText", { text: "overflow" }),
  ).rejects.toThrow("Too many pending input effects.");
  await Promise.all(pending);
  await expect(effects.completion()).rejects.toThrow("unconfirmed");
  expect(
    a.socket.commands.filter(
      (command) => command.method === "Input.insertText",
    ),
  ).toHaveLength(128);
  b.input.text("independent");
  await b.input.completion(b.input.owner!);
  expect(b.socket.readyState).toBe(1);
});
