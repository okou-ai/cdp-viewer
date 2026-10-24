import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { launchBackend, serveBrowserConsumer } from "./backend";
import type { FixtureSettings } from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

async function editor(backend: Awaited<ReturnType<typeof launchBackend>>) {
  const opened = backend.context.waitForEvent("page");
  const target = await backend.session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const remote = await opened;
  await remote.setViewportSize({ width: 1920, height: 1080 });
  await remote.goto(server.origin + "/fixture/editor");
  await remote.evaluate(() => {
    document.documentElement.style.overflow = "hidden";
    for (const [corner, color] of [
      ["top:0;left:0", "rgb(24,80,224)"],
      ["bottom:0;right:0", "rgb(232,32,48)"],
    ]) {
      const marker = document.createElement("div");
      marker.style.cssText = `position:fixed;width:128px;height:128px;${corner};background:${color}`;
      document.body.append(marker);
    }
  });
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    {
      targetId: target.targetId,
    },
  );
  return { remote, windowId, targetId: target.targetId };
}

async function painted(view: Locator) {
  return view.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const box = canvas.getBoundingClientRect();
    const x = Math.max(1, Math.round((canvas.width * 64) / 1920));
    const y = Math.max(1, Math.round((canvas.height * 64) / 1080));
    const context = canvas.getContext("2d")!;
    const colors = [
      context.getImageData(x, y, 1, 1).data,
      context.getImageData(canvas.width - x, canvas.height - y, 1, 1).data,
    ];
    return {
      width: canvas.width,
      height: canvas.height,
      surface: { width: box.width, height: box.height, dpr: devicePixelRatio },
      markerError: Math.max(
        ...colors.flatMap((pixel, index) =>
          [24, 80, 224].map((channel, i) =>
            Math.abs(pixel[i]! - (index === 0 ? channel : [232, 32, 48][i]!)),
          ),
        ),
      ),
      markers: colors.map((pixel) => [...pixel]),
    };
  });
}

async function expectAutomaticPaint(view: Locator) {
  let observed: Awaited<ReturnType<typeof painted>> | null = null;
  try {
    await expect
      .poll(async () => {
        const image = await painted(view);
        observed = image;
        // Ordinary capture keeps the remote1920x1080 viewport. Chrome contains
        // that source within the panel's physical pixel demand without upscaling.
        const scale = Math.min(
          1,
          Math.floor(image.surface.width * image.surface.dpr) / 1920,
          Math.floor(image.surface.height * image.surface.dpr) / 1080,
        );
        return {
          raster:
            Math.max(
              Math.abs(image.width - Math.round(1920 * scale)),
              Math.abs(image.height - Math.round(1080 * scale)),
            ) <= 1,
          scene: image.markerError <= 8,
        };
      })
      .toEqual({ raster: true, scene: true });
  } catch (error) {
    await test.info().attach("automatic-paint-failure", {
      body: JSON.stringify(observed),
      contentType: "application/json",
    });
    await view.screenshot({
      path: test.info().outputPath("automatic-paint-failure.png"),
    });
    throw error;
  }
  return painted(view);
}

async function typeIntoRemote(
  page: Page,
  view: Locator,
  remote: Page,
  text: string,
) {
  const input = await remote.locator("#plain").boundingBox();
  if (!input) throw new Error("Owned input has no geometry.");
  const point = await view
    .locator("canvas")
    .evaluate((canvas: HTMLCanvasElement, input) => {
      const box = canvas.getBoundingClientRect();
      const scale = Math.min(
        box.width / canvas.width,
        box.height / canvas.height,
      );
      return {
        x:
          box.left +
          (box.width - canvas.width * scale) / 2 +
          ((input.x + input.width / 2) / 1920) * canvas.width * scale,
        y:
          box.top +
          (box.height - canvas.height * scale) / 2 +
          ((input.y + input.height / 2) / 1080) * canvas.height * scale,
      };
    }, input);
  await page.mouse.click(point.x, point.y);
  await expect(remote.locator("#plain")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.insertText(text);
}

for (const [deviceScaleFactor, transport] of [
  [1, "shared"],
  [1.25, "split"],
  [2, "shared"],
] as const) {
  test.describe(`automatic capture DPR${deviceScaleFactor}/${transport}`, () => {
    test.use({ deviceScaleFactor, viewport: { width: 1440, height: 1100 } });
    test("paints physical bounds and preserves input, resume and sibling ownership", async ({
      page,
    }, info) => {
      const backend = await launchBackend(
        info.outputPath("backend"),
        server.origin,
      );
      try {
        const a = await editor(backend),
          b = await editor(backend);
        const commands: { method: string; params?: Record<string, unknown> }[] =
          [];
        const bytes: number[] = [];
        let sockets = 0;
        await page.routeWebSocket(backend.endpoint, (socket) => {
          sockets++;
          const upstream = socket.connectToServer();
          const pending = new Map<number, string>();
          const sessions = new Map<string, string>();
          socket.onMessage((message) => {
            const command = JSON.parse(String(message)) as {
              id: number;
              method: string;
              params?: Record<string, unknown>;
            };
            commands.push(command);
            if (
              command.method === "Target.attachToTarget" &&
              typeof command.params?.targetId === "string"
            )
              pending.set(command.id, command.params.targetId);
            upstream.send(message);
          });
          upstream.onMessage((message) => {
            const response = JSON.parse(String(message)) as {
              id?: number;
              method?: string;
              sessionId?: string;
              result?: { sessionId?: string };
              params?: { data?: string };
            };
            if (response.id !== undefined) {
              const target = pending.get(response.id);
              if (target && response.result?.sessionId)
                sessions.set(response.result.sessionId, target);
              pending.delete(response.id);
            }
            const data = response.params?.data;
            if (
              response.method === "Page.screencastFrame" &&
              response.sessionId &&
              sessions.get(response.sessionId) === a.targetId &&
              data
            )
              bytes.push(
                (data.length * 3) / 4 -
                  (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0),
              );
            socket.send(message);
          });
        });
        await page.goto(server.origin);
        await page.addStyleTag({
          content:
            "#panels{display:block!important}#viewer-a .cdpv-root{width:640px;height:430px}#viewer-b .cdpv-root{width:400px;height:330px}",
        });
        await page.waitForFunction(
          () => typeof window.configureViewers === "function",
        );
        const settings: FixtureSettings = {
          cdpUrl: backend.endpoint,
          windowA: a.windowId,
          windowB: b.windowId,
          interactive: true,
          transport,
          captureB: { maxWidth: 960, maxHeight: 540 },
        };
        await page.evaluate(
          (settings) => window.configureViewers!(settings),
          settings,
        );
        const first = page.locator("#viewer-a .cdpv-root"),
          second = page.locator("#viewer-b .cdpv-root");
        await expect(first).toHaveAttribute("data-status", "streaming");
        await expect(second).toHaveAttribute("data-status", "streaming");
        const initial = await expectAutomaticPaint(first);
        await expect
          .poll(async () => (await painted(second)).markerError)
          .toBeLessThanOrEqual(8);
        const sibling = await painted(second);
        const socketCount = sockets;
        const attachments = commands.filter(
          (c) => c.method === "Target.attachToTarget",
        ).length;
        const native = await a.remote.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        }));
        const proxy = await first
          .getByLabel("Remote browser input")
          .elementHandle();
        await typeIntoRemote(page, first, a.remote, "automatic");
        await expect(a.remote.locator("#plain")).toHaveValue("automatic");
        await first.screenshot({
          path: info.outputPath("automatic-capture.png"),
        });
        let densityChanged: typeof initial | null = null;
        if (deviceScaleFactor === 1.25) {
          const local = await page.context().newCDPSession(page);
          await local.send("Emulation.setDeviceMetricsOverride", {
            // Headless CDP does not emit pure density-change notifications.
            // Resize the host by one pixel while keeping the panel box fixed.
            width: 1441,
            height: 1100,
            deviceScaleFactor: 2,
            mobile: false,
          });
          await expect
            .poll(() => page.evaluate(() => devicePixelRatio))
            .toBe(2);
          densityChanged = await expectAutomaticPaint(first);
          expect(densityChanged.width).toBeGreaterThan(initial.width);
          expect(densityChanged.surface.width).toBe(initial.surface.width);
          expect(densityChanged.surface.height).toBe(initial.surface.height);
          await local.detach();
        }

        await first.evaluate((element: HTMLElement) => {
          element.style.width = "400px";
          element.style.height = "320px";
        });
        const smaller = await expectAutomaticPaint(first);
        expect(smaller.width).toBeLessThan(initial.width);
        await typeIntoRemote(page, first, a.remote, " resized");
        await expect(a.remote.locator("#plain")).toHaveValue(
          "automatic resized",
        );

        await page.evaluate((settings) => window.configureViewers!(settings), {
          ...settings,
          captureA: { maxWidth: 320, maxHeight: 180 },
        });
        await expect.poll(async () => (await painted(first)).width).toBe(320);
        await page.evaluate(
          (settings) => window.configureViewers!(settings),
          settings,
        );
        await expectAutomaticPaint(first);
        expect(sockets).toBe(socketCount);
        expect(
          commands.filter((c) => c.method === "Target.attachToTarget"),
        ).toHaveLength(attachments);
        await page.evaluate((settings) => window.configureViewers!(settings), {
          ...settings,
          paused: true,
        });
        await expect(first).toHaveAttribute("data-status", "paused");
        await first.evaluate((element: HTMLElement) => {
          element.style.width = "500px";
          element.style.height = "360px";
        });
        await page.evaluate(
          (settings) => window.configureViewers!(settings),
          settings,
        );
        await expect(first).toHaveAttribute("data-status", "streaming");
        const resumed = await expectAutomaticPaint(first);
        if (transport === "split") {
          await first.evaluate((element: HTMLElement) => {
            element.style.transform = "translateX(-3000px)";
          });
          await expect(first).toHaveAttribute("data-status", "paused");
          await first.evaluate((element: HTMLElement) => {
            element.style.transform = "";
          });
          await expect(first).toHaveAttribute("data-status", "streaming");
          await expectAutomaticPaint(first);
        }
        expect(sockets).toBe(socketCount);
        // Pause/resume reacquires sessions, while ordinary capture changes above
        // retain the native input element and never reconnect the viewer sockets.
        expect(await proxy?.evaluate((element) => element.isConnected)).toBe(
          true,
        );
        expect(
          commands.filter((c) => c.method === "Target.attachToTarget").length,
        ).toBeGreaterThan(attachments);
        expect(
          commands.filter(
            (c) =>
              c.method.startsWith("Emulation.") ||
              c.method === "Browser.setContentsSize" ||
              c.method === "Browser.setWindowBounds",
          ),
        ).toHaveLength(0);
        expect(
          await a.remote.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
          })),
        ).toEqual(native);
        await expect(second).toHaveAttribute("data-status", "streaming");
        expect((await painted(second)).width).toBe(sibling.width);
        await page.evaluate(() => window.removeFirstViewer!());
        await expect(first).toHaveCount(0);
        await typeIntoRemote(page, second, b.remote, "sibling remains usable");
        await expect(b.remote.locator("#plain")).toHaveValue(
          "sibling remains usable",
        );
        expect(a.remote.isClosed()).toBe(false);
        expect(b.remote.isClosed()).toBe(false);
        await info.attach("automatic-capture", {
          body: JSON.stringify({
            deviceScaleFactor,
            transport,
            initial,
            densityChanged,
            smaller,
            resumed,
            native,
            firstViewerJpegBytes: bytes,
            sockets,
          }),
          contentType: "application/json",
        });
      } finally {
        await backend.close();
      }
    });
  });
}
