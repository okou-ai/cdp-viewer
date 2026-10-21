import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpClient } from "../../src/cdp/client";
import { TargetDirectory } from "../../src/cdp/targets";
import { FaviconDirectory } from "../../src/viewer/favicons";
import { createViewerModel } from "../../src/viewer/model";
import { parseIcons } from "../../src/viewer/favicon-declarations";
import { FakeSocket } from "./wire";
import type { WireCommand } from "./wire";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

async function fixture(ids = ["a"], windowId?: number) {
  const lifetime = new AbortController();
  let nextSession = 0;
  let nextStream = 0;
  let hold: string | null = null;
  let oversized = false;
  let largeStream = false;
  let membership = 0;
  let churn = 0;
  const held: WireCommand[] = [];
  const pages = new Map(
    ids.map((id) => [
      id,
      {
        url: `https://owned.invalid/${id}`,
        loader: "first",
        candidates: [{ url: `https://owned.invalid/${id}.png`, size: 16 }],
      },
    ]),
  );
  const sessions = new Map<string, string>();
  const streams = new Map<
    string,
    { url: string; sessionId: string | undefined }
  >();
  const socket = new FakeSocket((command, wire) => {
    queueMicrotask(() => {
      if (command.method === hold) {
        held.push(command);
        return;
      }
      const id = sessions.get(command.sessionId ?? "") ?? "a";
      const page = pages.get(id)!;
      switch (command.method) {
        case "Browser.getWindowForTarget":
          wire.reply(command, { windowId: membership });
          break;
        case "Target.attachToTarget": {
          const sessionId = `icons-${++nextSession}`;
          sessions.set(sessionId, command.params!.targetId as string);
          wire.reply(command, { sessionId });
          break;
        }
        case "Page.getFrameTree":
          wire.reply(command, {
            frameTree: { frame: { id: "main", loaderId: page.loader } },
          });
          break;
        case "Page.createIsolatedWorld":
          wire.reply(command, { executionContextId: 42 });
          break;
        case "Runtime.evaluate":
          if (churn > 0) {
            page.candidates[0]!.url = `https://owned.invalid/churn-${churn--}.png`;
          }
          wire.reply(command, {
            result: { value: { url: page.url, candidates: page.candidates } },
          });
          break;
        case "Network.loadNetworkResource": {
          const stream = `stream-${++nextStream}`;
          streams.set(stream, {
            url: String(command.params!.url),
            sessionId: command.sessionId,
          });
          wire.reply(command, {
            resource: {
              success: true,
              stream,
              headers: { "Content-Type": "image/png" },
            },
          });
          break;
        }
        case "IO.read":
          if (
            streams.get(String(command.params!.handle))?.sessionId !==
            command.sessionId
          ) {
            wire.reject(command, -32000);
            break;
          }
          wire.reply(command, {
            data: oversized
              ? "x".repeat(48 * 1024 + 1)
              : largeStream
                ? btoa("x".repeat(32 * 1024))
                : btoa(streams.get(String(command.params!.handle))!.url),
            base64Encoded: true,
            eof: !largeStream,
          });
          break;
        default:
          wire.reply(command);
      }
    });
  });
  const client = new CdpClient(
    "wss://owned.invalid",
    () => socket.asWebSocket(),
    500,
  );
  socket.open();
  await client.opened;
  const publish = vi.fn();
  const decode = vi.fn(async (blob: Blob, signal: AbortSignal) => {
    signal.throwIfAborted();
    // Happy DOM's Blob does not implement text; the wire tests only need identity.
    if (blob.size === 0) throw new Error("Invalid image");
    return { src: "data:image/png;base64,owned", size: 16 };
  });
  const icons = new FaviconDirectory(
    client,
    new TargetDirectory(client, windowId),
    lifetime.signal,
    publish,
    decode,
  );
  client.onEvent((event) => icons.event(event));
  icons.reconcile(ids);
  const start = () => icons.setPaused(false);
  cleanups.push(() => {
    lifetime.abort();
    client.close();
  });
  return {
    icons,
    socket,
    publish,
    decode,
    pages,
    held,
    start,
    hold: (method: string | null) => {
      hold = method;
    },
    oversized: () => {
      oversized = true;
    },
    largeStream: () => {
      largeStream = true;
    },
    membership: (value: number) => {
      membership = value;
    },
    churn: (count: number) => {
      churn = count;
    },
    commands: (method: string) =>
      socket.commands.filter((command) => command.method === method),
  };
}

describe("optional favicon work", () => {
  it("reuses sessions/signatures across polling and refresh without activating tabs", async () => {
    vi.useFakeTimers();
    const f = await fixture(["a", "b"]);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.publish).toHaveBeenCalledWith("a", "data:image/png;base64,owned");
    expect(f.publish).toHaveBeenCalledWith("b", "data:image/png;base64,owned");
    f.icons.reconcile(["a", "b"]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.commands("Target.attachToTarget")).toHaveLength(2);
    expect(f.commands("Network.loadNetworkResource")).toHaveLength(2);
    expect(f.commands("Page.getFrameTree")).toHaveLength(2);
    expect(f.commands("Page.createIsolatedWorld")).toHaveLength(2);
    expect(f.commands("IO.close")).toHaveLength(2);
    expect(f.commands("Target.activateTarget")).toHaveLength(0);
    expect(f.commands("Page.startScreencast")).toHaveLength(0);
    expect(f.commands("Network.loadNetworkResource")[0]!.params).toMatchObject({
      options: { includeCredentials: true },
    });
  });

  it("limits concurrent work and disables timed-out optional requests before exhausting the wire", async () => {
    vi.useFakeTimers();
    const f = await fixture(Array.from({ length: 20 }, (_, i) => String(i)));
    f.hold("Target.attachToTarget");
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.held).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.held).toHaveLength(4);
    expect(f.socket.readyState).toBe(1);
    for (const [index, command] of f.held.entries())
      f.socket.reply(command, { sessionId: `late-${index}` });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      f
        .commands("Target.detachFromTarget")
        .map((command) => command.params!.sessionId),
    ).toEqual(["late-0", "late-1", "late-2", "late-3"]);
  });

  it("isolates an unsupported icon command from the shared connection", async () => {
    vi.useFakeTimers();
    const f = await fixture(["a", "b"]);
    f.hold("Page.createIsolatedWorld");
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.held).toHaveLength(2);
    for (const command of f.held) f.socket.reject(command, -32601);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.commands("Target.attachToTarget")).toHaveLength(2);
    expect(f.commands("Target.detachFromTarget")).toHaveLength(2);
    expect(f.socket.readyState).toBe(1);
    expect(f.publish.mock.calls.every(([, src]) => src === null)).toBe(true);
  });

  it.each(["active", "timed-out"])(
    "releases %s evaluation exception handles through their owning session",
    async (state) => {
      vi.useFakeTimers();
      const f = await fixture();
      f.hold("Runtime.evaluate");
      f.start();
      await vi.advanceTimersByTimeAsync(0);
      const evaluation = f.held[0]!;
      if (state === "timed-out") await vi.advanceTimersByTimeAsync(500);
      f.socket.reply(evaluation, {
        result: { objectId: "result-object" },
        exceptionDetails: {
          text: "owned exception",
          exception: { objectId: "exception-object" },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(
        f
          .commands("Runtime.releaseObject")
          .map((command) => [command.sessionId, command.params!.objectId]),
      ).toEqual([
        [evaluation.sessionId, "result-object"],
        [evaluation.sessionId, "exception-object"],
      ]);
      expect(f.publish.mock.calls.every(([, src]) => src === null)).toBe(true);
    },
  );

  it("closes delayed streams and rejects results after navigation or scope loss", async () => {
    vi.useFakeTimers();
    const f = await fixture(["a"], 0);
    f.hold("Network.loadNetworkResource");
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.held).toHaveLength(1);
    f.membership(9);
    f.socket.emit(
      "Page.frameNavigated",
      { frame: { id: "main", loaderId: "new" } },
      f.held[0]!.sessionId,
    );
    f.socket.reply(f.held[0]!, {
      resource: { success: true, stream: "late-stream" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.commands("IO.close")).toContainEqual(
      expect.objectContaining({ params: { handle: "late-stream" } }),
    );
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.publish.mock.calls.every(([, src]) => src === null)).toBe(true);
  });

  it("rechecks same-document declarations before publishing and later reloads the changed icon", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.hold("IO.read");
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    const page = f.pages.get("a")!;
    page.candidates[0]!.url = "https://owned.invalid/changed.png";
    f.hold(null);
    f.socket.reply(f.held[0]!, {
      data: btoa("old"),
      base64Encoded: true,
      eof: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.commands("Network.loadNetworkResource")).toHaveLength(1);
    expect(f.publish.mock.calls.filter(([, src]) => src !== null)).toHaveLength(
      0,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      f
        .commands("Network.loadNetworkResource")
        .map((command) => command.params!.url),
    ).toEqual([
      "https://owned.invalid/a.png",
      "https://owned.invalid/changed.png",
    ]);
    expect(f.publish.mock.calls.filter(([, src]) => src !== null)).toHaveLength(
      1,
    );
    expect(f.commands("IO.close")).toHaveLength(2);
  });

  it("keeps retained documents and child-frame navigation cached, but reloads a new main document", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    const sessionId = f.commands("Network.loadNetworkResource")[0]!.sessionId;
    f.socket.emit(
      "Page.frameStartedNavigating",
      { frameId: "main", url: "https://owned.invalid/no-content" },
      sessionId,
    );
    f.socket.emit(
      "Page.navigatedWithinDocument",
      { frameId: "child", url: "https://owned.invalid/child#hash" },
      sessionId,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.commands("Network.loadNetworkResource")).toHaveLength(1);
    expect(f.publish).toHaveBeenLastCalledWith(
      "a",
      "data:image/png;base64,owned",
    );
    f.pages.get("a")!.loader = "replacement";
    f.socket.emit(
      "Page.frameNavigated",
      { frame: { id: "main", loaderId: "replacement" } },
      sessionId,
    );
    expect(f.publish).toHaveBeenLastCalledWith("a", null);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.commands("Network.loadNetworkResource")).toHaveLength(2);
    expect(f.commands("Page.createIsolatedWorld")).toHaveLength(2);
  });

  it("defers unstable declaration retries to polling rather than looping image requests", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.churn(4);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.commands("Network.loadNetworkResource")).toHaveLength(1);
    expect(f.publish.mock.calls.filter(([, src]) => src !== null)).toHaveLength(
      0,
    );
    await vi.advanceTimersByTimeAsync(4_000);
    expect(f.commands("Network.loadNetworkResource")).toHaveLength(3);
    expect(f.publish.mock.calls.filter(([, src]) => src !== null)).toHaveLength(
      1,
    );
  });

  it("reloads an earlier icon when declarations revert during another image load", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    f.pages.get("a")!.candidates[0]!.url =
      "https://owned.invalid/temporary.png";
    f.hold("IO.read");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.publish).toHaveBeenLastCalledWith("a", null);
    f.pages.get("a")!.candidates[0]!.url = "https://owned.invalid/a.png";
    f.hold(null);
    f.socket.reply(f.held[0]!, {
      data: btoa("temporary"),
      base64Encoded: true,
      eof: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.publish).toHaveBeenLastCalledWith(
      "a",
      "data:image/png;base64,owned",
    );
    expect(
      f
        .commands("Network.loadNetworkResource")
        .map((command) => command.params!.url),
    ).toEqual([
      "https://owned.invalid/a.png",
      "https://owned.invalid/temporary.png",
      "https://owned.invalid/a.png",
    ]);
  });

  it("closes session-local IO before detaching a paused owner and revalidates on resume", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.hold("IO.read");
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    const read = f.held[0]!;
    f.icons.setPaused(true);
    expect(f.commands("Target.detachFromTarget")).toHaveLength(0);
    f.hold(null);
    f.socket.reply(read, {
      data: btoa("stale"),
      base64Encoded: true,
      eof: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const close = f.commands("IO.close")[0]!;
    expect(close.sessionId).toBe(read.sessionId);
    expect(close.id).toBeLessThan(f.commands("Target.detachFromTarget")[0]!.id);
    expect(f.decode).not.toHaveBeenCalled();
    f.icons.setPaused(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.publish).toHaveBeenLastCalledWith(
      "a",
      "data:image/png;base64,owned",
    );
    expect(f.commands("Target.attachToTarget")).toHaveLength(2);
  });

  it("bounds image bytes and cleans up streams without publishing an invalid image", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.oversized();
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.commands("IO.close")).toHaveLength(2);
    expect(f.publish.mock.calls.every(([, src]) => src === null)).toBe(true);
  });

  it("stops an image stream after the aggregate byte limit even when individual chunks are valid", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.largeStream();
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.decode).not.toHaveBeenCalled();
    // Declaration and fallback each stop at the first chunk exceeding 128 KiB.
    expect(f.commands("IO.read")).toHaveLength(10);
    expect(f.commands("IO.close")).toHaveLength(2);
    expect(f.publish.mock.calls.every(([, src]) => src === null)).toBe(true);
  });

  it("releases only the owning sessions on pause, removal and delayed attachment", async () => {
    vi.useFakeTimers();
    const a = await fixture(["a"]);
    const b = await fixture(["b"]);
    a.hold("Target.attachToTarget");
    a.start();
    b.start();
    await vi.advanceTimersByTimeAsync(0);
    a.icons.setPaused(true);
    a.socket.reply(a.held[0]!, { sessionId: "stale-attach" });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.commands("Target.detachFromTarget")).toContainEqual(
      expect.objectContaining({ params: { sessionId: "stale-attach" } }),
    );
    expect(b.commands("Target.detachFromTarget")).toHaveLength(0);
    b.icons.reconcile([]);
    expect(b.commands("Target.detachFromTarget")).toHaveLength(1);
    expect(b.publish).toHaveBeenLastCalledWith("b", null);
  });

  it("keeps icons private, ignores stale image failures and clears removed/reconnected targets", () => {
    const model = createViewerModel();
    model.update({ targets: [{ id: "constructor", title: "Owned" }] });
    model.run(model.setFavicon$, { targetId: "constructor", src: "first" });
    model.run(model.setFavicon$, { targetId: "constructor", src: "second" });
    model.run(model.rejectFavicon$, { targetId: "constructor", src: "first" });
    expect(model.read(model.favicons$).get("constructor")).toBe("second");
    expect(model.getSnapshot().targets).toEqual([
      { id: "constructor", title: "Owned" },
    ]);
    model.update({ targets: [] });
    expect(model.read(model.favicons$).size).toBe(0);
    model.run(model.setFavicon$, { targetId: "constructor", src: "late" });
    expect(model.read(model.favicons$).size).toBe(0);
    model.transition({ type: "reset" });
    expect(model.read(model.favicons$).size).toBe(0);
  });

  it("orders declared candidates and bounds malformed declaration data", () => {
    expect(
      parseIcons({
        url: "https://owned.invalid/",
        candidates: [
          { url: "https://owned.invalid/later.svg", size: 0 },
          { url: "https://owned.invalid/exact.png", size: 16 },
        ],
      })?.candidates.map((candidate) => candidate.url),
    ).toEqual([
      "https://owned.invalid/later.svg",
      "https://owned.invalid/exact.png",
      "https://owned.invalid/favicon.ico",
    ]);
    expect(
      parseIcons({
        url: "https://owned.invalid/",
        candidates: Array(9).fill({}),
      }),
    ).toBeNull();
  });
});
