import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpClient } from "../../src/cdp/client";
import { FakeSocket } from "./wire";

const clients: CdpClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  vi.useRealTimers();
});

async function connected(timeout = 1000) {
  const socket = new FakeSocket();
  const client = new CdpClient(
    "wss://fixture.invalid",
    () => socket.asWebSocket(),
    timeout,
  );
  clients.push(client);
  socket.open();
  await client.opened;
  return { client, socket };
}

describe("CDP transport ownership", () => {
  it("correlates out-of-order replies and routes outer session IDs", async () => {
    const { client, socket } = await connected();
    const first = client.request("Browser.getVersion", undefined);
    const second = client.request("Target.getTargets", undefined);
    socket.reply(socket.commands[1]!, { targetInfos: [] });
    socket.reply(socket.commands[0]!, { product: "Fixture" });
    expect(await first).toMatchObject({ product: "Fixture" });
    expect(await second).toEqual({ targetInfos: [] });
    const listener = vi.fn();
    const unsubscribe = client.onEvent(listener);
    socket.emit("Vendor.futureEvent", { targetId: "x" }, "outer-session");
    expect(listener).toHaveBeenCalledWith({
      method: "Vendor.futureEvent",
      params: { targetId: "x" },
      sessionId: "outer-session",
    });
    unsubscribe();
    socket.emit("Vendor.futureEvent", {}, "outer-session");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects timeouts while retaining bounded late attachment cleanup", async () => {
    vi.useFakeTimers();
    const { client, socket } = await connected(30);
    const released = vi.fn();
    const result = client.request(
      "Target.attachToTarget",
      { targetId: "x", flatten: true },
      undefined,
      released,
    );
    const rejected = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    socket.reply(socket.commands[0]!, { sessionId: "late-session" });
    await Promise.resolve();
    expect(released).toHaveBeenCalledWith({ sessionId: "late-session" });
  });

  it("bounds expired attachment owners by closing an exhausted connection", async () => {
    vi.useFakeTimers();
    const { client, socket } = await connected(10);
    const pending = Array.from({ length: 256 }, () =>
      client
        .request(
          "Target.attachToTarget",
          { targetId: "x", flatten: true },
          undefined,
          () => {},
        )
        .catch(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(pending);
    await expect(
      client.request("Browser.getVersion", undefined),
    ).rejects.toThrow("Too many pending");
    expect(socket.readyState).toBe(3);
  });

  it("rejects outstanding work and removes listeners on disconnect without replay", async () => {
    const { client, socket } = await connected();
    const pending = client.request("Browser.getVersion", undefined);
    const observed = expect(pending).rejects.toThrow("disconnected");
    const closed = vi.fn();
    const event = vi.fn();
    client.onDisconnected(closed);
    client.onEvent(event);
    socket.close();
    await observed;
    socket.emit("Target.targetCreated", {});
    expect(event).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(socket.commands).toHaveLength(1);
  });

  it("redacts provider errors and handles malformed messages", async () => {
    const { client, socket } = await connected();
    const request = client.request("Browser.getVersion", undefined);
    socket.reject(socket.commands[0]!);
    await expect(request).rejects.toThrow("CDP request failed.");
    const next = client.request("Browser.getVersion", undefined);
    socket.dispatchEvent(
      new MessageEvent("message", { data: "not-json with secret" }),
    );
    await expect(next).rejects.toThrow("Invalid CDP JSON");
    expect(socket.readyState).toBe(3);
  });
});
