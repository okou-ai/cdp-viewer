import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";

const controllers: ViewerController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((c) => c.close());
  vi.useRealTimers();
});

function mount(
  browser: FakeBrowser,
  windowId?: number,
  requestTimeout?: number,
) {
  const model = createViewerModel();
  const sink = {
    push: vi.fn((_data: string, paint: () => void) => paint()),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
  const controller = new ViewerController(model, sink, {
    url: "wss://fixture.invalid/?token=private-endpoint",
    socketFactory: browser.factory,
    ...(windowId === undefined ? {} : { windowId }),
    ...(requestTimeout === undefined ? {} : { requestTimeout }),
  });
  controllers.push(controller);
  controller.start();
  return { controller, model, sink };
}

describe("viewer lifecycle", () => {
  it("reports an unsupported streaming capability without exposing provider errors", async () => {
    const browser = new FakeBrowser();
    browser.unsupportedStream = true;
    const { model } = mount(browser);
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe("error"));
    expect(model.getSnapshot().error).toEqual({
      kind: "unsupported-capability",
      message: "The browser does not support a required CDP viewer command.",
    });
  });
  it("keeps window zero scoped, acknowledges numeric frame IDs in the owning session", async () => {
    const browser = new FakeBrowser();
    const { model } = mount(browser, 0);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    expect(model.getSnapshot().targets.map((t) => t.id)).toEqual(["page-a"]);
    const ack = browser.sockets[0]!.commands.find(
      (c) => c.method === "Page.screencastFrameAck",
    );
    expect(ack).toMatchObject({
      params: { sessionId: 73 },
      sessionId: "session-1",
    });
  });

  it("does not call window APIs in unscoped mode, even when unsupported", async () => {
    const browser = new FakeBrowser();
    browser.unsupportedWindows = true;
    const { model } = mount(browser);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    expect(model.getSnapshot().targets).toHaveLength(2);
    expect(
      browser.sockets[0]!.commands.some((c) =>
        c.method.startsWith("Browser.getWindow"),
      ),
    ).toBe(false);
  });

  it("never exposes other windows after unsupported or absent scoped mapping", async () => {
    const browser = new FakeBrowser();
    browser.unsupportedWindows = true;
    const unsupported = mount(browser, 0);
    await vi.waitFor(() =>
      expect(unsupported.model.getSnapshot().status).toBe("unavailable"),
    );
    expect(unsupported.model.getSnapshot().targets).toEqual([]);
    expect(unsupported.model.getSnapshot().error?.kind).toBe(
      "unsupported-capability",
    );
    expect(JSON.stringify(unsupported.model.getSnapshot())).not.toContain(
      "private",
    );
    browser.unsupportedWindows = false;
    const missing = mount(browser, 99);
    await vi.waitFor(() =>
      expect(missing.model.getSnapshot().status).toBe("unavailable"),
    );
    expect(missing.model.getSnapshot().targets).toEqual([]);
    missing.controller.setPaused(true);
    expect(missing.model.getSnapshot().status).toBe("unavailable");
    expect(
      browser.sockets
        .flatMap((s) => s.commands)
        .some((c) => c.method === "Target.attachToTarget"),
    ).toBe(false);
  });

  it("detects movement without a target event and clears the previous stream", async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    const { model, sink } = mount(browser, 0);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const resets = sink.reset.mock.calls.length;
    browser.targets[0]!.windowId = 2;
    await vi.advanceTimersByTimeAsync(2000);
    expect(model.getSnapshot()).toMatchObject({
      status: "unavailable",
      selectedTargetId: null,
      targets: [],
    });
    expect(sink.reset.mock.calls.length).toBeGreaterThan(resets);
    expect(
      browser.sockets[0]!.commands.some(
        (c) => c.method === "Target.detachFromTarget",
      ),
    ).toBe(true);
  });

  it("leaves a closed selection unavailable until explicit recovery", async () => {
    const browser = new FakeBrowser();
    const { model } = mount(browser);
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    browser.targets = browser.targets.filter((t) => t.id !== "page-a");
    browser.sockets[0]!.emit("Target.targetDestroyed", { targetId: "page-a" });
    await vi.waitFor(() =>
      expect(model.getSnapshot().targets.map((t) => t.id)).toEqual(["page-b"]),
    );
    expect(model.getSnapshot()).toMatchObject({
      status: "unavailable",
      selectedTargetId: null,
    });
    expect(
      browser.sockets[0]!.commands.filter(
        (c) => c.method === "Target.attachToTarget",
      ),
    ).toHaveLength(1);
  });

  it("releases a superseded attach response without painting or selecting it", async () => {
    const browser = new FakeBrowser();
    browser.holdAttach = true;
    const { controller, model, sink } = mount(browser);
    await vi.waitFor(() => expect(browser.held).toHaveLength(1));
    browser.holdAttach = false;
    controller.select("page-b");
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    const count = sink.push.mock.calls.length;
    const held = browser.held[0]!;
    held.socket.reply(held.command, { sessionId: held.sessionId });
    await vi.waitFor(() =>
      expect(
        held.socket.commands.some(
          (c) =>
            c.method === "Target.detachFromTarget" &&
            c.params?.sessionId === held.sessionId,
        ),
      ).toBe(true),
    );
    browser.frame(held.socket, held.sessionId);
    expect(model.getSnapshot().selectedTargetId).toBe("page-b");
    expect(sink.push.mock.calls.length).toBe(count);
  });

  it("releases an attach that arrives after its request timeout", async () => {
    vi.useFakeTimers();
    const browser = new FakeBrowser();
    browser.holdAttach = true;
    const { model } = mount(browser, undefined, 50);
    await vi.waitFor(() => expect(browser.held).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(50);
    expect(model.getSnapshot().status).toBe("error");
    const held = browser.held[0]!;
    held.socket.reply(held.command, { sessionId: held.sessionId });
    await Promise.resolve();
    expect(
      held.socket.commands.some(
        (c) =>
          c.method === "Target.detachFromTarget" &&
          c.params?.sessionId === held.sessionId,
      ),
    ).toBe(true);
  });

  it("isolates two viewers, pause/resume, and teardown without closing remote targets", async () => {
    const browser = new FakeBrowser();
    const first = mount(browser, 0);
    const second = mount(browser, 2);
    await vi.waitFor(() =>
      expect([
        first.model.getSnapshot().status,
        second.model.getSnapshot().status,
      ]).toEqual(["streaming", "streaming"]),
    );
    first.controller.setPaused(true);
    expect(first.model.getSnapshot().status).toBe("paused");
    expect(second.model.getSnapshot().status).toBe("streaming");
    first.controller.setPaused(false);
    await vi.waitFor(() =>
      expect(first.model.getSnapshot().status).toBe("streaming"),
    );
    first.controller.close();
    expect(first.sink.dispose).toHaveBeenCalledTimes(1);
    expect(browser.sockets[0]!.readyState).toBe(3);
    expect(browser.sockets[1]!.readyState).toBe(1);
    expect(second.model.getSnapshot().selectedTargetId).toBe("page-b");
    browser.sockets[1]!.close();
    second.controller.setPaused(true);
    expect(second.model.getSnapshot().status).toBe("disconnected");
    expect(
      browser.sockets
        .flatMap((s) => s.commands)
        .some((c) =>
          ["Browser.close", "Target.closeTarget"].includes(c.method),
        ),
    ).toBe(false);
  });
});
