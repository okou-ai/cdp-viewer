import { afterEach, expect, it, vi } from "vitest";
import { TransportLink } from "../experiments/transport-link";

afterEach(() => vi.useRealTimers());

it("gives split sockets one aggregate bandwidth budget and preserves per-socket FIFO", async () => {
  vi.useFakeTimers();
  const link = new TransportLink(true);
  const a = {},
    b = {};
  const delivered: string[] = [];
  link.downlink(a, 64 * 1024, () => delivered.push("a-frame"));
  link.downlink(a, 1, () => delivered.push("a-reply"));
  link.downlink(b, 64 * 1024, () => delivered.push("b-frame"));
  await vi.advanceTimersByTimeAsync(130);
  // Two independent 1 MiB/s budgets would have delivered both frames by now.
  expect(delivered).toEqual([]);
  await vi.advanceTimersByTimeAsync(55);
  expect(delivered).toEqual(["a-frame", "b-frame", "a-reply"]);
  link.close();
});

it("cancels pending propagation and queued delivery on cleanup", async () => {
  vi.useFakeTimers();
  const link = new TransportLink(true);
  const delivered = vi.fn();
  link.uplink(delivered);
  link.downlink({}, 100_000, delivered);
  link.close();
  await vi.runAllTimersAsync();
  expect(delivered).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
