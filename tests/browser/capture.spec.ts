import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  launchBackend,
  launchNativeBackend,
  serveBrowserConsumer,
} from "./backend";
import type { FixtureSettings } from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

async function editor(backend: Awaited<ReturnType<typeof launchBackend>>) {
  const created = backend.context.waitForEvent("page");
  const target = await backend.session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const remote = await created;
  await remote.setViewportSize({ width: 1920, height: 1080 });
  await remote.goto(server.origin + "/fixture/editor");
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    { targetId: target.targetId },
  );
  return { remote, windowId };
}

async function point(view: Locator, remote: Page, x: number, y: number) {
  const viewport = await remote.evaluate(() => ({
    width: visualViewport!.width,
    height: visualViewport!.height,
  }));
  return view.locator("canvas").evaluate(
    (canvas: HTMLCanvasElement, point) => {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(
        rect.width / canvas.width,
        rect.height / canvas.height,
      );
      const width = canvas.width * scale;
      const height = canvas.height * scale;
      return {
        x:
          rect.left +
          (rect.width - width) / 2 +
          (width * point.x) / point.width,
        y:
          rect.top +
          (rect.height - height) / 2 +
          (height * point.y) / point.height,
      };
    },
    { x, y, ...viewport },
  );
}

async function clickInput(page: Page, view: Locator, remote: Page) {
  const box = await remote.locator("#plain").boundingBox();
  if (!box) throw new Error("Owned input has no bounds.");
  const position = await point(
    view,
    remote,
    box.x + 20,
    box.y + box.height / 2,
  );
  await page.mouse.click(position.x, position.y);
  await expect(view.getByLabel("Remote browser input")).toBeFocused();
  await expect(remote.locator("#plain")).toBeFocused();
}

async function expectWidth(view: Locator, width: number) {
  await expect
    .poll(() =>
      view
        .locator("canvas")
        .evaluate((canvas: HTMLCanvasElement) => canvas.width),
    )
    .toBe(width);
}

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`capture at client DPR ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor, viewport: { width: 1440, height: 1000 } });
    test("live detail changes preserve native composition, geometry and another window", async ({
      page,
    }, info) => {
      const backend = await launchBackend(
        info.outputPath("backend"),
        server.origin,
      );
      try {
        const a = await editor(backend);
        const b = await editor(backend);
        let sockets = 0;
        const commands: {
          method: string;
          params?: Record<string, unknown>;
          sessionId?: string;
        }[] = [];
        await page.routeWebSocket(backend.endpoint, (socket) => {
          sockets++;
          const upstream = socket.connectToServer();
          socket.onMessage((message) => {
            commands.push(
              JSON.parse(String(message)) as (typeof commands)[number],
            );
            upstream.send(message);
          });
        });
        await page.goto(server.origin);
        await page.waitForFunction(
          () => typeof window.configureViewers === "function",
        );
        const settings: FixtureSettings = {
          cdpUrl: backend.endpoint,
          windowA: a.windowId,
          windowB: b.windowId,
          interactive: true,
          captureB: { maxWidth: 960, maxHeight: 540 },
        };
        await page.evaluate(
          (settings) => window.configureViewers!(settings),
          settings,
        );
        const first = page.locator("#viewer-a .cdpv-root");
        const second = page.locator("#viewer-b .cdpv-root");
        await expect(first).toHaveAttribute("data-status", "streaming");
        await expect(second).toHaveAttribute("data-status", "streaming");
        await expectWidth(first, 1920);
        await expectWidth(second, 960);
        const socketCount = sockets;
        const attachments = commands.filter(
          (c) => c.method === "Target.attachToTarget",
        ).length;
        const viewport = await a.remote.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        }));
        const proxy = first.getByLabel("Remote browser input");
        const proxyHandle = await proxy.elementHandle();
        await clickInput(page, first, a.remote);
        await page.keyboard.insertText("capture ");
        await expect(a.remote.locator("#plain")).toHaveValue("capture ");
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
        await expect(a.remote.locator("#plain")).toHaveValue("capture ni");
        const before = commands.length;
        await page.evaluate((settings) => window.configureViewers!(settings), {
          ...settings,
          captureA: { quality: 50, maxWidth: 1280, maxHeight: 720 },
        });
        await expectWidth(first, 1280);
        expect(
          await proxy.evaluate((element, old) => element === old, proxyHandle),
        ).toBe(true);
        await expect(proxy).toBeFocused();
        await expect(a.remote.locator("#plain")).toHaveValue("capture ni");
        expect(
          commands
            .slice(before)
            .some(
              (c) =>
                c.method === "Input.imeSetComposition" ||
                c.method === "Target.detachFromTarget",
            ),
        ).toBe(false);
        await proxy.evaluate((element) =>
          element.dispatchEvent(
            new CompositionEvent("compositionend", {
              bubbles: true,
              data: "你",
            }),
          ),
        );
        await expect(a.remote.locator("#plain")).toHaveValue("capture 你");
        expect(sockets).toBe(socketCount);
        expect(
          commands.filter((c) => c.method === "Target.attachToTarget"),
        ).toHaveLength(attachments);
        expect(
          commands.filter(
            (c) =>
              c.method.startsWith("Emulation.") ||
              c.method === "Browser.setWindowBounds",
          ),
        ).toHaveLength(0);
        expect(
          await a.remote.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
          })),
        ).toEqual(viewport);
        await expectWidth(second, 960);
        await expect(second).toHaveAttribute("data-status", "streaming");

        await page.setViewportSize({ width: 1100, height: 900 });
        await page.evaluate((settings) => window.configureViewers!(settings), {
          ...settings,
          captureA: { maxWidth: 960, maxHeight: 540 },
        });
        await expectWidth(first, 960);
        const cdp = await backend.context.newCDPSession(a.remote);
        await cdp.send("Emulation.setPageScaleFactor", {
          pageScaleFactor: 1.25,
        });
        await a.remote.evaluate(() => {
          document.body.style.background = "rgb(24,80,224)";
        });
        await expect
          .poll(() =>
            first.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
              const pixel = canvas
                .getContext("2d")!
                .getImageData(0, 0, 1, 1).data;
              return Math.max(
                Math.abs(pixel[0]! - 24),
                Math.abs(pixel[1]! - 80),
                Math.abs(pixel[2]! - 224),
              );
            }),
          )
          .toBeLessThanOrEqual(4);
        await clickInput(page, first, a.remote);
        await page.keyboard.press("End");
        await page.keyboard.insertText(" resized");
        await expect(a.remote.locator("#plain")).toHaveValue(
          "capture 你 resized",
        );
        const bounds = await a.remote.locator("#plain").boundingBox();
        if (!bounds) throw new Error("Owned input has no bounds.");
        const from = await point(first, a.remote, bounds.x + 8, bounds.y + 20);
        const to = await point(first, a.remote, bounds.x + 140, bounds.y + 20);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 5 });
        await page.mouse.up();
        await expect
          .poll(() =>
            a.remote
              .locator("#plain")
              .evaluate(
                (input: HTMLInputElement) =>
                  (input.selectionEnd ?? 0) - (input.selectionStart ?? 0),
              ),
          )
          .toBeGreaterThan(0);
        await cdp.detach();
        await page.screenshot({ path: info.outputPath("capture-input.png") });
        await page.evaluate(() => window.removeFirstViewer!());
        await expect(first).toHaveCount(0);
        await expect(second).toHaveAttribute("data-status", "streaming");
        await clickInput(page, second, b.remote);
        await page.keyboard.insertText("independent");
        await expect(b.remote.locator("#plain")).toHaveValue("independent");
      } finally {
        await backend.close();
      }
    });
  });
}

test("paused capture preferences apply to the first frame after resume", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { windowId } = await editor(backend);
    const starts: unknown[] = [];
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as { method: string };
        if (command.method === "Page.startScreencast") starts.push(command);
        upstream.send(message);
      });
    });
    await page.goto(server.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    const settings: FixtureSettings = {
      cdpUrl: backend.endpoint,
      windowA: windowId,
      second: false,
      paused: true,
    };
    await page.evaluate(
      (settings) => window.configureViewers!(settings),
      settings,
    );
    const view = page.locator("#viewer-a .cdpv-root");
    await expect(view).toHaveAttribute("data-status", "paused");
    await page.evaluate((settings) => window.configureViewers!(settings), {
      ...settings,
      captureA: { quality: 80, maxWidth: 960, maxHeight: 540 },
    });
    expect(starts).toHaveLength(0);
    await page.evaluate((settings) => window.configureViewers!(settings), {
      ...settings,
      paused: false,
      captureA: { quality: 80, maxWidth: 960, maxHeight: 540 },
    });
    await expect(view).toHaveAttribute("data-status", "streaming");
    await expectWidth(view, 960);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      params: { format: "jpeg", quality: 80, maxWidth: 960, maxHeight: 540 },
    });
  } finally {
    await backend.close();
  }
});

test.describe("capture with adapted display", () => {
  test.use({ deviceScaleFactor: 2 });
  test("bounded capture remains compatible with display presentation and pointer input", async ({
    page,
  }, info) => {
    const backend = await launchNativeBackend(server.origin, true, 1);
    try {
      const created = backend.context.waitForEvent("page");
      const target = await backend.session.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      const remote = await created;
      await remote.goto(server.origin + "/fixture/editor");
      const { windowId } = await backend.session.send(
        "Browser.getWindowForTarget",
        { targetId: target.targetId },
      );
      const commands: string[] = [];
      await page.routeWebSocket(backend.endpoint, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as { method: string };
          commands.push(command.method);
          upstream.send(message);
        });
      });
      await page.goto(server.origin);
      await page.addStyleTag({
        content:
          "#panels{display:block!important}#viewer-a .cdpv-root{width:700px;height:520px}",
      });
      await page.waitForFunction(
        () => typeof window.configureViewers === "function",
      );
      const settings: FixtureSettings = {
        cdpUrl: backend.endpoint,
        windowA: windowId,
        second: false,
        interactive: true,
        windowSizeSync: "initial",
        captureA: { maxWidth: 960, maxHeight: 540 },
      };
      await page.evaluate(
        (settings) => window.configureViewers!(settings),
        settings,
      );
      const view = page.locator("#viewer-a .cdpv-root");
      await expect(view).toHaveAttribute("data-status", "streaming");
      await expect.poll(() => remote.evaluate(() => devicePixelRatio)).toBe(2);
      await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
      const canvas = view.locator("canvas");
      await expect
        .poll(() =>
          canvas.evaluate((canvas: HTMLCanvasElement) => canvas.height),
        )
        .toBeLessThanOrEqual(540);
      await clickInput(page, view, remote);
      await page.keyboard.insertText("adapted capture");
      await expect(remote.locator("#plain")).toHaveValue("adapted capture");
      const native = await remote.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }));
      const before = commands.length;
      await page.evaluate((settings) => window.configureViewers!(settings), {
        ...settings,
        captureA: { quality: 50, maxWidth: 640, maxHeight: 360 },
      });
      await expect
        .poll(() =>
          canvas.evaluate((canvas: HTMLCanvasElement) =>
            Math.max(canvas.width / 640, canvas.height / 360),
          ),
        )
        .toBeLessThanOrEqual(1);
      await clickInput(page, view, remote);
      await page.keyboard.press("End");
      await page.keyboard.insertText(" updated");
      await expect(remote.locator("#plain")).toHaveValue(
        "adapted capture updated",
      );
      expect(
        await remote.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        })),
      ).toEqual(native);
      expect(
        commands
          .slice(before)
          .filter(
            (method) =>
              method.startsWith("Emulation.") ||
              method === "Browser.setContentsSize",
          ),
      ).toHaveLength(0);
      await page.screenshot({
        path: info.outputPath("adapted-bounded-capture.png"),
      });
    } finally {
      await backend.close();
    }
  });
});
