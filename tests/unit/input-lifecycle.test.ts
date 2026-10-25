import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";

const controllers: ViewerController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.close());
  vi.useRealTimers();
});

async function mount() {
  const browser = new FakeBrowser();
  const model = createViewerModel();
  let focusReady = false;
  const controller = new ViewerController(
    model,
    {
      push: (_data, painted) => painted({ width: 800, height: 600 }),
      reset: () => {},
      invalidate: () => {},
      dispose: () => {},
    },
    {
      url: "wss://fixture.invalid/",
      socketFactory: browser.factory,
      interactive: true,
      onCaret: () => {
        focusReady = true;
      },
    },
  );
  controllers.push(controller);
  controller.start();
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  const socket = browser.sockets[0]!;
  controller.input!.focus();
  await vi.waitFor(() => expect(focusReady).toBe(true));
  return { browser, model, controller, socket };
}

describe("owned remote input", () => {
  it("omits unsent preedit behind native completion when its final result is already available", async () => {
    const { browser, controller, socket } = await mount();
    const input = controller.input!;
    const owner = input.owner!;
    browser.holdMethod = "Input.dispatchMouseEvent";
    input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {}, owner);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const preceding = input.completion(owner);
    input.preedit("obsolete", owner);
    input.commitComposition("你", owner);
    browser.holdMethod = null;
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command);
    await preceding;
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.insertText"),
      ).toHaveLength(1),
    );
    expect(
      socket.commands.filter((c) => c.method === "Input.imeSetComposition"),
    ).toHaveLength(0);
  });

  it("coalesces unsent previews behind native completion without crossing a queued key gesture", async () => {
    const { browser, controller, socket } = await mount();
    const input = controller.input!;
    const owner = input.owner!;
    browser.holdMethod = "Input.dispatchMouseEvent";
    input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {}, owner);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const preceding = input.completion(owner);
    input.preedit("n", owner);
    input.preedit("ni", owner, 0, 2);
    input.key({ type: "keyDown", key: "Shift", code: "ShiftLeft" });
    input.preedit("nihao", owner);
    browser.holdMethod = null;
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command);
    await preceding;
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.imeSetComposition"),
      ).toHaveLength(2),
    );
    const edits = socket.commands.filter((c) =>
      ["Input.imeSetComposition", "Input.dispatchKeyEvent"].includes(c.method),
    );
    expect(edits.map((c) => c.method)).toEqual([
      "Input.imeSetComposition",
      "Input.dispatchKeyEvent",
      "Input.imeSetComposition",
    ]);
    expect(edits[0]!.params).toEqual({
      text: "ni",
      selectionStart: 0,
      selectionEnd: 2,
    });
    expect(edits[2]!.params!.text).toBe("nihao");
  });

  it("coalesces only unsent preedit and commits after the acknowledged composition", async () => {
    const { browser, controller, socket } = await mount();
    const input = controller.input!;
    const owner = input.owner!;
    browser.holdMethod = "Input.imeSetComposition";
    input.preedit("n", owner);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    input.preedit("ni", owner);
    input.preedit("nihao", owner);
    const first = browser.heldCommands[0]!;
    first.socket.reply(first.command);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
    input.commitComposition("你好", owner);
    expect(
      socket.commands.filter((c) => c.method === "Input.insertText"),
    ).toHaveLength(0);
    browser.holdMethod = null;
    const held = browser.heldCommands[1]!;
    held.socket.reply(held.command);
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.insertText"),
      ).toHaveLength(1),
    );
    expect(
      socket.commands
        .filter((c) => c.method === "Input.imeSetComposition")
        .map((c) => c.params!.text),
    ).toEqual(["n", "nihao"]);
    expect(
      socket.commands.find((c) => c.method === "Input.insertText")!.params,
    ).toEqual({ text: "你好" });
  });

  it("drops an unsent preedit burst when the final commit can replace the in-flight range", async () => {
    const { browser, controller, socket, model } = await mount();
    const input = controller.input!;
    const owner = input.owner!;
    browser.holdMethod = "Input.imeSetComposition";
    input.preedit("n", owner);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    for (let index = 0; index < 200; index++)
      input.preedit(`ni${index}`, owner);
    input.commitComposition("你", owner);
    browser.holdMethod = null;
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command);
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.insertText"),
      ).toHaveLength(1),
    );
    expect(
      socket.commands
        .filter((c) => c.method === "Input.imeSetComposition")
        .map((c) => c.params!.text),
    ).toEqual(["n"]);
    expect(
      socket.commands.find((c) => c.method === "Input.insertText")!.params,
    ).toEqual({ text: "你" });
    expect(model.getSnapshot().error).toBeNull();
  });

  it("falls back after a definite unsupported composition command without losing the final commit", async () => {
    const { browser, controller, model, socket } = await mount();
    const input = controller.input!;
    browser.holdMethod = "Input.imeSetComposition";
    input.preedit("ni", input.owner!);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    input.commitComposition("你", input.owner!);
    const held = browser.heldCommands[0]!;
    browser.holdMethod = null;
    held.socket.reject(held.command, -32601);
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.insertText"),
      ).toHaveLength(1),
    );
    input.preedit("next", input.owner!);
    input.commitComposition("好", input.owner!);
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.insertText"),
      ).toHaveLength(2),
    );
    expect(
      socket.commands.filter((c) => c.method === "Input.imeSetComposition"),
    ).toHaveLength(1);
    expect(model.getSnapshot().error).toBeNull();
  });

  it("does not let a delayed final acknowledgement release the next composition", async () => {
    const { browser, controller, socket } = await mount();
    const input = controller.input!;
    const owner = input.owner!;
    input.preedit("ni", owner);
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.imeSetComposition"),
      ).toHaveLength(1),
    );
    browser.holdMethod = "Input.insertText";
    input.commitComposition("你", owner);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    input.preedit("hao", owner);
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.imeSetComposition"),
      ).toHaveLength(2),
    );
    const held = browser.heldCommands[0]!;
    browser.holdMethod = null;
    held.socket.reply(held.command);
    input.key({ type: "keyDown", key: "Shift", code: "ShiftLeft" });
    await vi.waitFor(() =>
      expect(
        socket.commands.some((c) => c.method === "Input.dispatchKeyEvent"),
      ).toBe(true),
    );
    input.blur();
    expect(
      socket.commands
        .filter((c) => c.method === "Input.imeSetComposition")
        .map((c) => c.params!.text),
    ).toEqual(["ni", "hao", ""]);
  });

  it("discards queued text after an uncertain composition failure instead of falling back or replaying", async () => {
    const { browser, controller, socket, model } = await mount();
    const input = controller.input!;
    const owner = input.owner!;
    browser.holdMethod = "Input.imeSetComposition";
    input.preedit("ni", owner);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    input.commitComposition("你", owner);
    browser.holdMethod = null;
    const held = browser.heldCommands[0]!;
    held.socket.reject(held.command, -32000);
    await vi.waitFor(() =>
      expect(model.getSnapshot().error?.kind).toBe("input"),
    );
    expect(
      socket.commands.filter((c) => c.method === "Input.insertText"),
    ).toHaveLength(0);
    expect(
      socket.commands
        .filter((c) => c.method === "Input.imeSetComposition")
        .map((c) => c.params!.text),
    ).toEqual(["ni", ""]);
    expect(input.owner).not.toBe(owner);
  });

  it.each(["blur", "document-lost"] as const)(
    "cleans delayed preedit only in its retained document after %s",
    async (reason) => {
      const { browser, controller, socket } = await mount();
      const input = controller.input!;
      const owner = input.owner!;
      browser.holdMethod = "Input.imeSetComposition";
      input.preedit("old", owner);
      await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
      input.commitComposition("must not arrive", owner);
      if (reason === "blur") input.blur();
      else
        input.event({
          method: "Runtime.executionContextsCleared",
          params: {},
          sessionId: input.sessionId,
        });
      input.preedit("replacement", input.owner!);
      browser.holdMethod = null;
      const held = browser.heldCommands[0]!;
      held.socket.reply(held.command);
      await vi.waitFor(() =>
        expect(
          socket.commands
            .filter((c) => c.method === "Input.imeSetComposition")
            .at(-1)?.params!.text,
        ).toBe("replacement"),
      );
      const updates = socket.commands
        .filter((c) => c.method === "Input.imeSetComposition")
        .map((c) => c.params!.text);
      expect(updates).toEqual(
        reason === "blur"
          ? ["old", "", "", "replacement"]
          : ["old", "replacement"],
      );
      expect(
        socket.commands.filter((c) => c.method === "Input.insertText"),
      ).toHaveLength(0);
    },
  );

  describe.each(["Runtime.evaluate"] as const)(
    "%s result ownership",
    (method) => {
      it.each(["active", "blurred", "timed-out"] as const)(
        "releases optional metadata exception handles when %s without blocking input",
        async (outcome) => {
          const { browser, controller, model, socket } = await mount();
          const input = controller.input!;
          if (outcome === "timed-out") vi.useFakeTimers();
          browser.holdMethod = method;
          input.focus();
          await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
          const held = browser.heldCommands[0]!;
          input.text("independent of metadata");
          await vi.waitFor(() =>
            expect(
              socket.commands.filter((c) => c.method === "Input.insertText"),
            ).toHaveLength(1),
          );
          if (outcome === "blurred") input.blur();
          else if (outcome === "timed-out") {
            await vi.advanceTimersByTimeAsync(10_000);
            expect(model.getSnapshot().error).toBeNull();
          }
          browser.holdMethod = null;
          held.socket.reply(held.command, {
            result: {
              type: "object",
              subtype: "error",
              objectId: "error-result",
            },
            exceptionDetails: {
              exception: {
                type: "object",
                subtype: "error",
                objectId: "error-detail",
              },
            },
          });
          await vi.waitFor(() =>
            expect(
              socket.commands.filter(
                (command) =>
                  command.method === "Runtime.releaseObject" &&
                  ["error-result", "error-detail"].includes(
                    String(command.params?.objectId),
                  ),
              ),
            ).toEqual([
              expect.objectContaining({
                sessionId: held.command.sessionId,
                params: { objectId: "error-result" },
              }),
              expect.objectContaining({
                sessionId: held.command.sessionId,
                params: { objectId: "error-detail" },
              }),
            ]),
          );
          expect(
            socket.commands.filter(
              (command) => command.method === "Input.insertText",
            ),
          ).toEqual([
            expect.objectContaining({
              params: { text: "independent of metadata" },
            }),
          ]);
          input.focus();
          input.text("recovered after exception");
          await vi.waitFor(() =>
            expect(
              socket.commands.filter(
                (command) => command.method === "Input.insertText",
              ),
            ).toEqual([
              expect.objectContaining({
                params: { text: "independent of metadata" },
              }),
              expect.objectContaining({
                params: { text: "recovered after exception" },
              }),
            ]),
          );
        },
      );
    },
  );

  it.each([
    "blur",
    "navigation-start",
    "document-loss",
    "target-replacement",
    "pause-resume",
  ] as const)(
    "rejects a captured old owner after %s while allowing current input",
    async (reason) => {
      const { controller, socket } = await mount();
      const previous = controller.input!;
      const owner = previous.owner!;
      if (reason === "blur") previous.blur();
      else if (reason === "navigation-start")
        socket.emit(
          "Page.frameStartedNavigating",
          { frameId: "main", navigationType: "differentDocument" },
          previous.sessionId,
        );
      else if (reason === "document-loss")
        socket.emit(
          "Page.frameNavigated",
          { frame: { id: "main" } },
          previous.sessionId,
        );
      else if (reason === "target-replacement") controller.select("page-b");
      else {
        controller.setPaused(true);
        controller.setPaused(false);
      }
      await vi.waitFor(() => expect(controller.input).not.toBeNull());
      const current = controller.input!;
      current.focus();
      current.text("must not reach the replacement", owner);
      current.text("current owner");
      await vi.waitFor(() =>
        expect(
          socket.commands.filter((c) => c.method === "Input.insertText"),
        ).toHaveLength(1),
      );
      expect(
        socket.commands.find((c) => c.method === "Input.insertText"),
      ).toMatchObject({
        sessionId: current.sessionId,
        params: { text: "current owner" },
      });
    },
  );

  it("discards a saturated queue and recovers without sending its stale keys", async () => {
    const { browser, controller, socket, model } = await mount();
    browser.holdMethod = "Input.dispatchKeyEvent";
    const input = controller.input!;
    input.key({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const owner = input.owner!;
    const fenced = expect(input.completion(owner)).rejects.toThrow();
    // The actual reply fence keeps this captured owner's following keys unsent.
    for (let index = 0; index < 64; index++)
      input.key(
        { type: "rawKeyDown", key: "ArrowRight", code: "ArrowRight" },
        owner,
      );
    expect(model.getSnapshot().error?.kind).toBe("input");
    browser.holdMethod = null;
    for (const held of browser.heldCommands) held.socket.reply(held.command);
    await fenced;
    input.focus();
    input.text("recovered queue");
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.insertText"),
      ).toHaveLength(1),
    );
    expect(
      socket.commands.filter((c) => c.method === "Input.dispatchKeyEvent"),
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ key: "Shift", type: "rawKeyDown" }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({ key: "Shift", type: "keyUp" }),
      }),
    ]);
    expect(
      socket.commands.find((c) => c.method === "Input.insertText")?.params
        ?.text,
    ).toBe("recovered queue");
  });

  it("releases an unexpected late metadata handle through its original session", async () => {
    const { browser, controller, socket } = await mount();
    browser.holdMethod = "Runtime.evaluate";
    const input = controller.input!;
    input.focus();
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    input.blur();
    const held = browser.heldCommands[0]!;
    browser.holdMethod = null;
    held.socket.reply(held.command, {
      result: { type: "object", objectId: "late-owned-focus" },
    });
    input.focus();
    input.text("current focus");
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.insertText"),
      ).toHaveLength(1),
    );
    expect(
      socket.commands.filter(
        (c) =>
          c.method === "Runtime.releaseObject" &&
          c.params?.objectId === "late-owned-focus",
      ),
    ).toEqual([expect.objectContaining({ sessionId: held.command.sessionId })]);
    expect(
      socket.commands.find((c) => c.method === "Input.insertText")?.params
        ?.text,
    ).toBe("current focus");
  });

  it("drops queued text behind pointer preparation when the target is replaced", async () => {
    const { browser, controller, socket } = await mount();
    socket.emit("Page.frameResized", {}, controller.input!.sessionId);
    browser.holdMethod = "Page.getLayoutMetrics";
    controller.input!.pointer("mouseMoved", { x: 0.5, y: 0.5 }, { buttons: 0 });
    controller.input!.text("old target text");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const held = browser.heldCommands[0]!;
    browser.holdMethod = null;
    controller.select("page-b");
    await vi.waitFor(() =>
      expect(controller.input?.sessionId).not.toBe(held.command.sessionId),
    );
    await vi.waitFor(() => expect(controller.input).not.toBeNull());
    held.socket.reply(held.command, {
      cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
    });
    controller.input!.focus();
    controller.input!.text("new target text");
    await vi.waitFor(() =>
      expect(
        socket.commands.filter(
          (command) => command.method === "Input.insertText",
        ),
      ).toHaveLength(1),
    );
    expect(
      socket.commands.find((command) => command.method === "Input.insertText"),
    ).toMatchObject({
      sessionId: controller.input!.sessionId,
      params: { text: "new target text" },
    });
  });

  it("discards a pending text operation when its document navigates", async () => {
    const { browser, controller, socket } = await mount();
    socket.emit("Page.frameResized", {}, controller.input!.sessionId);
    browser.holdMethod = "Page.getLayoutMetrics";
    const input = controller.input!;
    input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, { buttons: 0 });
    input.text("stale document text");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    socket.emit(
      "Page.frameNavigated",
      { frame: { id: "main" } },
      input.sessionId,
    );
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command, {
      cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
    });
    browser.holdMethod = null;
    input.focus();
    input.text("current document text");
    await vi.waitFor(() =>
      expect(
        socket.commands.filter(
          (command) => command.method === "Input.insertText",
        ),
      ).toHaveLength(1),
    );
    expect(
      socket.commands.find((command) => command.method === "Input.insertText")
        ?.params?.text,
    ).toBe("current document text");
  });

  it("releases a key whose remote acknowledgement is still pending on blur", async () => {
    const { browser, controller, socket } = await mount();
    browser.holdMethod = "Input.dispatchKeyEvent";
    controller.input!.key({
      type: "rawKeyDown",
      key: "Shift",
      code: "ShiftLeft",
      modifiers: 8,
    });
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const held = browser.heldCommands[0]!;
    controller.input!.blur();
    expect(
      socket.commands.filter(
        (command) => command.method === "Input.dispatchKeyEvent",
      ),
    ).toEqual([
      expect.objectContaining({
        sessionId: held.command.sessionId,
        params: expect.objectContaining({ type: "rawKeyDown" }),
      }),
      expect.objectContaining({
        sessionId: held.command.sessionId,
        params: expect.objectContaining({ type: "keyUp", modifiers: 0 }),
      }),
    ]);
    browser.holdMethod = null;
    held.socket.reply(held.command);
  });

  it.each(["rejected", "pending on blur"] as const)(
    "releases the owned key when its normal key-up is %s",
    async (outcome) => {
      const { browser, controller, model, socket } = await mount();
      const input = controller.input!;
      input.key({
        type: "rawKeyDown",
        key: "Shift",
        code: "ShiftLeft",
        modifiers: 8,
      });
      await vi.waitFor(() =>
        expect(
          socket.commands.filter(
            (command) => command.method === "Input.dispatchKeyEvent",
          ),
        ).toHaveLength(1),
      );
      browser.holdMethod = "Input.dispatchKeyEvent";
      input.key({
        type: "keyUp",
        key: "Shift",
        code: "ShiftLeft",
        modifiers: 0,
      });
      await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
      const held = browser.heldCommands[0]!;
      browser.holdMethod = null;
      if (outcome === "rejected") {
        held.socket.reject(held.command, -32000);
        await vi.waitFor(() =>
          expect(model.getSnapshot().error?.kind).toBe("input"),
        );
      } else {
        input.blur();
        held.socket.reply(held.command);
      }
      expect(
        socket.commands.filter(
          (command) => command.method === "Input.dispatchKeyEvent",
        ),
      ).toEqual([
        expect.objectContaining({
          sessionId: input.sessionId,
          params: expect.objectContaining({ type: "rawKeyDown" }),
        }),
        expect.objectContaining({
          sessionId: input.sessionId,
          params: expect.objectContaining({ type: "keyUp" }),
        }),
        expect.objectContaining({
          sessionId: input.sessionId,
          params: expect.objectContaining({
            type: "keyUp",
            key: "Shift",
            code: "ShiftLeft",
            modifiers: 0,
          }),
        }),
      ]);
    },
  );

  it("retains a later key press when an earlier key-up reply arrives", async () => {
    const { browser, controller, socket } = await mount();
    vi.useFakeTimers();
    const input = controller.input!;
    browser.holdMethod = "Input.dispatchKeyEvent";
    const key = { key: "Shift", code: "ShiftLeft", modifiers: 8 };
    input.key({ type: "rawKeyDown", ...key });
    input.key({ type: "keyUp", ...key, modifiers: 0 });
    input.key({ type: "rawKeyDown", ...key });
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(3));
    const oldRelease = browser.heldCommands[1]!;
    oldRelease.socket.reply(oldRelease.command);
    // Process acknowledgement continuations before inspecting the later press.
    await vi.advanceTimersByTimeAsync(0);
    input.blur();
    expect(
      socket.commands
        .filter((c) => c.method === "Input.dispatchKeyEvent")
        .map((c) => c.params?.type),
    ).toEqual(["rawKeyDown", "keyUp", "rawKeyDown", "keyUp"]);
    browser.holdMethod = null;
    for (const held of browser.heldCommands) held.socket.reply(held.command);
  });

  it("retains a later mouse press when an earlier release reply arrives", async () => {
    const { browser, controller, socket } = await mount();
    vi.useFakeTimers();
    const input = controller.input!;
    browser.holdMethod = "Input.dispatchMouseEvent";
    const point = { x: 0.25, y: 0.5 };
    input.pointer("mousePressed", point, { button: "left", buttons: 1 });
    input.pointer("mouseReleased", point, { button: "left", buttons: 0 });
    input.pointer("mousePressed", point, { button: "left", buttons: 1 });
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(3));
    const oldRelease = browser.heldCommands[1]!;
    oldRelease.socket.reply(oldRelease.command);
    await vi.advanceTimersByTimeAsync(0);
    input.blur();
    expect(
      socket.commands
        .filter((c) => c.method === "Input.dispatchMouseEvent")
        .map((c) => c.params?.type),
    ).toEqual([
      "mousePressed",
      "mouseReleased",
      "mousePressed",
      "mouseReleased",
    ]);
    browser.holdMethod = null;
    for (const held of browser.heldCommands) held.socket.reply(held.command);
  });

  it("routes completed addresses and explicit schemes through the owned CDP session", async () => {
    const { controller, socket } = await mount();
    const input = controller.input!;
    const cases = [
      ["localhost:3000/path?x#y", "http://localhost:3000/path?x#y"],
      ["about:blank", "about:blank"],
      ["data:text/plain,fixture", "data:text/plain,fixture"],
      ["file:///tmp/fixture.html", "file:///tmp/fixture.html"],
      ["chrome://version/", "chrome://version/"],
      ["custom:fixture", "custom:fixture"],
    ] as const;
    for (const [url, expected] of cases) {
      const before = socket.commands.length;
      input.navigate({ url });
      await vi.waitFor(() =>
        expect(
          socket.commands
            .slice(before)
            .filter((c) => c.method === "Page.navigate"),
        ).toEqual([
          expect.objectContaining({
            params: { url: expected },
            sessionId: input.sessionId,
          }),
        ]),
      );
    }
  });

  it("rejects search-like addresses without cancelling owned composition or pending input", async () => {
    const { browser, controller, socket, model } = await mount();
    const input = controller.input!;
    const owner = input.owner!;
    input.preedit("n", owner);
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.imeSetComposition"),
      ).toHaveLength(1),
    );
    browser.holdMethod = "Input.insertText";
    input.text("accepted once");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    input.navigate({ url: "search private fixture text" });
    expect(input.owner).toBe(owner);
    expect(
      socket.commands
        .filter((c) => c.method === "Input.imeSetComposition")
        .map((c) => c.params?.text),
    ).toEqual(["n"]);
    expect(model.getSnapshot().error).toMatchObject({
      kind: "input",
      message: "Enter a page address, such as example.com or about:blank.",
    });
    input.commitComposition("new commit", owner);
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(2));
    expect(socket.commands.some((c) => c.method === "Page.navigate")).toBe(
      false,
    );
    expect(
      socket.commands
        .filter((c) => c.method === "Input.insertText")
        .map((c) => c.params?.text),
    ).toEqual(["accepted once", "new commit"]);
    browser.holdMethod = null;
    for (const held of browser.heldCommands) held.socket.reply(held.command);
  });

  it("does not retry an explicit script URL after a remote navigation error", async () => {
    const { browser, controller, socket, model } = await mount();
    vi.useFakeTimers();
    browser.holdMethod = "Page.navigate";
    const url = "javascript:document.title='fixture';void 0";
    controller.input!.navigate({ url });
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const held = browser.heldCommands[0]!;
    expect(held.command.params).toEqual({ url });
    held.socket.reply(held.command, { errorText: "private remote failure" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(model.getSnapshot().error).toMatchObject({
      kind: "input",
      message: "The remote page could not be navigated.",
    });
    expect(
      socket.commands.filter((c) => c.method === "Page.navigate"),
    ).toHaveLength(1);
  });

  it("drops a completed address still waiting for input when its session is replaced", async () => {
    const { browser, controller, socket } = await mount();
    browser.holdMethod = "Input.insertText";
    controller.input!.text("accepted once");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    controller.input!.navigate({ url: "localhost:3000/next" });
    controller.select("page-b");
    browser.holdMethod = null;
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command);
    await vi.waitFor(() =>
      expect(controller.input?.sessionId).toMatch(/^session-/),
    );
    expect(controller.input!.sessionId).not.toBe(held.command.sessionId);
    controller.input!.text("replacement input");
    await vi.waitFor(() =>
      expect(
        socket.commands
          .filter((c) => c.method === "Input.insertText")
          .map((c) => c.params?.text),
      ).toEqual(["accepted once", "replacement input"]),
    );
    expect(socket.commands.some((c) => c.method === "Page.navigate")).toBe(
      false,
    );
  });

  it("waits for dispatched input before sending completed toolbar navigation without replay", async () => {
    const { browser, controller, socket } = await mount();
    vi.useFakeTimers();
    const input = controller.input!;
    browser.holdMethod = "Input.insertText";
    input.text("accepted once");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    input.navigate({ url: "fixture.invalid/next" });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.commands.some((c) => c.method === "Page.navigate")).toBe(
      false,
    );
    browser.holdMethod = null;
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command);
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Page.navigate"),
      ).toHaveLength(1),
    );
    expect(
      socket.commands.filter((c) => c.method === "Input.insertText"),
    ).toHaveLength(1);
    expect(
      socket.commands.find((c) => c.method === "Page.navigate")?.params,
    ).toEqual({
      url: "http://fixture.invalid/next",
    });
  });

  it("ignores an old write failure after a new local input owner takes over", async () => {
    const { browser, controller, socket, model } = await mount();
    vi.useFakeTimers();
    const input = controller.input!;
    browser.holdMethod = "Input.insertText";
    input.text("old uncertain input");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    input.blur();
    browser.holdMethod = null;
    input.text("current input");
    await vi.waitFor(() =>
      expect(
        socket.commands.filter((c) => c.method === "Input.insertText"),
      ).toHaveLength(2),
    );
    const old = browser.heldCommands[0]!;
    old.socket.reject(old.command, -32000);
    await vi.advanceTimersByTimeAsync(0);
    expect(model.getSnapshot().error).toBeNull();
  });

  it("does not retry an accepted text write when the owning socket disconnects", async () => {
    const { browser, controller, model, socket } = await mount();
    browser.holdMethod = "Input.insertText";
    controller.input!.text("accepted once");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    socket.close();
    expect(model.getSnapshot().status).toBe("disconnected");
    expect(controller.input).toBeNull();
    expect(
      socket.commands.filter(
        (command) => command.method === "Input.insertText",
      ),
    ).toHaveLength(1);
    expect(browser.sockets).toHaveLength(1);
  });

  it.each(["same-document", "differentDocument", "historyDifferentDocument"])(
    "releases held input during %s navigation",
    async (navigationType) => {
      const { controller, socket } = await mount();
      const input = controller.input!;
      input.key({
        type: "rawKeyDown",
        key: "Shift",
        code: "ShiftLeft",
        modifiers: 8,
      });
      input.pointer("mousePressed", { x: 0.25, y: 0.5 }, { button: "left" });
      await vi.waitFor(() =>
        expect(
          socket.commands.filter(
            (command) => command.method === "Input.dispatchMouseEvent",
          ),
        ).toHaveLength(1),
      );
      socket.emit(
        "Page.frameStartedLoading",
        { frameId: "main" },
        input.sessionId,
      );
      if (navigationType === "same-document") {
        socket.emit(
          "Page.navigatedWithinDocument",
          { frameId: "main", url: "https://fixture.invalid/#section" },
          input.sessionId,
        );
      } else {
        socket.emit(
          "Page.frameStartedNavigating",
          { frameId: "main", navigationType },
          input.sessionId,
        );
      }
      expect(
        socket.commands.filter(
          (command) => command.method === "Input.dispatchKeyEvent",
        ),
      ).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({ type: "rawKeyDown" }),
        }),
        expect.objectContaining({
          sessionId: input.sessionId,
          params: expect.objectContaining({
            type: "keyUp",
            code: "ShiftLeft",
            modifiers: 0,
          }),
        }),
      ]);
      expect(
        socket.commands.filter(
          (command) => command.method === "Input.dispatchMouseEvent",
        ),
      ).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({ type: "mousePressed" }),
        }),
        expect.objectContaining({
          sessionId: input.sessionId,
          params: {
            type: "mouseReleased",
            x: 200,
            y: 300,
            button: "left",
            buttons: 0,
          },
        }),
      ]);
    },
  );

  it("keeps main-document text active while unrelated frames and isolated contexts change", async () => {
    const { browser, controller, socket } = await mount();
    const input = controller.input!;
    socket.emit(
      "Runtime.executionContextCreated",
      { context: { id: 1, auxData: { frameId: "main", isDefault: true } } },
      input.sessionId,
    );
    socket.emit(
      "Page.frameStartedLoading",
      { frameId: "child" },
      input.sessionId,
    );
    socket.emit(
      "Page.frameNavigated",
      { frame: { id: "child", parentId: "main" } },
      input.sessionId,
    );
    socket.emit(
      "Runtime.executionContextDestroyed",
      { executionContextId: 2 },
      input.sessionId,
    );
    input.text("main document");
    await vi.waitFor(() =>
      expect(
        socket.commands.some(
          (command) => command.method === "Input.insertText",
        ),
      ).toBe(true),
    );
    socket.emit("Page.frameResized", {}, input.sessionId);
    browser.holdMethod = "Page.getLayoutMetrics";
    input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, { buttons: 0 });
    input.text("discard on main context loss");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    socket.emit(
      "Runtime.executionContextDestroyed",
      { executionContextId: 1 },
      input.sessionId,
    );
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command, {
      cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
    });
    browser.holdMethod = null;
    input.focus();
    input.text("new main context");
    await vi.waitFor(() =>
      expect(
        socket.commands.filter(
          (command) => command.method === "Input.insertText",
        ),
      ).toHaveLength(2),
    );
    expect(
      socket.commands
        .filter((command) => command.method === "Input.insertText")
        .map((command) => command.params?.text),
    ).toEqual(["main document", "new main context"]);
  });
});
