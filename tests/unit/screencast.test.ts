import { afterEach, expect, it, vi } from "vitest";
import { CdpClient } from "../../src/cdp/client";
import { CdpFault } from "../../src/cdp/errors";
import { defaultCapture } from "../../src/viewer/capture";
import { Screencast } from "../../src/viewer/screencast";
import { FakeSocket } from "./wire";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((close) => close());
  vi.useRealTimers();
});

async function stream() {
  const socket = new FakeSocket();
  const client = new CdpClient("wss://fixture.invalid/", () =>
    socket.asWebSocket(),
  );
  socket.open();
  await client.opened;
  const sink = {
    push: vi.fn<
      (
        data: string,
        painted: () => void,
        failed: (error: CdpFault) => void,
      ) => void
    >(),
    invalidate: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
  const failed = vi.fn();
  const capture = new Screencast(
    { client, sessionId: "owned", sink, current: () => true, failed },
    defaultCapture,
  );
  cleanup.push(() => {
    capture.dispose();
    client.close();
  });
  const ready = capture.start();
  return { socket, sink, failed, capture, ready };
}

it("keeps a frame painted before the initial start reply and cancels its deadline", async () => {
  vi.useFakeTimers();
  const { socket, sink, capture, failed } = await stream();
  capture.push("first", () => {});
  sink.push.mock.calls[0]![1]();
  socket.reply(socket.commands[0]!);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(failed).not.toHaveBeenCalled();
});

it("rejects old paint/error continuations while accepting a static restart frame before its reply", async () => {
  vi.useFakeTimers();
  const { socket, sink, capture, failed } = await stream();
  const oldPaint = vi.fn();
  capture.push("old", oldPaint);
  const old = sink.push.mock.calls[0]!;
  socket.reply(socket.commands[0]!);
  await vi.advanceTimersByTimeAsync(0);
  capture.configure({ ...defaultCapture, quality: 50 });
  expect(sink.invalidate).toHaveBeenCalledOnce();
  old[1]();
  old[2](new CdpFault("frame", "Old frame failed."));
  expect(oldPaint).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  socket.reply(socket.commands.at(-1)!);
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.commands.at(-1)?.method).toBe("Page.startScreencast");
  const painted = vi.fn();
  capture.push("new", painted);
  sink.push.mock.calls.at(-1)![1]();
  socket.reply(socket.commands.at(-1)!);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(painted).toHaveBeenCalledOnce();
  expect(failed).not.toHaveBeenCalled();
  expect(sink.reset).not.toHaveBeenCalled();
});

it("fails an acknowledged restart that produces no painted frame", async () => {
  vi.useFakeTimers();
  const { socket, sink, capture, failed } = await stream();
  capture.push("first", () => {});
  sink.push.mock.calls[0]![1]();
  socket.reply(socket.commands[0]!);
  await vi.advanceTimersByTimeAsync(0);
  capture.configure({ ...defaultCapture, maxWidth: 1280 });
  socket.reply(socket.commands.at(-1)!);
  await vi.advanceTimersByTimeAsync(0);
  socket.reply(socket.commands.at(-1)!);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(failed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ kind: "frame" }),
  );
});

it("stops original-session work on disposal without starting a queued configuration", async () => {
  const { socket, capture, failed } = await stream();
  capture.configure({ ...defaultCapture, quality: 35 });
  capture.dispose();
  socket.reply(socket.commands[0]!);
  await vi.waitFor(() =>
    expect(socket.commands.at(-1)).toMatchObject({
      method: "Page.stopScreencast",
      sessionId: "owned",
    }),
  );
  expect(
    socket.commands.filter((c) => c.method === "Page.startScreencast"),
  ).toHaveLength(1);
  expect(failed).not.toHaveBeenCalled();
});

it("retains dispatched settings while coalescing changes behind a held start reply", async () => {
  vi.useFakeTimers();
  const { socket, capture } = await stream();
  capture.configure({ ...defaultCapture, quality: 50 });
  capture.configure({ ...defaultCapture, quality: 85 });
  expect(socket.commands).toHaveLength(1);
  expect(socket.commands[0]!.params?.quality).toBe(70);
  socket.reply(socket.commands[0]!);
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.commands.at(-1)?.method).toBe("Page.stopScreencast");
  socket.reply(socket.commands.at(-1)!);
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.commands.at(-1)).toMatchObject({
    method: "Page.startScreencast",
    params: { quality: 85 },
  });
  expect(
    socket.commands.filter((c) => c.method === "Page.startScreencast"),
  ).toHaveLength(2);
});

it("reports a failed restart once without retrying its uncertain capture request", async () => {
  vi.useFakeTimers();
  const { socket, capture, failed } = await stream();
  socket.reply(socket.commands[0]!);
  await vi.advanceTimersByTimeAsync(0);
  capture.configure({ ...defaultCapture, quality: 50 });
  socket.reject(socket.commands.at(-1)!, -32000);
  await vi.advanceTimersByTimeAsync(0);
  expect(failed).toHaveBeenCalledOnce();
  expect(
    socket.commands.filter((c) => c.method === "Page.startScreencast"),
  ).toHaveLength(1);
  capture.configure(defaultCapture);
  expect(
    socket.commands.filter((c) => c.method === "Page.startScreencast"),
  ).toHaveLength(1);
});

it("joins capture configuration before an exclusive native refresh and retains the latest update", async () => {
  vi.useFakeTimers();
  const { socket, capture } = await stream();
  let prepared!: () => void;
  const preparation = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const native = capture.exclusive(async () => {
    await capture.stop();
    await preparation;
    await capture.begin({ ...defaultCapture, quality: 80 }, false);
  });
  capture.configure({ ...defaultCapture, quality: 35 });
  expect(socket.commands).toHaveLength(1);
  socket.reply(socket.commands[0]!);
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.commands.at(-1)?.method).toBe("Page.stopScreencast");
  socket.reply(socket.commands.at(-1)!);
  await vi.advanceTimersByTimeAsync(0);
  capture.configure({ ...defaultCapture, quality: 45 });
  expect(
    socket.commands.filter((c) => c.method === "Page.startScreencast"),
  ).toHaveLength(1);
  prepared();
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.commands.at(-1)).toMatchObject({
    method: "Page.startScreencast",
    params: { quality: 80 },
  });
  socket.reply(socket.commands.at(-1)!);
  await native;
  expect(socket.commands.at(-1)?.method).toBe("Page.stopScreencast");
  socket.reply(socket.commands.at(-1)!);
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.commands.at(-1)).toMatchObject({
    method: "Page.startScreencast",
    params: { quality: 45 },
  });
});
