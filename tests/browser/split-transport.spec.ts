import { expect, test } from "@playwright/test";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { launchNativeBackend, serveBrowserConsumer } from "./backend";
import type { FixtureSettings } from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

async function editor(
  backend: Awaited<ReturnType<typeof launchNativeBackend>>,
) {
  const created = backend.context.waitForEvent("page");
  const { targetId } = await backend.session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const remote = await created;
  await remote.goto(server.origin + "/fixture/editor");
  await expect(remote.locator("#plain")).toBeVisible();
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    { targetId },
  );
  return { remote, windowId, targetId };
}

async function connect(page: Page, settings: FixtureSettings) {
  await page.goto(server.origin);
  await page.waitForFunction(
    () => typeof window.configureViewers === "function",
  );
  await page.evaluate((value) => window.configureViewers!(value), settings);
  const first = page.locator("#viewer-a .cdpv-root");
  await expect(first).toHaveAttribute("data-status", "streaming");
  return first;
}

async function clickInput(page: Page, view: Locator, remote: Page) {
  const box = await remote.locator("#plain").boundingBox();
  if (!box) throw new Error("Owned input has no bounds.");
  const viewport = await remote.evaluate(() => ({
    width: visualViewport!.width,
    height: visualViewport!.height,
  }));
  const point = await view.locator("canvas").evaluate(
    (canvas: HTMLCanvasElement, value) => {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(
        rect.width / canvas.width,
        rect.height / canvas.height,
      );
      const width = canvas.width * scale,
        height = canvas.height * scale;
      return {
        x:
          rect.left +
          (rect.width - width) / 2 +
          (width * value.x) / value.width,
        y:
          rect.top +
          (rect.height - height) / 2 +
          (height * value.y) / value.height,
      };
    },
    { ...viewport, x: box.x + 20, y: box.y + box.height / 2 },
  );
  await page.mouse.click(point.x, point.y);
  await expect(view.getByLabel("Remote browser input")).toBeFocused();
  await expect(remote.locator("#plain")).toBeFocused();
}

test("native split viewers preserve composition, capture and display geometry across navigation and pause", async ({
  page,
}) => {
  const backend = await launchNativeBackend(server.origin, true, 1);
  try {
    const a = await editor(backend);
    const b = await editor(backend);
    const settings: FixtureSettings = {
      cdpUrl: backend.endpoint,
      windowA: a.windowId,
      windowB: b.windowId,
      interactive: true,
      transport: "split",
    };
    const first = await connect(page, settings);
    const second = page.locator("#viewer-b .cdpv-root");
    await expect(second).toHaveAttribute("data-status", "streaming");
    // No WebSocket routing: Chromium enforces the real host Origin for both sockets.
    await clickInput(page, first, a.remote);
    await page.keyboard.insertText("split ");
    const proxy = first.getByLabel("Remote browser input");
    await proxy.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      element.dispatchEvent(
        new CompositionEvent("compositionupdate", {
          bubbles: true,
          data: "ni",
        }),
      );
    });
    await expect(a.remote.locator("#plain")).toHaveValue("split ni");
    const input = await proxy.elementHandle();
    await page.evaluate((value) => window.configureViewers!(value), {
      ...settings,
      captureA: { quality: 70, maxWidth: 640, maxHeight: 480 },
    });
    await expect
      .poll(() =>
        first
          .locator("canvas")
          .evaluate((canvas: HTMLCanvasElement) => canvas.width),
      )
      .toBe(640);
    expect(await proxy.evaluate((element, old) => element === old, input)).toBe(
      true,
    );
    await proxy.evaluate((element) =>
      element.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "你" }),
      ),
    );
    await expect(a.remote.locator("#plain")).toHaveValue("split 你");
    await first.getByRole("button", { name: "Browser menu" }).click();
    await first
      .getByRole("menuitem", { name: "Sync now", exact: true })
      .click();
    const canvas = first.locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Owned viewer has no display bounds.");
    const size = {
      width: Math.floor(box.width),
      height: Math.floor(box.height),
    };
    await expect
      .poll(() =>
        a.remote.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      )
      .toEqual(size);
    await expect
      .poll(() =>
        canvas.evaluate((element: HTMLCanvasElement) => ({
          width: element.width,
          height: element.height,
        })),
      )
      .toEqual(size);
    await clickInput(page, first, a.remote);
    await page.keyboard.press("End");
    await page.keyboard.type("0123456789", { delay: 0 });
    await expect(a.remote.locator("#plain")).toHaveValue("split 你0123456789");
    await first.getByRole("button", { name: "Reload remote page" }).click();
    await expect(a.remote.locator("#plain")).toHaveValue("");
    await clickInput(page, first, a.remote);
    await page.keyboard.insertText("after navigation");
    await expect(a.remote.locator("#plain")).toHaveValue("after navigation");
    await page.evaluate((value) => window.configureViewers!(value), {
      ...settings,
      paused: true,
    });
    await expect(first).toHaveAttribute("data-status", "paused");
    await page.evaluate((value) => window.configureViewers!(value), settings);
    await expect(first).toHaveAttribute("data-status", "streaming");
    await page.evaluate(() => window.removeFirstViewer!());
    await expect(first).toHaveCount(0);
    await expect(second).toHaveAttribute("data-status", "streaming");
    await clickInput(page, second, b.remote);
    await page.keyboard.insertText("independent");
    await expect(b.remote.locator("#plain")).toHaveValue("independent");
    expect(a.remote.isClosed()).toBe(false);
  } finally {
    await backend.close();
  }
});

test("split native DOM input backpressure preserves queued text while frames continue", async ({
  page,
}) => {
  const backend = await launchNativeBackend(server.origin);
  try {
    const { remote, windowId } = await editor(backend);
    await remote.evaluate(() => {
      document.body.dataset.wheel = "0";
      document.addEventListener("wheel", (event) => {
        document.body.dataset.wheel = String(
          Number(document.body.dataset.wheel) + event.deltaY,
        );
      });
    });
    let hold = true;
    const replies: (() => void)[] = [];
    const wheels: number[] = [];
    let text = 0;
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      const wheelIds = new Set<number>();
      socket.onMessage((raw) => {
        const command = JSON.parse(String(raw)) as {
          id: number;
          method: string;
          params?: { type?: string; deltaY?: number };
        };
        if (
          command.method === "Input.dispatchMouseEvent" &&
          command.params?.type === "mouseWheel"
        ) {
          wheelIds.add(command.id);
          wheels.push(command.params.deltaY!);
        }
        if (command.method === "Input.insertText") text++;
        upstream.send(raw);
      });
      upstream.onMessage((raw) => {
        const response = JSON.parse(String(raw)) as { id?: number };
        if (response.id !== undefined && wheelIds.delete(response.id) && hold)
          replies.push(() => socket.send(raw));
        else socket.send(raw);
      });
    });
    const view = await connect(page, {
      cdpUrl: backend.endpoint,
      windowA: windowId,
      second: false,
      interactive: true,
      transport: "split",
    });
    await clickInput(page, view, remote);
    await view
      .locator("canvas")
      .evaluate(async (element: HTMLCanvasElement) => {
        const rect = element.getBoundingClientRect();
        for (let i = 0; i < 48; i++) {
          element.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
              deltaY: 12,
            }),
          );
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        }
      });
    await page.keyboard.insertText("after pressure");
    await expect.poll(() => replies.length).toBe(32);
    expect(wheels).toHaveLength(32);
    expect(text).toBe(0);
    await expect(remote.locator("#plain")).toHaveValue("");
    await remote.evaluate(() => {
      document.body.style.background = "rgb(24,80,224)";
    });
    await expect
      .poll(() =>
        view.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
          const pixel = canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data;
          return [24, 80, 224].every(
            (channel, i) => Math.abs(channel - pixel[i]!) <= 4,
          );
        }),
      )
      .toBe(true);
    await expect(view.getByLabel("Remote browser input")).toBeEnabled();
    await expect(view.locator(".cdpv-error-current")).toHaveCount(0);
    hold = false;
    for (const reply of replies) reply();
    await expect(remote.locator("body")).toHaveAttribute("data-wheel", "576");
    await expect(remote.locator("#plain")).toHaveValue("after pressure");
    expect(wheels.reduce((sum, delta) => sum + delta, 0)).toBe(576);
    expect(text).toBe(1);
  } finally {
    await backend.close();
  }
});

for (const lane of ["control", "frames"] as const) {
  test(`split ${lane} loss stops its pair and preserves a sibling viewer`, async ({
    page,
  }) => {
    const backend = await launchNativeBackend(server.origin);
    try {
      const a = await editor(backend);
      const b = await editor(backend);
      const routes: {
        socket: WebSocketRoute;
        methods: string[];
        targetId?: string;
        frames: number;
      }[] = [];
      await page.routeWebSocket(backend.endpoint, (socket) => {
        const record: (typeof routes)[number] = {
          socket,
          methods: [],
          frames: 0,
        };
        routes.push(record);
        const upstream = socket.connectToServer();
        socket.onMessage((raw) => {
          const command = JSON.parse(String(raw)) as {
            method: string;
            params?: { targetId?: string };
          };
          record.methods.push(command.method);
          if (
            command.method === "Target.attachToTarget" &&
            command.params?.targetId
          )
            record.targetId = command.params?.targetId;
          upstream.send(raw);
        });
        upstream.onMessage((raw) => {
          if (
            (JSON.parse(String(raw)) as { method?: string }).method ===
            "Page.screencastFrame"
          )
            record.frames++;
          socket.send(raw);
        });
      });
      const settings: FixtureSettings = {
        cdpUrl: backend.endpoint,
        windowA: a.windowId,
        windowB: b.windowId,
        interactive: true,
        transport: "split",
      };
      const first = await connect(page, settings);
      const second = page.locator("#viewer-b .cdpv-root");
      await expect(second).toHaveAttribute("data-status", "streaming");
      const pair = routes.filter((route) => route.targetId === a.targetId);
      expect(pair).toHaveLength(2);
      const control = pair.find((route) =>
        route.methods.includes("Page.enable"),
      )!;
      const frames = pair.find((route) =>
        route.methods.includes("Page.startScreencast"),
      )!;
      expect(control).not.toBe(frames);
      expect(control.frames).toBe(0);
      expect(frames.frames).toBeGreaterThan(0);
      await clickInput(page, first, a.remote);
      await page.keyboard.insertText("once");
      await expect(a.remote.locator("#plain")).toHaveValue("once");
      expect(frames.methods.some((method) => method.startsWith("Input."))).toBe(
        false,
      );
      await (lane === "control" ? control : frames).socket.close();
      await expect(first).toHaveAttribute("data-status", "disconnected");
      await expect(first.getByLabel("Remote browser input")).toBeDisabled();
      await expect(second).toHaveAttribute("data-status", "streaming");
      await clickInput(page, second, b.remote);
      await page.keyboard.insertText("sibling");
      await expect(b.remote.locator("#plain")).toHaveValue("sibling");
      await first.getByRole("button", { name: "Reconnect" }).click();
      await expect(first).toHaveAttribute("data-status", "streaming");
      await expect(a.remote.locator("#plain")).toHaveValue("once");
      await clickInput(page, first, a.remote);
      await page.keyboard.press("End");
      await page.keyboard.insertText(" again");
      await expect(a.remote.locator("#plain")).toHaveValue("once again");
    } finally {
      await backend.close();
    }
  });
}
