import { afterEach, expect, it, vi } from "vitest";
import { ProbeHost } from "../experiments/probe-host";
import type { ProbeReply } from "../experiments/guarded-probe";
import { FakeBrowser } from "./wire";

const hosts: ProbeHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  vi.useRealTimers();
});

const shift = {
  kind: "key",
  key: {
    type: "rawKeyDown",
    key: "Shift",
    code: "ShiftLeft",
    modifiers: 8,
    windowsVirtualKeyCode: 16,
  },
};

function hostFor(browser = new FakeBrowser()) {
  const host = new ProbeHost("wss://fixture.invalid", browser.factory);
  hosts.push(host);
  return { host, browser };
}

async function viewer(host: ProbeHost, targetId = "page-a", windowId = 0) {
  const replies: ProbeReply[] = [];
  let acknowledged = 0;
  const completed = new Set<number>();
  const probe = await host.admit({
    targetId,
    windowId,
    reply: (value) => {
      replies.push(value);
      if (value.type === "ack") {
        completed.add(value.sequence);
        while (completed.delete(acknowledged + 1)) acknowledged++;
      }
    },
  });
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
  return { probe, send, replies };
}

async function press(a: Awaited<ReturnType<typeof viewer>>) {
  expect(a.send(shift)).toBe(true);
  await vi.waitFor(() =>
    expect(a.replies).toContainEqual({ type: "ack", sequence: 1, ok: true }),
  );
}

const replacement = (host: ProbeHost, windowId = 0) =>
  host.admit({ targetId: "page-a", windowId, reply: () => {} });

it("reserves the target before asynchronous setup and rejects overlap", async () => {
  const { host, browser } = hostFor();
  browser.blockOpen = true;
  const opening = viewer(host);
  await expect(replacement(host)).rejects.toThrow("unsettled owner");
  expect(browser.sockets).toHaveLength(1);
  browser.sockets[0]!.open();
  const a = await opening;
  expect(await host.retire(a.probe)).toBe(true);
  await expect(replacement(host)).resolves.toBeDefined();
});

it("cancels pending admission when its host closes without returning a late owner", async () => {
  const { host, browser } = hostFor();
  browser.blockOpen = true;
  const opening = viewer(host);
  host.close();
  await expect(opening).rejects.toThrow();
  expect(browser.sockets[0]!.readyState).toBe(3);
  browser.sockets[0]!.open();
  await expect(replacement(host)).rejects.toThrow("host is closed");
  expect(browser.sockets).toHaveLength(1);
});

it("coalesces retirement, waits for original release, and leaves the sibling live", async () => {
  const { host, browser } = hostFor();
  const a = await viewer(host);
  const b = await viewer(host, "page-b", 2);
  await press(a);
  await press(b);
  const held = a.probe.holdNext("Input.dispatchKeyEvent");
  const receipt = a.probe.retire("paused");
  expect(a.probe.retire("disposed")).toBe(receipt);
  const retiring = host.retire(a.probe);
  await held.held;
  expect(a.send({ kind: "text", text: "discard" })).toBe(false);
  await expect(replacement(host)).rejects.toThrow("unsettled owner");
  const commands = browser.sockets[0]!.commands;
  expect(commands.filter((c) => c.params?.type === "keyUp")).toHaveLength(1);
  expect(commands.some((c) => c.method === "Target.detachFromTarget")).toBe(
    false,
  );
  expect(b.send({ kind: "text", text: "independent" })).toBe(true);
  await vi.waitFor(() =>
    expect(b.replies).toContainEqual({ type: "ack", sequence: 2, ok: true }),
  );
  held.release();
  expect(await retiring).toBe(true);
  expect(
    commands.filter((c) => c.method === "Target.detachFromTarget"),
  ).toHaveLength(1);
  const next = await viewer(host);
  await press(next);
  a.probe.close();
  held.release();
  expect(await host.retire(a.probe)).toBe(false);
  await expect(replacement(host)).rejects.toThrow("unsettled owner");
  expect(commands.filter((c) => c.params?.type === "keyUp")).toHaveLength(1);
});

it("waits for an already-dispatched native effect as well as its cleanup", async () => {
  const { host, browser } = hostFor();
  const a = await viewer(host);
  const held = a.probe.holdNext("Input.dispatchKeyEvent");
  a.send(shift);
  await held.held;
  const retiring = host.retire(a.probe);
  await expect(replacement(host)).rejects.toThrow("unsettled owner");
  expect(
    browser.sockets[0]!.commands.some((c) => c.params?.type === "keyUp"),
  ).toBe(true);
  held.release();
  expect(await retiring).toBe(true);
});

it("discards queued input across real membership changes and stale continuations", async () => {
  const { host, browser } = hostFor();
  const a = await viewer(host);
  await press(a);
  const held = a.probe.holdNext("Browser.getWindowForTarget");
  a.send({ kind: "text", text: "unsent old edit" });
  await held.held;
  browser.targets[0]!.windowId = 2;
  expect(await host.retire(a.probe, "target-replaced")).toBe(true);
  const next = await viewer(host, "page-a", 2);
  await press(next);
  held.release();
  a.probe.close();
  expect(a.send({ kind: "text", text: "late old edit" })).toBe(false);
  expect(next.send({ kind: "text", text: "new edit" })).toBe(true);
  await vi.waitFor(() =>
    expect(next.replies).toContainEqual({ type: "ack", sequence: 2, ok: true }),
  );
  expect(
    browser.sockets[0]!.commands.some((c) => c.method === "Input.insertText"),
  ).toBe(false);
});

it("requires a positive detach reply before replacement", async () => {
  const { host, browser } = hostFor();
  const a = await viewer(host);
  browser.holdMethod = "Target.detachFromTarget";
  const retiring = host.retire(a.probe);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  await expect(replacement(host)).rejects.toThrow("unsettled owner");
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command);
  expect(await retiring).toBe(true);
});

it("keeps denied cleanup unavailable instead of reconnecting or replaying", async () => {
  const { host, browser } = hostFor();
  const a = await viewer(host);
  await press(a);
  browser.holdMethod = "Input.dispatchKeyEvent";
  const retiring = host.retire(a.probe);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  const held = browser.heldCommands[0]!;
  held.socket.reject(held.command, -32000);
  expect(await retiring).toBe(false);
  await expect(replacement(host)).rejects.toThrow("unsettled owner");
  expect(browser.sockets).toHaveLength(1);
  expect(a.send({ kind: "text", text: "never replay" })).toBe(false);
});

it("revokes a failed native effect without dispatching or acknowledging queued text", async () => {
  const { host, browser } = hostFor();
  const a = await viewer(host);
  browser.holdMethod = "Input.dispatchKeyEvent";
  a.send(shift);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  const scope = a.probe.holdNext("Browser.getWindowForTarget");
  a.send({ kind: "text", text: "unsent" });
  await scope.held;
  const native = browser.heldCommands[0]!;
  native.socket.reject(native.command, -32000);
  expect(await host.retire(a.probe)).toBe(false);
  scope.release();
  expect(a.replies).toContainEqual({ type: "revoked" });
  expect(a.replies.some((v) => v.type === "ack" && v.sequence === 2)).toBe(
    false,
  );
  expect(
    native.socket.commands.some((c) => c.method === "Input.insertText"),
  ).toBe(false);
  await expect(replacement(host)).rejects.toThrow("unsettled owner");
});

it("treats CDP loss during cleanup as unknown while the sibling still edits", async () => {
  const { host, browser } = hostFor();
  const a = await viewer(host);
  const b = await viewer(host, "page-b", 2);
  await press(a);
  const held = a.probe.holdNext("Input.dispatchKeyEvent");
  const retiring = host.retire(a.probe);
  await held.held;
  browser.sockets[0]!.close();
  expect(await retiring).toBe(false);
  held.release();
  await expect(replacement(host)).rejects.toThrow("unsettled owner");
  expect(b.send({ kind: "text", text: "still live" })).toBe(true);
  await vi.waitFor(() => expect(b.replies).toHaveLength(1));
});

it("expires missing cleanup without turning a timeout into a handover receipt", async () => {
  const { host, browser } = hostFor();
  const a = await viewer(host);
  await press(a);
  vi.useFakeTimers();
  const held = a.probe.holdNext("Input.dispatchKeyEvent");
  const retiring = host.retire(a.probe);
  await vi.advanceTimersByTimeAsync(0);
  await held.held;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await retiring).toBe(false);
  expect(browser.sockets[0]!.readyState).toBe(3);
  held.release();
  await expect(replacement(host)).rejects.toThrow("unsettled owner");
});

it("retains an unavailable reservation after failed setup", async () => {
  const { host, browser } = hostFor();
  browser.unsupportedWindows = true;
  await expect(viewer(host)).rejects.toThrow();
  browser.unsupportedWindows = false;
  await expect(replacement(host)).rejects.toThrow("unsettled owner");
  expect(browser.sockets).toHaveLength(1);
});

it("can confirm remote cleanup after the viewer reply channel has disappeared", async () => {
  const { host, browser } = hostFor();
  let viewerGone = false;
  let sequence = 0;
  const probe = await host.admit({
    targetId: "page-a",
    windowId: 0,
    reply: (value) => {
      if (viewerGone) throw new Error("Fixture viewer channel is closed");
      if (value.type === "ack") sequence = value.sequence;
    },
  });
  expect(
    probe.receive(
      JSON.stringify({
        owner: probe.owner,
        sequence: 1,
        acknowledged: 0,
        ...shift,
      }),
    ),
  ).toBe(true);
  await vi.waitFor(() => expect(sequence).toBe(1));
  viewerGone = true;
  const held = probe.holdNext("Input.dispatchKeyEvent");
  const retiring = host.retire(probe);
  await held.held;
  held.release();
  expect(await retiring).toBe(true);
  expect(
    browser.sockets[0]!.commands.filter((c) => c.params?.type === "keyUp"),
  ).toHaveLength(1);
});
