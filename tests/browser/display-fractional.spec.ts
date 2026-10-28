import { expect, test } from "@playwright/test";
import { launchNativeBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.use({ deviceScaleFactor: 1 });
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

function jpegSize(data: string) {
  const bytes = Buffer.from(data, "base64");
  for (let offset = 2; offset + 9 < bytes.length;) {
    const marker = bytes[offset + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2)
      return {
        width: bytes.readUInt16BE(offset + 7),
        height: bytes.readUInt16BE(offset + 5),
      };
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error("Owned frame has no JPEG dimensions.");
}

for (const { nativeDpr, zoom, transport, preEmulated } of [
  { nativeDpr: 1.25, zoom: 1, transport: "shared", preEmulated: false },
  { nativeDpr: 1.25, zoom: 1, transport: "split", preEmulated: false },
  { nativeDpr: 1.5, zoom: 1, transport: "shared", preEmulated: false },
  { nativeDpr: 1.75, zoom: 1.25, transport: "shared", preEmulated: false },
  { nativeDpr: 1.25, zoom: 1, transport: "shared", preEmulated: true },
] as const) {
  test(`presents complete native JPEG and input at fractional DPR ${nativeDpr}, zoom ${zoom}, ${transport}, pre-emulation ${preEmulated}`, async ({
    page,
  }) => {
    const backend = await launchNativeBackend(server.origin, true, nativeDpr);
    try {
      const opened = backend.context.waitForEvent("page");
      const { targetId } = await backend.session.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      const remote = await opened;
      await remote.goto(server.origin + "/fixture/editor");
      await remote.setContent(
        '<style>html,body{margin:0;background:white}body{height:3000px}button{position:fixed;left:120px;top:80px;width:80px;height:40px;background:rgb(232,32,48)}#corner{position:fixed;right:0;bottom:0;width:64px;height:64px;background:rgb(232,32,48)}</style><button id="control">Control</button><div id="corner"></div><script>window.hits=0;window.wheel=0;window.pointer=null;document.querySelector("button").onclick=e=>{window.hits++;window.pointer={x:e.clientX,y:e.clientY}};document.addEventListener("wheel",e=>window.wheel+=e.deltaY);</script>',
      );
      if (zoom !== 1) {
        const worker =
          backend.context.serviceWorkers()[0] ??
          (await backend.context.waitForEvent("serviceworker"));
        expect(
          await worker.evaluate(
            async ({ url, zoom }) => {
              const tabs = (
                globalThis as unknown as {
                  chrome: {
                    tabs: {
                      query(options: {
                        url: string;
                      }): Promise<{ id: number }[]>;
                      setZoom(id: number, zoom: number): Promise<void>;
                      getZoom(id: number): Promise<number>;
                    };
                  };
                }
              ).chrome.tabs;
              const [tab] = await tabs.query({ url });
              if (!tab) throw new Error("Owned tab is unavailable.");
              await tabs.setZoom(tab.id, zoom);
              return tabs.getZoom(tab.id);
            },
            { url: server.origin + "/fixture/editor", zoom },
          ),
        ).toBe(zoom);
      }
      const beforeWindow = await backend.session.send(
        "Browser.getWindowForTarget",
        { targetId },
      );
      const inspection = await backend.context.newCDPSession(remote);
      const beforeLayout = await inspection.send("Page.getLayoutMetrics");
      if (preEmulated)
        await inspection.send("Emulation.setDeviceMetricsOverride", {
          width: 900,
          height: 600,
          deviceScaleFactor: 2,
          scale: 1,
          dontSetVisibleSize: true,
          mobile: false,
        });
      const frames: {
        device: { width: number; height: number };
        raster: { width: number; height: number };
      }[] = [];
      const pointers: {
        type?: string;
        x?: number;
        y?: number;
        deltaY?: number;
      }[] = [];
      let writes = 0,
        starts = 0,
        attachments = 0;
      await page.routeWebSocket(backend.endpoint, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message));
          if (command.method === "Browser.setContentsSize") writes++;
          if (command.method === "Page.startScreencast") starts++;
          if (command.method === "Target.attachToTarget") attachments++;
          if (command.method === "Input.dispatchMouseEvent")
            pointers.push(command.params);
          upstream.send(message);
        });
        upstream.onMessage((message) => {
          const event = JSON.parse(String(message));
          if (event.method === "Page.screencastFrame") {
            frames.push({
              device: {
                width: event.params.metadata.deviceWidth,
                height: event.params.metadata.deviceHeight,
              },
              raster: jpegSize(event.params.data),
            });
            if (frames.length > 64) frames.shift();
          }
          socket.send(message);
        });
      });
      await page.goto(server.origin);
      await page.addStyleTag({
        content:
          "#panels{display:block!important}#viewer-a .cdpv-root{width:1100px;height:820px}",
      });
      await page.waitForFunction(
        () => typeof window.configureViewers === "function",
      );
      await page.evaluate(
        async (settings) => window.configureViewers!(settings),
        {
          cdpUrl: backend.endpoint,
          windowA: beforeWindow.windowId,
          second: false,
          interactive: true,
          // Validate native raster rounding independently of automatic sampling.
          captureA: {
            format: "jpeg" as const,
            maxWidth: 4096,
            maxHeight: 2025,
          },
          transport,
        },
      );
      const view = page.locator("#viewer-a .cdpv-root"),
        canvas = view.locator("canvas");
      await expect(view).toHaveAttribute("data-status", "streaming");
      const input = await view
        .getByLabel("Remote browser input")
        .elementHandle();
      const sync = async () => {
        await view.getByRole("button", { name: "Browser menu" }).click();
        await view
          .getByRole("menuitem", { name: "Fit page to viewer", exact: true })
          .click();
      };
      expect(writes).toBe(0);
      await sync();
      await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
      await expect(view.getByRole("alert")).toHaveCount(0);
      const layout = await remote.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }));
      expect(layout.width).toBe(1098);
      expect(layout.height).toBe(730);
      expect(layout.dpr).toBeCloseTo(1, 6);
      const afterWindow = await backend.session.send(
        "Browser.getWindowForTarget",
        { targetId },
      );
      const expected = {
        width:
          beforeLayout.cssVisualViewport.clientWidth * zoom +
          afterWindow.bounds.width! -
          beforeWindow.bounds.width!,
        height:
          beforeLayout.cssVisualViewport.clientHeight * zoom +
          afterWindow.bounds.height! -
          beforeWindow.bounds.height!,
      };
      const raster = await canvas.evaluate((element: HTMLCanvasElement) => ({
        width: element.width,
        height: element.height,
      }));
      const frame = [...frames]
        .reverse()
        .find(
          (frame) =>
            frame.raster.width === raster.width &&
            frame.raster.height === raster.height &&
            Math.abs(frame.device.width - expected.width) <= 1 &&
            Math.abs(frame.device.height - expected.height) <= 1,
        );
      expect(frame).toBeDefined();
      expect(raster.width).toBe(Math.round(frame!.device.width * nativeDpr));
      expect(raster.height).toBe(Math.round(frame!.device.height * nativeDpr));
      await expect
        .poll(() =>
          canvas.evaluate((element: HTMLCanvasElement) => {
            const pixel = element
              .getContext("2d")!
              // Sample a uniform JPEG block away from fractional native padding.
              .getImageData(element.width - 32, element.height - 32, 1, 1).data;
            return Math.max(
              Math.abs(pixel[0]! - 232),
              Math.abs(pixel[1]! - 32),
              Math.abs(pixel[2]! - 48),
            );
          }),
        )
        .toBeLessThanOrEqual(5);
      const position = await canvas.evaluate((element: HTMLCanvasElement) => {
        const box = element.getBoundingClientRect(),
          scale = Math.min(
            box.width / element.width,
            box.height / element.height,
          );
        return {
          x: box.x + (box.width - element.width * scale) / 2 + 160 * scale,
          y: box.y + (box.height - element.height * scale) / 2 + 100 * scale,
        };
      });
      await canvas.evaluate((element) =>
        element.addEventListener(
          "mousedown",
          (event) => {
            const point = event as MouseEvent;
            (element as HTMLCanvasElement).dataset.point = JSON.stringify({
              x: point.clientX,
              y: point.clientY,
            });
          },
          { once: true },
        ),
      );
      await page.mouse.click(position.x, position.y);
      await expect.poll(() => remote.evaluate("window.hits")).toBe(1);
      const pointer = await remote.evaluate<{ x: number; y: number }>(
        "window.pointer",
      );
      const press = pointers.find((p) => p.type === "mousePressed")!;
      const normalized = await canvas.evaluate((element: HTMLCanvasElement) => {
        const point = JSON.parse(element.dataset.point!) as {
          x: number;
          y: number;
        };
        const box = element.getBoundingClientRect(),
          scale = Math.min(
            box.width / element.width,
            box.height / element.height,
          );
        return {
          x:
            (point.x - box.x - (box.width - element.width * scale) / 2) /
            (element.width * scale),
          y:
            (point.y - box.y - (box.height - element.height * scale) / 2) /
            (element.height * scale),
        };
      });
      expect(press.x).toBeCloseTo(
        (normalized.x * frame!.device.width) / zoom,
        8,
      );
      expect(press.y).toBeCloseTo(
        (normalized.y * frame!.device.height) / zoom,
        8,
      );
      // Native MouseEvent coordinates truncate physical-to-CSS float rounding.
      expect(pointer.x).toBe(Math.floor(press.x! * nativeDpr * zoom));
      expect(pointer.y).toBe(Math.floor(press.y! * nativeDpr * zoom));
      await page.mouse.wheel(0, 120);
      await expect
        .poll(() => remote.evaluate("window.wheel"))
        .toBeCloseTo(120, 2);
      await expect
        .poll(() => remote.evaluate(() => scrollY))
        .toBeGreaterThan(0);
      const beforeReuse = { writes, starts, attachments };
      await sync();
      await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
      expect({ writes, starts, attachments }).toEqual(beforeReuse);
      expect(writes).toBe(1);
      expect(attachments).toBe(transport === "split" ? 2 : 1);
      expect(await input!.evaluate((element) => element.isConnected)).toBe(
        true,
      );
      await test.info().attach("fractional-native-geometry", {
        body: JSON.stringify({
          nativeDpr,
          zoom,
          transport,
          preEmulated,
          beforeWindow,
          beforeLayout,
          afterWindow,
          layout,
          frame,
          pointer,
          press,
          beforeReuse,
        }),
        contentType: "application/json",
      });
    } finally {
      await backend.close();
    }
  });
}
