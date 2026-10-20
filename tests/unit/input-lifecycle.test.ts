import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";

const controllers: ViewerController[] = [];
afterEach(() =>
  controllers.splice(0).forEach((controller) => controller.close()),
);

async function mount() {
  const browser = new FakeBrowser();
  const model = createViewerModel();
  let focusReady = false;
  const controller = new ViewerController(
    model,
    {
      push: (_data, painted) => painted(),
      reset: () => {},
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
  it("drops text waiting on a focus guard when the selected target is replaced", async () => {
    const { browser, controller, socket } = await mount();
    browser.holdMethod = "Runtime.callFunctionOn";
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
      result: { value: { editable: true, supported: true, x: 10, y: 20 } },
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
    browser.holdMethod = "Runtime.callFunctionOn";
    const input = controller.input!;
    input.text("stale document text");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    socket.emit(
      "Page.frameNavigated",
      { frame: { id: "main" } },
      input.sessionId,
    );
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command, {
      result: { value: { editable: true, supported: true, x: 10, y: 20 } },
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

  it("releases held input when navigation retains the same document", async () => {
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
    socket.emit(
      "Page.navigatedWithinDocument",
      { frameId: "main", url: "https://fixture.invalid/#section" },
      input.sessionId,
    );
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
  });

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
    browser.holdMethod = "Runtime.callFunctionOn";
    input.text("discard on main context loss");
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    socket.emit(
      "Runtime.executionContextDestroyed",
      { executionContextId: 1 },
      input.sessionId,
    );
    const held = browser.heldCommands[0]!;
    held.socket.reply(held.command, { result: { value: {} } });
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
