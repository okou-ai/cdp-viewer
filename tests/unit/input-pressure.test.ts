import { afterEach, expect, it, vi } from "vitest";
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
  const controller = new ViewerController(
    model,
    {
      push: (_data, painted) => painted({ width: 800, height: 600 }),
      reset() {},
      dispose() {},
    },
    {
      url: "wss://fixture.invalid/",
      socketFactory: browser.factory,
      interactive: true,
    },
  );
  controllers.push(controller);
  controller.start();
  await vi.waitFor(() => expect(controller.input).not.toBeNull());
  const input = controller.input!;
  const owner = input.owner!;
  input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, { buttons: 0 });
  await input.completion(owner);
  return {
    browser,
    model,
    input,
    owner,
    socket: browser.sockets[0]!,
  };
}

it.each(["mouseMoved", "mouseWheel"] as const)(
  "coalesces continuous %s input under delayed acknowledgements without losing ownership",
  async (type) => {
    const { browser, model, input, owner, socket } = await mount();
    vi.useFakeTimers();
    const before = socket.commands.length;
    browser.holdMethod = "Input.dispatchMouseEvent";
    for (let index = 1; index <= 160; index++) {
      input.pointer(
        type,
        { x: type === "mouseMoved" ? index / 160 : 0.5, y: 0.5 },
        { buttons: 0, ...(type === "mouseWheel" ? { deltaY: 12 } : {}) },
      );
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(model.getSnapshot().error).toBeNull();
    expect(input.owner).toBe(owner);
    expect(browser.heldCommands.length).toBeGreaterThan(1);
    expect(browser.heldCommands.length).toBeLessThanOrEqual(64);
    browser.holdMethod = null;
    for (const held of browser.heldCommands) held.socket.reply(held.command);
    await vi.advanceTimersByTimeAsync(0);
    await input.completion(owner);
    const commands = socket.commands
      .slice(before)
      .filter((command) => command.method === "Input.dispatchMouseEvent");
    if (type === "mouseMoved") expect(commands.at(-1)?.params?.x).toBe(800);
    else
      expect(
        commands.reduce(
          (sum, command) => sum + Number(command.params?.deltaY),
          0,
        ),
      ).toBe(160 * 12);
    expect(model.getSnapshot().error).toBeNull();
  },
);

it("preserves drag release and text order after continuous-input backpressure", async () => {
  const { browser, model, input, owner, socket } = await mount();
  vi.useFakeTimers();
  const before = socket.commands.length;
  input.pointer(
    "mousePressed",
    { x: 0, y: 0.5 },
    { button: "left", buttons: 1 },
  );
  await vi.advanceTimersByTimeAsync(0);
  browser.holdMethod = "Input.dispatchMouseEvent";
  for (let index = 1; index <= 160; index++) {
    input.pointer("mouseMoved", { x: index / 160, y: 0.5 }, { buttons: 1 });
    await vi.advanceTimersByTimeAsync(0);
  }
  input.pointer(
    "mouseReleased",
    { x: 1, y: 0.5 },
    { button: "left", buttons: 0 },
  );
  input.text("after drag");
  expect(model.getSnapshot().error).toBeNull();
  browser.holdMethod = null;
  for (const held of browser.heldCommands) held.socket.reply(held.command);
  await vi.advanceTimersByTimeAsync(0);
  await input.completion(owner);
  const commands = socket.commands
    .slice(before)
    .filter((command) => command.method.startsWith("Input."));
  expect(commands[0]?.params?.type).toBe("mousePressed");
  expect(commands.slice(-3)).toMatchObject([
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 800, buttons: 1 },
    },
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: 800, buttons: 0 },
    },
    { method: "Input.insertText", params: { text: "after drag" } },
  ]);
  expect(model.getSnapshot().error).toBeNull();
});

it.each(["blur", "navigation"] as const)(
  "cancels unsent continuous input on %s without waiting for old replies or replaying it",
  async (reason) => {
    const { browser, model, input, socket } = await mount();
    vi.useFakeTimers();
    browser.holdMethod = "Input.dispatchMouseEvent";
    for (let index = 1; index <= 160; index++) {
      input.pointer("mouseMoved", { x: index / 160, y: 0.5 }, { buttons: 0 });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(model.getSnapshot().error).toBeNull();
    const sent = browser.heldCommands.length;
    if (reason === "blur") input.blur();
    else
      socket.emit(
        "Page.frameNavigated",
        { frame: { id: "main" } },
        input.sessionId,
      );
    input.text("current owner");
    await vi.advanceTimersByTimeAsync(0);
    expect(
      socket.commands.filter(
        (command) => command.method === "Input.insertText",
      ),
    ).toMatchObject([{ params: { text: "current owner" } }]);
    browser.holdMethod = null;
    for (const held of browser.heldCommands) held.socket.reply(held.command);
    await vi.advanceTimersByTimeAsync(0);
    await input.completion(input.owner!);
    expect(browser.heldCommands).toHaveLength(sent);
    expect(
      socket.commands.filter(
        (command) => command.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(sent + 1);
    expect(model.getSnapshot().error).toBeNull();
  },
);

it.each(["rejected", "timed out"] as const)(
  "reports a %s continuous write and discards the unsent backlog without replay",
  async (outcome) => {
    const { browser, model, input, socket } = await mount();
    vi.useFakeTimers();
    browser.holdMethod = "Input.dispatchMouseEvent";
    for (let index = 1; index <= 160; index++) {
      input.pointer("mouseMoved", { x: index / 160, y: 0.5 }, { buttons: 0 });
      await vi.advanceTimersByTimeAsync(0);
    }
    const sent = browser.heldCommands.length;
    const [first, ...remaining] = browser.heldCommands;
    if (outcome === "rejected") {
      first!.socket.reject(first!.command, -32000);
      await vi.advanceTimersByTimeAsync(0);
    } else await vi.advanceTimersByTimeAsync(10_000);
    expect(model.getSnapshot().error?.kind).toBe("input");
    browser.holdMethod = null;
    for (const held of remaining) held.socket.reply(held.command);
    input.text("new action");
    await vi.advanceTimersByTimeAsync(0);
    expect(
      socket.commands.filter(
        (command) => command.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(sent + 1);
    expect(
      socket.commands.filter(
        (command) => command.method === "Input.insertText",
      ),
    ).toMatchObject([{ params: { text: "new action" } }]);
  },
);

it("retires a backpressured session after its dispatched replies settle and discards unsent input", async () => {
  const { browser, input, socket } = await mount();
  vi.useFakeTimers();
  browser.holdMethod = "Input.dispatchMouseEvent";
  for (let index = 1; index <= 160; index++) {
    input.pointer("mouseMoved", { x: index / 160, y: 0.5 }, { buttons: 0 });
    await vi.advanceTimersByTimeAsync(0);
  }
  const sent = browser.heldCommands.length;
  let retired = false;
  const retirement = input.retire().then(() => {
    retired = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(retired).toBe(false);
  browser.holdMethod = null;
  for (const held of browser.heldCommands) held.socket.reply(held.command);
  await vi.advanceTimersByTimeAsync(0);
  await retirement;
  expect(retired).toBe(true);
  expect(
    socket.commands.filter(
      (command) => command.method === "Input.dispatchMouseEvent",
    ),
  ).toHaveLength(sent + 1);
});
