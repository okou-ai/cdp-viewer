import { afterEach, expect, it, vi } from "vitest";
import { CdpClient } from "../../src/cdp/client";
import { NativeInput } from "../../src/input/native";
import { InputSession } from "../../src/input/session";
import type { InputOwner, InputTransition } from "../../src/input/lifecycle";
import type { NativeInputPort } from "../../src/input/port";
import { FakeBrowser } from "./wire";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function port() {
  let owner: InputOwner = { sessionId: "native", document: 0, focus: 0 };
  const input = {
    get owner() {
      return owner;
    },
    focus: vi.fn<NativeInputPort["focus"]>(),
    blur: vi.fn<NativeInputPort["blur"]>(),
    pointer: vi.fn<NativeInputPort["pointer"]>(),
    key: vi.fn<NativeInputPort["key"]>(),
    text: vi.fn<NativeInputPort["text"]>(),
    preedit: vi.fn<NativeInputPort["preedit"]>(),
    commitComposition: vi.fn<NativeInputPort["commitComposition"]>(),
    selection: vi
      .fn<NativeInputPort["selection"]>()
      .mockResolvedValue({ status: "empty", text: "" }),
    clipboardError: vi.fn<NativeInputPort["clipboardError"]>(),
  } satisfies NativeInputPort;
  return {
    input,
    replaceOwner: () => {
      owner = { ...owner, focus: owner.focus + 1 };
    },
  };
}

function clock() {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return {
    frames,
    frame: () => {
      const callbacks = Array.from(frames.values());
      frames.clear();
      for (const callback of callbacks) callback(0);
    },
  };
}

function surface(input: NativeInputPort) {
  let current = input;
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  const proxy = document.createElement("textarea");
  canvas.width = 800;
  canvas.height = 600;
  const bounds = vi
    .spyOn(canvas, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 800, 600));
  vi.spyOn(canvas, "clientHeight", "get").mockReturnValue(600);
  stage.setPointerCapture = vi.fn();
  stage.hasPointerCapture = vi.fn(() => false);
  stage.append(canvas, proxy);
  document.body.append(stage);
  const adapter = new NativeInput(canvas, proxy, () => current, vi.fn());
  cleanup.push(() => adapter.dispose());
  proxy.focus();
  return {
    adapter,
    proxy,
    canvas,
    bounds,
    replace: (replacement: NativeInputPort) => {
      current = replacement;
    },
    wheel: (details: WheelEventInit = {}) => {
      const init = {
        bubbles: true,
        cancelable: true,
        clientX: 400,
        clientY: 300,
        deltaY: 12,
        ...details,
      };
      const event = new WheelEvent("wheel", init);
      // Happy DOM's WheelEvent extends UIEvent, omitting MouseEvent fields.
      const mouse = new MouseEvent("wheel", init);
      for (const key of [
        "clientX",
        "clientY",
        "buttons",
        "altKey",
        "ctrlKey",
        "metaKey",
        "shiftKey",
      ] as const)
        Object.defineProperty(event, key, { value: mouse[key] });
      return canvas.dispatchEvent(event);
    },
    move: (details: PointerEventInit = {}) =>
      canvas.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
          pointerId: 1,
          clientX: 400,
          clientY: 300,
          ...details,
        }),
      ),
    press: () => {
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "mouse",
          pointerId: 1,
          clientX: 400,
          clientY: 300,
        }),
      );
      canvas.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX: 400,
          clientY: 300,
        }),
      );
    },
  };
}

async function session(browserZoom = 1) {
  const browser = new FakeBrowser();
  browser.browserZoom = browserZoom;
  const client = new CdpClient("wss://fixture.invalid", browser.factory);
  cleanup.push(() => client.close());
  await client.opened;
  const reset = vi.fn<(reason: InputTransition) => void>();
  const input = new InputSession(
    client,
    "native",
    async () => true,
    vi.fn(),
    reset,
    vi.fn(),
    vi.fn(),
  );
  cleanup.push(() => input.dispose());
  await input.start();
  return { input, browser, socket: browser.sockets[0]!, reset };
}

async function fillQueue(first: Awaited<ReturnType<typeof session>>) {
  first.browser.holdMethod = "Page.getLayoutMetrics";
  first.input.pointer("mouseMoved", { x: 0.5, y: 0.5 }, {});
  await vi.waitFor(() => expect(first.browser.heldCommands).toHaveLength(1));
  for (let index = 0; index < 63; index++)
    first.input.key({ type: "rawKeyDown", key: "a", code: "KeyA" });
}

it("batches separate wheel admissions before a frame and conserves normalized distance", async () => {
  const frames = clock();
  const { input, socket } = await session();
  const native = surface(input);
  const pointer = vi.spyOn(input, "pointer");
  for (let index = 0; index < 8; index++) {
    native.wheel({ deltaX: 2, deltaY: 3, deltaMode: index % 2 });
    await input.completion(input.owner!);
  }
  expect(pointer).not.toHaveBeenCalled();
  expect(frames.frames.size).toBe(1);
  frames.frame();
  await input.completion(input.owner!);
  expect(pointer).toHaveBeenCalledOnce();
  expect(
    socket.commands
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params),
  ).toMatchObject([{ type: "mouseWheel", deltaX: 136, deltaY: 204 }]);
  native.wheel({ deltaMode: 2, deltaX: 1, deltaY: 1 });
  frames.frame();
  await input.completion(input.owner!);
  expect(pointer.mock.calls[1]?.[2]).toMatchObject({
    deltaX: 600,
    deltaY: 600,
  });
});

it("resolves local geometry once when a compatible movement batch flushes", () => {
  const frames = clock();
  const { input } = port();
  const native = surface(input);
  const { bounds } = native;
  bounds.mockClear();
  for (let index = 0; index < 8; index++) native.move({ clientX: 100 + index });
  expect(bounds).not.toHaveBeenCalled();
  expect(input.pointer).not.toHaveBeenCalled();
  frames.frame();
  expect(bounds).toHaveBeenCalledOnce();
  expect(input.pointer).toHaveBeenCalledExactlyOnceWith(
    "mouseMoved",
    { x: 107 / 800, y: 0.5 },
    expect.objectContaining({ buttons: 0 }),
    input.owner,
  );
});

it("uses current contain geometry when a later key flushes pending movement", () => {
  const frames = clock();
  const { input } = port();
  const native = surface(input);
  const { bounds } = native;
  bounds.mockClear();
  native.move({ clientX: 200, clientY: 200 });
  bounds.mockReturnValue(new DOMRect(0, 0, 400, 300));
  native.proxy.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
      code: "ArrowLeft",
    }),
  );
  expect(bounds).toHaveBeenCalledOnce();
  expect(input.pointer).toHaveBeenCalledExactlyOnceWith(
    "mouseMoved",
    { x: 0.5, y: 2 / 3 },
    expect.objectContaining({ buttons: 0 }),
    input.owner,
  );
  expect(input.pointer.mock.invocationCallOrder[0]).toBeLessThan(
    input.key.mock.invocationCallOrder[0]!,
  );
  expect(frames.frames.size).toBe(0);
});

it("discards stale and cancelled movement before reading local geometry", () => {
  const frames = clock();
  const { input, replaceOwner } = port();
  const native = surface(input);
  const { bounds } = native;
  bounds.mockClear();
  native.move();
  replaceOwner();
  frames.frame();
  native.move();
  const obsolete = [...frames.frames.values()][0]!;
  native.adapter.reset("paused");
  obsolete(0);
  expect(bounds).not.toHaveBeenCalled();
  expect(input.pointer).not.toHaveBeenCalled();
});

it.each([{ deltaY: -12 }, { deltaX: -1 }, { clientX: 401 }, { ctrlKey: true }])(
  "splits incompatible wheel samples %j",
  (change) => {
    const frames = clock();
    const { input } = port();
    const native = surface(input);
    native.wheel({ deltaX: 1 });
    native.wheel(change);
    expect(input.pointer).toHaveBeenCalledOnce();
    frames.frame();
    expect(input.pointer).toHaveBeenCalledTimes(2);
    expect(input.pointer.mock.calls[0]?.[2]).toMatchObject({
      deltaX: 1,
      deltaY: 12,
    });
  },
);

it("preserves button and modifier changes while coalescing compatible movement", () => {
  const frames = clock();
  const { input } = port();
  const native = surface(input);
  native.press();
  input.pointer.mockClear();
  native.move({ buttons: 1, clientX: 100 });
  native.move({ buttons: 1, clientX: 200 });
  native.move({ buttons: 1, clientX: 250, shiftKey: true });
  native.move({ buttons: 0, clientX: 300, shiftKey: true });
  native.wheel({ buttons: 0 });
  native.wheel({ buttons: 1 });
  frames.frame();
  expect(input.pointer.mock.calls.map(([type]) => type)).toEqual([
    "mouseMoved",
    "mouseMoved",
    "mouseMoved",
    "mouseWheel",
    "mouseWheel",
  ]);
  expect(input.pointer.mock.calls.map(([, point]) => point.x)).toEqual([
    0.25,
    250 / 800,
    300 / 800,
    0.5,
    0.5,
  ]);
  expect(
    input.pointer.mock.calls.map(([, , details]) => details.buttons),
  ).toEqual([1, 1, 0, 0, 1]);
});

it("flushes earlier movement and wheel before a key on the real send lane", async () => {
  const frames = clock();
  const { input, socket } = await session();
  const native = surface(input);
  native.move();
  native.wheel();
  native.proxy.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
      code: "ArrowLeft",
    }),
  );
  native.wheel();
  native.proxy.dispatchEvent(
    new KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
      code: "ArrowLeft",
    }),
  );
  expect(frames.frames.size).toBe(0);
  await input.completion(input.owner!);
  expect(
    socket.commands
      .filter((c) => c.method.startsWith("Input."))
      .map((c) => [c.method, c.params?.type]),
  ).toEqual([
    ["Input.dispatchMouseEvent", "mouseMoved"],
    ["Input.dispatchMouseEvent", "mouseWheel"],
    ["Input.dispatchKeyEvent", "rawKeyDown"],
    ["Input.dispatchMouseEvent", "mouseWheel"],
    ["Input.dispatchKeyEvent", "keyUp"],
  ]);
});

it.each([
  "copy",
  "paste",
  "cut",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "input",
])("flushes wheel synchronously at the %s boundary", (type) => {
  const frames = clock();
  const { input } = port();
  const native = surface(input);
  native.wheel();
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "data", { value: "" });
  native.proxy.dispatchEvent(event);
  expect(input.pointer).toHaveBeenCalledOnce();
  expect(frames.frames.size).toBe(0);
});

it("flushes wheels before press and drag movement before release", () => {
  clock();
  const { input } = port();
  const native = surface(input);
  native.wheel();
  native.press();
  native.move({ buttons: 1 });
  native.canvas.dispatchEvent(
    new MouseEvent("mouseup", {
      bubbles: true,
      button: 0,
      clientX: 400,
      clientY: 300,
    }),
  );
  expect(input.pointer.mock.calls.map(([type]) => type)).toEqual([
    "mouseWheel",
    "mousePressed",
    "mouseMoved",
    "mouseReleased",
  ]);
});

it.each([
  "blur",
  "navigation-started",
  "paused",
  "target-replaced",
  "disposed",
] as const)("cancels pending input and captured callbacks on %s", (reason) => {
  const frames = clock();
  const { input, replaceOwner } = port();
  const native = surface(input);
  native.wheel();
  const obsolete = [...frames.frames.values()][0]!;
  replaceOwner();
  native.adapter.reset(reason);
  expect(frames.frames.size).toBe(0);
  native.wheel({ deltaY: 20 });
  obsolete(0);
  expect(input.pointer).not.toHaveBeenCalled();
  frames.frame();
  expect(input.pointer).toHaveBeenCalledExactlyOnceWith(
    "mouseWheel",
    { x: 0.5, y: 0.5 },
    expect.objectContaining({ deltaY: 20 }),
    input.owner,
  );
});

it("does not let an old callback acquire a new owner or replacement port", () => {
  const frames = clock();
  const first = port();
  const native = surface(first.input);
  native.move();
  first.replaceOwner();
  frames.frame();
  expect(first.input.pointer).not.toHaveBeenCalled();
  native.wheel();
  const replacement = port();
  native.replace(replacement.input);
  frames.frame();
  expect(first.input.pointer).not.toHaveBeenCalled();
  expect(replacement.input.pointer).not.toHaveBeenCalled();
});

it("does not reschedule work after a flush synchronously invalidates its owner", () => {
  const frames = clock();
  const { input, replaceOwner } = port();
  const native = surface(input);
  input.pointer.mockImplementation(() => {
    replaceOwner();
    native.adapter.reset("failed");
  });
  native.wheel();
  native.wheel({ ctrlKey: true });
  expect(input.pointer).toHaveBeenCalledOnce();
  expect(frames.frames.size).toBe(0);
  frames.frame();
  expect(input.pointer).toHaveBeenCalledOnce();
});

it.each(["blur", "navigation", "target replacement"] as const)(
  "cancels native batching through the real session's %s transition",
  async (transition) => {
    const frames = clock();
    const { input, reset, socket } = await session();
    const native = surface(input);
    reset.mockImplementation((reason) => native.adapter.reset(reason));
    native.wheel();
    if (transition === "blur") input.blur();
    else if (transition === "navigation") input.navigate("reload");
    else input.dispose("target-replaced");
    expect(reset).toHaveBeenCalled();
    expect(frames.frames.size).toBe(0);
    frames.frame();
    expect(
      socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent"),
    ).toHaveLength(0);
  },
);

it("keeps viewer buffers independent and cancels F8 and disposal without a frame", () => {
  const frames = clock();
  const a = port(),
    b = port();
  const first = surface(a.input),
    second = surface(b.input);
  first.wheel();
  second.wheel({ deltaY: 20 });
  first.proxy.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "F8",
    }),
  );
  frames.frame();
  expect(a.input.pointer).not.toHaveBeenCalled();
  expect(b.input.pointer).toHaveBeenCalledOnce();
  second.wheel();
  second.adapter.dispose();
  frames.frame();
  expect(b.input.pointer).toHaveBeenCalledOnce();
});

it.each(["mouseMoved", "mouseWheel"] as const)(
  "retains %s state boundaries behind held preparation",
  async (type) => {
    const { input, browser, socket } = await session();
    browser.holdMethod = "Page.getLayoutMetrics";
    for (const details of [
      { buttons: 0, modifiers: 0 },
      { buttons: 1, modifiers: 0 },
      { buttons: 1, modifiers: 8 },
      { buttons: 1, modifiers: 8 },
    ])
      input.pointer(type, { x: 0.5, y: 0.5 }, { ...details, deltaY: 12 });
    await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
    const complete = input.completion(input.owner!);
    browser.holdMethod = null;
    const held = browser.heldCommands[0]!;
    browser.resume(held.command, held.socket);
    await complete;
    const commands = socket.commands.filter(
      (c) => c.method === "Input.dispatchMouseEvent",
    );
    expect(
      commands.map((c) => [c.params?.buttons, c.params?.modifiers]),
    ).toEqual([
      [0, 0],
      [1, 0],
      [1, 8],
    ]);
    if (type === "mouseWheel")
      expect(commands.map((c) => c.params?.deltaY)).toEqual([12, 12, 24]);
  },
);

it("never dispatches non-finite wheel accumulation", async () => {
  const frames = clock();
  const { input, socket } = await session();
  const native = surface(input);
  native.wheel({ deltaY: Number.MAX_VALUE });
  native.wheel({ deltaY: Number.MAX_VALUE });
  frames.frame();
  await input.completion(input.owner!);
  const wheels = socket.commands.filter(
    (c) => c.method === "Input.dispatchMouseEvent",
  );
  expect(wheels).toHaveLength(2);
  expect(wheels.every((c) => Number.isFinite(c.params?.deltaY))).toBe(true);
});

it("rejects a finite batch that overflows after native wheel scaling", async () => {
  const frames = clock();
  const { input, socket, reset } = await session(4);
  const native = surface(input);
  native.wheel({ deltaY: 4e307 });
  native.wheel({ deltaY: 4e307 });
  frames.frame();
  await vi.waitFor(() => expect(reset).toHaveBeenCalledWith("failed"));
  expect(
    socket.commands.filter((c) => c.method === "Input.dispatchMouseEvent"),
  ).toHaveLength(0);
});

it.each(["keydown", "keyup", "press", "release", "focus", "composition"])(
  "does not transfer %s to a replacement when flushing exhausts the old queue",
  async (action) => {
    const frames = clock();
    const first = await session();
    const next = await session();
    const native = surface(first.input);
    if (action === "keyup")
      native.proxy.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowLeft",
          code: "ArrowLeft",
        }),
      );
    if (action === "release") native.press();
    if (action === "focus") native.proxy.blur();
    await first.input.completion(first.input.owner!);
    await fillQueue(first);
    first.reset.mockImplementation((reason) => {
      native.adapter.reset(reason);
      native.replace(next.input);
    });
    native.wheel();
    if (action === "press") native.press();
    else if (action === "release")
      native.canvas.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          button: 0,
          clientX: 400,
          clientY: 300,
        }),
      );
    else if (action === "focus") native.proxy.focus();
    else if (action === "composition") {
      native.proxy.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      const end = new CompositionEvent("compositionend", { bubbles: true });
      // Happy DOM omits CompositionEvent.data, as it does WheelEvent fields.
      Object.defineProperty(end, "data", { value: "owned draft" });
      native.proxy.dispatchEvent(end);
    } else
      native.proxy.dispatchEvent(
        new KeyboardEvent(action, {
          bubbles: true,
          cancelable: true,
          key: "ArrowLeft",
          code: "ArrowLeft",
        }),
      );
    expect(first.reset).toHaveBeenCalledWith("failed");
    await next.input.completion(next.input.owner!);
    expect(
      next.socket.commands.filter(
        (c) => c.method.startsWith("Input.") || c.method === "Runtime.evaluate",
      ),
    ).toHaveLength(0);
    expect(frames.frames.size).toBe(0);
    // The canceled event must not disable fresh input for the replacement.
    native.proxy.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowRight",
        code: "ArrowRight",
      }),
    );
    await next.input.completion(next.input.owner!);
    expect(
      next.socket.commands
        .filter((c) => c.method === "Input.dispatchKeyEvent")
        .map((c) => c.params?.key),
    ).toEqual(["ArrowRight"]);
  },
);

it("discards a key when its flush retires only the current owner", async () => {
  clock();
  const first = await session();
  const native = surface(first.input);
  await fillQueue(first);
  const owner = first.input.owner;
  first.reset.mockImplementation((reason) => native.adapter.reset(reason));
  native.wheel();
  native.proxy.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
      code: "ArrowLeft",
    }),
  );
  expect(first.reset).toHaveBeenCalledWith("failed");
  expect(first.input.owner).not.toBe(owner);
  await first.input.completion(first.input.owner!);
  expect(
    first.socket.commands.filter((c) => c.method === "Input.dispatchKeyEvent"),
  ).toHaveLength(0);
});

it("keeps the first composing click on its explicitly restarted focus generation", async () => {
  clock();
  const first = await session();
  const native = surface(first.input);
  first.reset.mockImplementation((reason) => native.adapter.reset(reason));
  const original = first.input.owner;
  native.proxy.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  native.press();
  await first.input.completion(first.input.owner!);
  expect(first.input.owner).not.toBe(original);
  expect(document.activeElement).toBe(native.proxy);
  expect(
    first.socket.commands
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params?.type),
  ).toEqual(["mousePressed"]);
});

it("does not move a composing click to a port replaced during focus cleanup", async () => {
  clock();
  const first = await session(),
    next = await session();
  const native = surface(first.input);
  first.reset.mockImplementation((reason) => {
    native.adapter.reset(reason);
    native.replace(next.input);
  });
  native.proxy.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  native.press();
  await next.input.completion(next.input.owner!);
  expect(
    next.socket.commands.filter((c) => c.method.startsWith("Input.")),
  ).toHaveLength(0);
  native.press();
  await next.input.completion(next.input.owner!);
  expect(
    next.socket.commands
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params?.type),
  ).toEqual(["mousePressed"]);
});

it("retains the pointerdown binding through a compatibility mousedown", async () => {
  clock();
  const first = await session(),
    next = await session();
  const native = surface(first.input);
  native.canvas.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      pointerType: "mouse",
      pointerId: 1,
      clientX: 400,
      clientY: 300,
    }),
  );
  native.replace(next.input);
  native.canvas.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 400,
      clientY: 300,
    }),
  );
  await next.input.completion(next.input.owner!);
  expect(
    next.socket.commands.filter((c) => c.method.startsWith("Input.")),
  ).toHaveLength(0);
});

it("does not acquire pointer capture when the adapter retires during proxy focus", () => {
  clock();
  const { input } = port();
  const native = surface(input);
  native.proxy.blur();
  native.proxy.addEventListener("focus", () => native.adapter.dispose(), {
    once: true,
  });
  native.press();
  expect(native.canvas.parentElement?.setPointerCapture).not.toHaveBeenCalled();
  expect(input.pointer).not.toHaveBeenCalled();
});

it.each(["copy", "paste", "cut"])(
  "cancels %s admission when its capture-phase flush replaces input",
  async (action) => {
    const frames = clock();
    const first = await session();
    const next = await session();
    const native = surface(first.input);
    await fillQueue(first);
    first.reset.mockImplementation((reason) => {
      native.adapter.reset(reason);
      native.replace(next.input);
    });
    const admitted = vi.fn();
    native.proxy.addEventListener(action, admitted);
    native.wheel();
    const event = new Event(action, {
      bubbles: true,
      cancelable: true,
    });
    native.proxy.dispatchEvent(event);
    expect(first.reset).toHaveBeenCalledWith("failed");
    expect(event.defaultPrevented).toBe(true);
    expect(admitted).not.toHaveBeenCalled();
    await next.input.completion(next.input.owner!);
    expect(frames.frames.size).toBe(0);
  },
);
