import { afterEach, expect, it, vi } from "vitest";
import { CdpClient } from "../../src/cdp/client";
import { InputIngress } from "../../src/input/ingress";
import { InputSession } from "../../src/input/session";
import { FakeBrowser } from "./wire";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});

async function session() {
  const browser = new FakeBrowser();
  const client = new CdpClient("wss://fixture.invalid", browser.factory);
  cleanup.push(() => client.close());
  await client.opened;
  const reset = vi.fn();
  const clipboard = vi.fn();
  const error = vi.fn();
  const input = new InputSession(
    client,
    "native",
    async () => true,
    vi.fn(),
    reset,
    vi.fn(),
    error,
    clipboard,
  );
  cleanup.push(() => input.dispose());
  await input.start();
  await input.completion(input.owner!);
  return {
    input,
    browser,
    socket: browser.sockets[0]!,
    reset,
    clipboard,
    error,
  };
}

it.each(["key", "press", "text", "preedit", "commit"])(
  "retains the original %s owner across a reentrant clipboard invalidation",
  async (kind) => {
    const first = await session();
    const ingress = new InputIngress(
      () => first.input,
      () => null,
    );
    cleanup.push(() => ingress.dispose());
    const input = ingress.boundary()!;
    const owner = input.owner!;
    first.clipboard.mockImplementationOnce(() => first.input.blur());
    const start = first.socket.commands.length;
    if (kind === "key")
      input.key({ type: "rawKeyDown", key: "a", code: "KeyA" });
    else if (kind === "press")
      input.pointer("mousePressed", { x: 0.5, y: 0.5 }, { button: "left" });
    else if (kind === "text") input.text("old", owner);
    else if (kind === "preedit") input.preedit("old", owner);
    else input.commitComposition("old", owner);
    expect(first.input.owner).not.toBe(owner);
    expect(input.owner).toBeNull();
    await first.input.completion(first.input.owner!);
    expect(
      first.socket.commands
        .slice(start)
        .filter((c) => c.method.startsWith("Input.")),
    ).toHaveLength(0);
    const fresh = ingress.boundary()!;
    fresh.key({ type: "rawKeyDown", key: "b", code: "KeyB" });
    await first.input.completion(first.input.owner!);
    expect(
      first.socket.commands
        .slice(start)
        .filter((c) => c.method === "Input.dispatchKeyEvent")
        .map((c) => c.params?.key),
    ).toEqual(["b"]);
  },
);

it.each(["generation", "replacement"])(
  "rejects every old capability after %s and still accepts fresh input",
  async (change) => {
    const first = await session(),
      next = await session();
    let current = first.input;
    const ingress = new InputIngress(
      () => current,
      () => null,
    );
    cleanup.push(() => ingress.dispose());
    const old = ingress.boundary()!,
      owner = old.owner!;
    if (change === "generation") first.input.blur();
    else current = next.input;
    await first.input.completion(first.input.owner!);
    const a = first.socket.commands.length,
      b = next.socket.commands.length;
    const diagnostics = first.error.mock.calls.length;
    old.focus();
    old.blur();
    old.pointer("mousePressed", { x: 0.5, y: 0.5 }, { button: "left" });
    old.key({ type: "rawKeyDown", key: "a" });
    old.text("old");
    old.preedit("old", owner);
    old.commitComposition("old", owner);
    old.clipboardError("old");
    await expect(old.selection(owner)).rejects.toThrow("Selection cancelled");
    await current.completion(current.owner!);
    expect(first.socket.commands.slice(a)).toHaveLength(0);
    expect(next.socket.commands.slice(b)).toHaveLength(0);
    expect(first.error.mock.calls).toHaveLength(diagnostics);
    const fresh = ingress.boundary()!;
    fresh.text("fresh");
    await current.completion(current.owner!);
    const wire = change === "generation" ? first.socket : next.socket;
    expect(
      wire.commands
        .filter((c) => c.method === "Input.insertText")
        .map((c) => c.params?.text),
    ).toEqual(["fresh"]);
  },
);

it("retains the clipboard Event's binding across capture and bubble replacement", async () => {
  const first = await session(),
    next = await session();
  let current = first.input;
  const ingress = new InputIngress(
    () => current,
    () => null,
  );
  cleanup.push(() => ingress.dispose());
  const event = new Event("copy");
  const captured = ingress.boundary(event)!;
  current = next.input;
  expect(ingress.boundary(event)).toBeNull();
  expect(captured.owner).toBeNull();
  const fresh = ingress.boundary(new Event("copy"))!;
  expect(fresh.owner).toBe(next.input.owner);
});

it("does not bind navigation to a generation created by a reset callback", async () => {
  const first = await session();
  first.reset.mockImplementationOnce(() => first.input.blur());
  const start = first.socket.commands.length;
  first.input.navigate("reload");
  await first.input.completion(first.input.owner!);
  expect(
    first.socket.commands
      .slice(start)
      .filter((c) => c.method === "Page.reload"),
  ).toHaveLength(0);
  first.input.navigate("reload");
  await first.input.completion(first.input.owner!);
  expect(
    first.socket.commands
      .slice(start)
      .filter((c) => c.method === "Page.reload"),
  ).toHaveLength(1);
});

it.each(["generation", "replacement"])(
  "rejects a composing pointer restart if its cleanup causes another %s",
  async (change) => {
    const first = await session(),
      next = await session();
    let current = first.input;
    const ingress = new InputIngress(
      () => current,
      () => null,
    );
    cleanup.push(() => ingress.dispose());
    first.reset.mockImplementationOnce(() => {
      if (change === "generation") first.input.blur();
      else current = next.input;
    });
    expect(ingress.pointerBoundary(10, 10, 0, true)).toBeNull();
    expect(ingress.boundary()?.owner).toBe(current.owner);
  },
);

it("binds an intentional composing pointer restart to its published generation", async () => {
  const first = await session();
  const ingress = new InputIngress(
    () => first.input,
    () => null,
  );
  cleanup.push(() => ingress.dispose());
  const original = first.input.owner;
  const restarted = ingress.pointerBoundary(10, 10, 0, true)!;
  expect(restarted.owner).not.toBe(original);
  expect(restarted.owner).toBe(first.input.owner);
  restarted.pointer("mousePressed", { x: 0.5, y: 0.5 }, { button: "left" });
  await first.input.completion(first.input.owner!);
  expect(
    first.socket.commands
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params?.type),
  ).toEqual(["mousePressed"]);
});

it("publishes terminal ingress admission before disposal cleanup callbacks", async () => {
  const first = await session();
  const ingress = new InputIngress(
    () => first.input,
    () => null,
  );
  const captured = ingress.boundary()!;
  first.reset.mockImplementationOnce(() => {
    expect(ingress.boundary()).toBeNull();
    captured.text("retired");
  });
  ingress.dispose();
  expect(ingress.current()).toBeNull();
  await first.input.completion(first.input.owner!);
  expect(
    first.socket.commands.filter((c) => c.method === "Input.insertText"),
  ).toHaveLength(0);
});
