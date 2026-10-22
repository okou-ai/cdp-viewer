import { afterEach, expect, it, vi } from "vitest";
import { ViewerController } from "../../src/viewer/controller";
import { createViewerModel } from "../../src/viewer/model";
import { FakeBrowser } from "./wire";
import type { WindowSizeSync } from "../../src/index";

const controllers: ViewerController[] = [];
afterEach(() =>
  controllers.splice(0).forEach((controller) => controller.close()),
);

function mount(
  browser: FakeBrowser,
  mode: WindowSizeSync = "off",
  windowId?: number,
) {
  const model = createViewerModel();
  const controller = new ViewerController(
    model,
    {
      push: (_data, painted) => painted(),
      reset() {},
      dispose() {},
    },
    {
      url: "wss://fixture.invalid",
      socketFactory: browser.factory,
      interactive: true,
      ...(windowId === undefined ? {} : { windowId }),
    },
  );
  controllers.push(controller);
  controller.measureDisplay({ width: 640, height: 480, dpr: 2 });
  controller.setWindowSizeSync(mode);
  controller.start();
  return { controller, model };
}
const resizes = (browser: FakeBrowser) =>
  browser.sockets
    .flatMap((socket) => socket.commands)
    .filter((command) => command.method === "Browser.setContentsSize");
const emulations = (browser: FakeBrowser) =>
  browser.sockets
    .flatMap((socket) => socket.commands)
    .filter(
      (command) => command.method === "Emulation.setDeviceMetricsOverride",
    );

it("keeps the default browser untouched and manually synchronizes both layout and DPR in window zero", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  expect(resizes(browser)).toHaveLength(0);
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  expect(resizes(browser)[0]!.params).toEqual({
    windowId: 0,
    width: 1280,
    height: 960,
  });
  expect(emulations(browser)[0]).toMatchObject({
    params: {
      width: 640,
      height: 480,
      deviceScaleFactor: 2,
      scale: 2,
      dontSetVisibleSize: true,
      mobile: false,
    },
    sessionId: "session-1",
  });
  expect(model.getSnapshot().status).toBe("streaming");
  expect(browser.sockets).toHaveLength(1);
  expect(
    browser.sockets[0]!.commands.filter(
      (c) => c.method === "Target.attachToTarget",
    ),
  ).toHaveLength(1);
  expect(
    browser.sockets[0]!.commands.filter(
      (c) => c.method === "Page.stopScreencast",
    ),
  ).toHaveLength(1);
});

it("bounds live work to one running resize and one final desired geometry", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Browser.setContentsSize";
  const { controller, model } = mount(browser, "live", 0);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  for (let index = 0; index < 100; index++)
    controller.measureDisplay({ width: 700 + index, height: 500, dpr: 2 });
  expect(resizes(browser)).toHaveLength(1);
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  expect(resizes(browser)[1]!.params).toEqual({
    windowId: 0,
    width: 1598,
    height: 1000,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(resizes(browser)).toHaveLength(2);
  expect(
    browser.sockets[0]!.commands.filter(
      (c) => c.method === "Page.startScreencast",
    ),
  ).toHaveLength(1);
});

it.each([1, 2])(
  "accounts for existing and changed browser zoom at native DPR %s",
  async (nativeDpr) => {
    const browser = new FakeBrowser();
    browser.nativeDpr = nativeDpr;
    browser.browserZoom = 1.25;
    const { controller, model } = mount(browser, "initial", 0);
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
    expect(resizes(browser)[0]!.params).toEqual({
      windowId: 0,
      width: 1280 / nativeDpr,
      height: 960 / nativeDpr,
    });
    expect(emulations(browser)[0]!.params).toMatchObject({
      width: 800,
      height: 600,
      deviceScaleFactor: 1.6,
      scale: 1.6 / nativeDpr,
    });
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    const verifyInput = async (zoom: number) => {
      await vi.waitFor(() => expect(controller.input).not.toBeNull());
      const socket = browser.sockets[0]!;
      const input = controller.input!;
      browser.frame(socket, input.sessionId);
      input.pointer("mouseMoved", { x: 0.25, y: 0.5 }, {});
      await vi.waitFor(() =>
        expect(
          socket.commands
            .filter((command) => command.method === "Input.dispatchMouseEvent")
            .at(-1)?.params,
        ).toMatchObject({
          type: "mouseMoved",
          x: 320 / nativeDpr / zoom,
          y: 480 / nativeDpr / zoom,
        }),
      );
      input.pointer(
        "mouseWheel",
        { x: 0.25, y: 0.5 },
        { deltaX: 0, deltaY: 120 },
      );
      await vi.waitFor(() => {
        const wheel = socket.commands
          .filter((command) => command.method === "Input.dispatchMouseEvent")
          .at(-1)?.params;
        expect(wheel?.type).toBe("mouseWheel");
        expect(wheel?.deltaY).toBeCloseTo(
          480 / nativeDpr / nativeDpr / zoom,
          8,
        );
      });
    };
    await verifyInput(1.25);
    browser.browserZoom = 0.8;
    controller.syncDisplay();
    await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
    expect(resizes(browser)[1]!.params).toEqual(resizes(browser)[0]!.params);
    expect(emulations(browser)[1]!.params).toMatchObject({
      width: 512,
      height: 384,
      deviceScaleFactor: 2.5,
      scale: 2.5 / nativeDpr,
    });
    await vi.waitFor(() =>
      expect(model.read(model.display$).pending).toBe(false),
    );
    await verifyInput(0.8);
    expect(model.getSnapshot().error).toBeNull();
  },
);

it.each([false, true])(
  "keeps native zoom input correct with failed synchronization=%s",
  async (failSync) => {
    const browser = new FakeBrowser();
    browser.browserZoom = 1.25;
    browser.windowSizes.set(0, { width: 1000, height: 750 });
    browser.unsupportedContentsSize = failSync;
    const { controller, model } = mount(
      browser,
      failSync ? "initial" : "off",
      0,
    );
    await vi.waitFor(() =>
      expect(model.getSnapshot().status).toBe("streaming"),
    );
    if (failSync)
      await vi.waitFor(() =>
        expect(model.getSnapshot().error?.kind).toBe("unsupported-capability"),
      );
    const socket = browser.sockets[0]!;
    const input = controller.input!;
    browser.frame(socket, input.sessionId);
    const events = () =>
      socket.commands.filter(
        (command) => command.method === "Input.dispatchMouseEvent",
      );
    const point = async (x: number) => {
      const previous = events().length;
      input.pointer("mouseMoved", { x: 0.25, y: 0.5 }, {});
      await vi.waitFor(() => {
        expect(events()).toHaveLength(previous + 1);
        expect(events().at(-1)?.params).toMatchObject({
          type: "mouseMoved",
          x,
        });
      });
    };
    await point(200);
    const metrics = () =>
      socket.commands.filter(
        (command) => command.method === "Page.getLayoutMetrics",
      ).length;
    const calibrated = metrics();
    await point(200);
    expect(metrics()).toBe(calibrated);
    browser.browserZoom = 0.8;
    socket.emit("Page.frameResized", {}, input.sessionId);
    browser.frame(socket, input.sessionId);
    await point(312.5);
    expect(metrics()).toBe(calibrated + 1);
    input.pointer("mouseWheel", { x: 0.25, y: 0.5 }, { deltaY: 120 });
    await vi.waitFor(() =>
      expect(
        socket.commands
          .filter((command) => command.method === "Input.dispatchMouseEvent")
          .at(-1)?.params,
      ).toMatchObject({ type: "mouseWheel", deltaY: 96 }),
    );
    expect(metrics()).toBe(calibrated + 1);
    expect(resizes(browser)).toHaveLength(failSync ? 1 : 0);
  },
);

it("initial mode restores density across tabs without fitting a resized local stage again", async () => {
  const browser = new FakeBrowser();
  browser.targets[1]!.windowId = 0;
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  controller.measureDisplay({ width: 900, height: 700, dpr: 1 });
  controller.select("page-b");
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  expect(resizes(browser)[1]!.params).toEqual({
    windowId: 0,
    width: 1280,
    height: 960,
  });
  expect(emulations(browser).at(-1)!.params).toMatchObject({
    width: 640,
    height: 480,
    deviceScaleFactor: 2,
  });
  expect(model.getSnapshot().selectedTargetId).toBe("page-b");
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(3));
  expect(resizes(browser)[2]!.params).toEqual({
    windowId: 0,
    width: 900,
    height: 700,
  });
});

it("preserves a queued manual sync when automatic synchronization is turned off", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  controller.measureDisplay({ width: 900, height: 700, dpr: 1 });
  controller.syncDisplay();
  controller.setWindowSizeSync("off");
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(2));
  expect(resizes(browser)[1]!.params).toEqual({
    windowId: 0,
    width: 900,
    height: 700,
  });
  expect(emulations(browser).at(-1)!.params).toMatchObject({
    width: 900,
    height: 700,
    deviceScaleFactor: 1,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  controller.measureDisplay({ width: 1000, height: 800, dpr: 2 });
  expect(model.read(model.display$).pending).toBe(false);
  expect(resizes(browser)).toHaveLength(2);
});

it("clears queued busy state for a zero-area stage and resumes at the latest valid size", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  controller.setWindowSizeSync("live");
  controller.measureDisplay(null);
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      ready: false,
      pending: false,
    }),
  );
  expect(emulations(browser)).toHaveLength(0);
  expect(resizes(browser)).toHaveLength(0);
  controller.measureDisplay({ width: 900, height: 700, dpr: 1 });
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  expect(resizes(browser)[0]!.params).toEqual({
    windowId: 0,
    width: 900,
    height: 700,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$)).toMatchObject({
      ready: true,
      pending: false,
    }),
  );
});

it("does not write after ownership is lost while a guard is pending", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  browser.holdMethod = "Browser.getWindowForTarget";
  controller.syncDisplay();
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.setPaused(true);
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, {
    windowId: 0,
    bounds: { windowState: "normal" },
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(emulations(browser)).toHaveLength(0);
  expect(resizes(browser)).toHaveLength(0);
  expect(model.getSnapshot().status).toBe("paused");
});

it("contains unsupported display failures without leaking provider payloads or stopping viewing", async () => {
  const browser = new FakeBrowser();
  browser.unsupportedDisplay = true;
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() =>
    expect(model.getSnapshot().error?.kind).toBe("unsupported-capability"),
  );
  expect(model.getSnapshot().status).toBe("streaming");
  expect(JSON.stringify(model.getSnapshot())).not.toContain("private");
  expect(resizes(browser)).toHaveLength(0);
  controller.measureDisplay({ width: 700, height: 500, dpr: 2 });
  expect(emulations(browser)).toHaveLength(1);
  browser.unsupportedDisplay = false;
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  await vi.waitFor(() => expect(model.getSnapshot().error).toBeNull());
});

it("keeps the latest initial measurement while the first guard is pending", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Runtime.evaluate";
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.measureDisplay({ width: 700, height: 500, dpr: 2 });
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, {
    result: { value: { width: 800, height: 600, dpr: 1 } },
  });
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  expect(resizes(browser)[0]!.params).toEqual({
    windowId: 0,
    width: 1400,
    height: 1000,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
});

it("makes live progress with the latest size without requiring a quiet measurement interval", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Runtime.evaluate";
  const { controller, model } = mount(browser, "live", 0);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  for (let index = 0; index < 100; index++)
    controller.measureDisplay({ width: 700 + index, height: 500, dpr: 2 });
  // Keep later guards held: the first completed guard must still commit the newest size.
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command, {
    result: { value: { width: 800, height: 600, dpr: 1 } },
  });
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  expect(resizes(browser)[0]!.params).toEqual({
    windowId: 0,
    width: 1598,
    height: 1000,
  });
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
});

it("requires a normal native window and recovers on a deliberate retry", async () => {
  const browser = new FakeBrowser();
  browser.windowState = "maximized";
  const { controller, model } = mount(browser, "live", 0);
  await vi.waitFor(() =>
    expect(model.getSnapshot().error?.message).toContain(
      "Restore the browser window",
    ),
  );
  expect(emulations(browser)).toHaveLength(0);
  expect(resizes(browser)).toHaveLength(0);
  expect(model.getSnapshot().status).toBe("streaming");
  browser.windowState = "normal";
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
});

it("retires partial emulation when native content sizing is unsupported", async () => {
  const browser = new FakeBrowser();
  browser.unsupportedContentsSize = true;
  const { controller, model } = mount(browser, "initial", 0);
  await vi.waitFor(() =>
    expect(model.getSnapshot().error?.kind).toBe("unsupported-capability"),
  );
  expect(
    browser.sockets[0]!.commands.filter(
      (command) => command.method === "Emulation.clearDeviceMetricsOverride",
    ),
  ).toHaveLength(1);
  expect(model.getSnapshot().status).toBe("streaming");
  expect(model.read(model.display$).pending).toBe(false);
  browser.unsupportedContentsSize = false;
  controller.syncDisplay();
  await vi.waitFor(() =>
    expect(browser.windowSizes.get(0)).toEqual({ width: 1280, height: 960 }),
  );
});

it("drops an automatic update disabled during capture preparation", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser, "off", 0);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  browser.holdMethod = "Page.stopScreencast";
  controller.setWindowSizeSync("live");
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  controller.setWindowSizeSync("off");
  browser.holdMethod = null;
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command);
  await vi.waitFor(() =>
    expect(model.read(model.display$).pending).toBe(false),
  );
  expect(emulations(browser)).toHaveLength(0);
  expect(resizes(browser)).toHaveLength(0);
});

it("constrains physical edges and area while preserving requested DPR and aspect ratio", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  controller.measureDisplay({ width: 10000, height: 5000, dpr: 3 });
  controller.syncDisplay();
  await vi.waitFor(() => expect(resizes(browser)).toHaveLength(1));
  const dimensions = resizes(browser)[0]!.params!;
  const width = Number(dimensions.width),
    height = Number(dimensions.height);
  expect(width).toBeLessThanOrEqual(4096);
  expect(height).toBeLessThanOrEqual(4096);
  expect(width * height).toBeLessThanOrEqual(3840 * 2160);
  expect(Math.abs(width / height - 2)).toBeLessThan(0.01);
  expect(emulations(browser)[0]!.params?.deviceScaleFactor).toBe(3);
  await vi.waitFor(() =>
    expect(model.read(model.display$).constrained).toBe(true),
  );
});

it("lets a sibling window synchronize while another owner's write is held", async () => {
  const browser = new FakeBrowser();
  browser.holdMethod = "Browser.setContentsSize";
  const a = mount(browser, "live", 0);
  await vi.waitFor(() => expect(browser.heldCommands).toHaveLength(1));
  browser.holdMethod = null;
  const b = mount(browser, "live", 2);
  await vi.waitFor(() =>
    expect(browser.windowSizes.get(2)).toEqual({ width: 1280, height: 960 }),
  );
  expect(b.model.getSnapshot().status).toBe("streaming");
  a.controller.close();
  const held = browser.heldCommands[0]!;
  held.socket.reply(held.command);
  expect(b.model.getSnapshot().status).toBe("streaming");
  expect(browser.sockets[1]!.readyState).toBe(1);
});

it("refuses density that exceeds the physical budget even at minimum logical dimensions", async () => {
  const browser = new FakeBrowser();
  const { controller, model } = mount(browser);
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe("streaming"));
  controller.measureDisplay({ width: 640, height: 480, dpr: 10000 });
  controller.syncDisplay();
  await vi.waitFor(() =>
    expect(model.getSnapshot().error?.message).toContain("density cannot fit"),
  );
  expect(resizes(browser)).toHaveLength(0);
  expect(emulations(browser)).toHaveLength(0);
  expect(model.getSnapshot().status).toBe("streaming");
});
