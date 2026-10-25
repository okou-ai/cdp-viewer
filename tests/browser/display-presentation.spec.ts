import { expect, test } from "@playwright/test";
import { launchNativeBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
interface PointerObservation {
  hits: number;
  completedReleases: number;
  pointer: { x: number; y: number; target: string };
}

for (const [transport, bounded] of [
  ["shared", false],
  ["split", false],
  ["shared", true],
  ["split", true],
] as const)
  test.describe(`same raster across ${bounded ? "bounded native resizing" : "DPR changes"} (${transport})`, () => {
    test.use({ deviceScaleFactor: 2 });
    test("does not admit old pixels until the native transition paints a fresh capture", async ({
      page,
    }) => {
      const backend = await launchNativeBackend(server.origin, true, 1);
      try {
        const opened = backend.context.waitForEvent("page");
        const target = await backend.session.send("Target.createTarget", {
          url: "about:blank",
          newWindow: true,
        });
        const remote = await opened;
        await remote.goto(server.origin + "/fixture/editor");
        await remote.setContent(
          '<style>html,body{margin:0;background:white}button{position:fixed;left:120px;top:80px;width:80px;height:40px;background:rgb(232,32,48)}</style><button id="control">Control</button><input id="plain"><script>window.hits=0;window.ups=0;document.querySelector("button").onclick=()=>window.hits++;document.onpointerup=()=>window.ups++;</script>',
        );
        const { windowId } = await backend.session.send(
          "Browser.getWindowForTarget",
          { targetId: target.targetId },
        );
        let hold = false;
        const held: ((device?: { width: number; height: number }) => void)[] =
          [];
        let holdPreparation = false;
        let releasePreparation: (() => void) | undefined;
        let writes = 0;
        let pointers = 0;
        let starts = 0;
        let attachments = 0;
        await page.routeWebSocket(backend.endpoint, (socket) => {
          const upstream = socket.connectToServer();
          let preparationId: number | undefined;
          socket.onMessage((message) => {
            const c = JSON.parse(String(message)) as {
              id: number;
              method: string;
            };
            if (c.method === "Browser.setContentsSize") writes++;
            if (c.method === "Input.dispatchMouseEvent") pointers++;
            if (c.method === "Page.startScreencast") starts++;
            if (c.method === "Target.attachToTarget") attachments++;
            if (
              holdPreparation &&
              c.method === "Page.getLayoutMetrics" &&
              preparationId === undefined
            )
              preparationId = c.id;
            upstream.send(message);
          });
          upstream.onMessage((message) => {
            const e = JSON.parse(String(message)) as {
              id?: number;
              method?: string;
              params?: { metadata?: Record<string, unknown> };
            };
            if (preparationId !== undefined && e.id === preparationId)
              releasePreparation = () => socket.send(message);
            else if (hold && e.method === "Page.screencastFrame")
              held.push((device) =>
                socket.send(
                  device
                    ? JSON.stringify({
                        ...e,
                        params: {
                          ...e.params,
                          metadata: {
                            ...e.params?.metadata,
                            deviceWidth: device.width,
                            deviceHeight: device.height,
                          },
                        },
                      })
                    : message,
                ),
              );
            else socket.send(message);
          });
        });
        await page.goto(server.origin);
        await page.addStyleTag({
          content:
            "#panels{display:block!important}#viewer-a .cdpv-root{width:620px;height:460px}",
        });
        await page.waitForFunction(
          () => typeof window.configureViewers === "function",
        );
        await page.evaluate(
          async (settings) => window.configureViewers!(settings),
          {
            cdpUrl: backend.endpoint,
            windowA: windowId,
            second: false,
            interactive: true,
            ...(bounded
              ? {}
              : { captureA: { maxWidth: 4096, maxHeight: 2025 } }),
            transport,
          },
        );
        const view = page.locator("#viewer-a .cdpv-root"),
          canvas = view.locator("canvas");
        await expect(view).toHaveAttribute("data-status", "streaming");
        const sync = async () => {
          await view.getByRole("button", { name: "Browser menu" }).click();
          await view
            .getByRole("menuitem", { name: "Fit page to viewer", exact: true })
            .click();
        };
        await sync();
        await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
        await expect
          .poll(() =>
            remote.evaluate(() => ({
              width: innerWidth,
              height: innerHeight,
              dpr: devicePixelRatio,
            })),
          )
          .toEqual({ width: 618, height: 370, dpr: 2 });
        await remote.locator("#plain").focus();
        hold = true;
        await remote.evaluate(() => {
          document.body.style.background = "rgb(240,240,240)";
        });
        await expect.poll(() => held.length).toBeGreaterThan(0);
        const old = held.shift()!;
        const startsBefore = starts;
        if (bounded) {
          // Keep automatic bounds at the previous raster while native
          // preparation consumes the new observation from the resized panel.
          holdPreparation = true;
          await sync();
          await expect.poll(() => !!releasePreparation).toBe(true);
          await view.evaluate((element: HTMLElement) => {
            element.style.width = "929px";
            element.style.height = "645px";
          });
          await canvas.evaluate(
            (element) =>
              new Promise<void>((resolve) => {
                const observer = new ResizeObserver(() => {
                  observer.disconnect();
                  resolve();
                });
                observer.observe(element);
              }),
          );
        } else {
          const local = await page.context().newCDPSession(page);
          await local.send("Emulation.setDeviceMetricsOverride", {
            width: 1280,
            height: 900,
            deviceScaleFactor: 4,
            mobile: false,
          });
          await view.evaluate((e: HTMLElement) => {
            e.style.width = "311px";
            e.style.height = "275px";
          });
        }
        // Page scripts cannot provide the native capture clock.
        await remote.evaluate(() => {
          Date.now = () => 0;
        });
        if (bounded) {
          holdPreparation = false;
          releasePreparation!();
        } else await sync();
        await expect
          .poll(() =>
            remote.evaluate(() => ({
              width: innerWidth,
              height: innerHeight,
              dpr: devicePixelRatio,
            })),
          )
          .toEqual(
            bounded
              ? { width: 927, height: 555, dpr: 2 }
              : { width: 309, height: 185, dpr: 4 },
          );
        await expect.poll(() => writes).toBe(2);
        await expect.poll(() => held.length).toBeGreaterThan(0);
        await expect.poll(() => starts).toBe(startsBefore + 1);
        // Chrome can pair target-size metadata with cached JPEG pixels. Keep
        // the actual old image and timestamp while updating only that metadata.
        old(bounded ? { width: 1854, height: 1110 } : undefined);
        await expect(view.locator(".cdpv-spinning")).toHaveCount(1);
        const box = await canvas.boundingBox();
        if (!box) throw Error("No synthetic stage");
        const before = pointers;
        await page.mouse.click(box.x + 80, box.y + 50);
        await page.keyboard.insertText("during density transition");
        await expect(remote.locator("#plain")).toHaveValue(
          "during density transition",
        );
        expect(pointers).toBe(before);
        expect(await remote.evaluate("window.ups")).toBe(0);
        hold = false;
        for (const deliver of held.splice(0)) deliver();
        await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
        await expect
          .poll(() =>
            canvas.evaluate((element: HTMLCanvasElement, bounded) => {
              const p = element
                .getContext("2d")!
                .getImageData(
                  bounded ? 256 : 512,
                  bounded ? 176 : 352,
                  1,
                  1,
                ).data;
              return Math.max(
                Math.abs(p[0]! - 232),
                Math.abs(p[1]! - 32),
                Math.abs(p[2]! - 48),
              );
            }, bounded),
          )
          .toBeLessThanOrEqual(5);
        await page.mouse.click(box.x + 160, box.y + 100);
        await expect.poll(() => remote.evaluate("window.hits")).toBe(1);
        const result = await remote.evaluate(
          "({hits:window.hits,ups:window.ups})",
        );
        expect(starts).toBe(startsBefore + 1);
        expect(attachments).toBe(transport === "split" ? 2 : 1);
        await test.info().attach("same-raster-dpr", {
          body: JSON.stringify(result),
          contentType: "application/json",
        });
        expect(result).toEqual({ hits: 1, ups: 1 });
      } finally {
        await backend.close();
      }
    });
  });
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

for (const dpr of [1, 2]) {
  test.describe(`local DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test("refreshes a clipped static image once on the existing session", async ({
      page,
    }) => {
      const backend = await launchNativeBackend(server.origin, true, 1);
      try {
        const created = backend.context.waitForEvent("page");
        const target = await backend.session.send("Target.createTarget", {
          url: "about:blank",
          newWindow: true,
        });
        const remote = await created;
        await remote.setContent(
          // A fixed corner marker makes native resize produce a real paint.
          // A uniform static page may emit only its preceding-size frame, never
          // reaching the clipped-frame injection boundary this case exercises.
          '<style>html,body{margin:0;background:#eee}body::after{content:"";position:fixed;right:0;bottom:0;width:16px;height:16px;background:#444}</style><input id="plain">',
        );
        const { windowId } = await backend.session.send(
          "Browser.getWindowForTarget",
          { targetId: target.targetId },
        );
        let previousImage = "";
        let inject = false;
        let clipped = false;
        let starts = 0;
        let stops = 0;
        let writes = 0;
        let pointers = 0;
        let attachments = 0;
        const held: (() => void)[] = [];
        const desired = { width: 698, height: 410, dpr };
        await page.routeWebSocket(backend.endpoint, (socket) => {
          const upstream = socket.connectToServer();
          socket.onMessage((message) => {
            const command = JSON.parse(String(message)) as { method?: string };
            if (command.method === "Page.startScreencast") starts++;
            if (command.method === "Page.stopScreencast") stops++;
            if (command.method === "Browser.setContentsSize") writes++;
            if (command.method === "Input.dispatchMouseEvent") pointers++;
            if (command.method === "Target.attachToTarget") attachments++;
            upstream.send(message);
          });
          upstream.onMessage((message) => {
            const event = JSON.parse(String(message)) as {
              method?: string;
              params?: {
                data: string;
                metadata: { deviceWidth: number; deviceHeight: number };
              };
            };
            if (event.method === "Page.screencastFrame" && event.params) {
              if (inject && clipped) {
                if (held.length >= 8)
                  throw Error("Owned held-frame bound exceeded.");
                held.push(() => socket.send(message));
                return;
              }
              if (
                inject &&
                event.params.metadata.deviceWidth === desired.width * dpr &&
                event.params.metadata.deviceHeight === desired.height * dpr
              ) {
                // Keep the new native metadata/clock, but substitute preceding
                // pixels. No internal viewer API or page mutation supplies recovery.
                clipped = true;
                socket.send(
                  JSON.stringify({
                    ...event,
                    params: { ...event.params, data: previousImage },
                  }),
                );
                return;
              }
              if (!inject) previousImage = event.params.data;
            }
            socket.send(message);
          });
        });
        await page.goto(server.origin);
        await page.addStyleTag({
          content:
            "#panels{display:block!important}#viewer-a .cdpv-root{width:620px;height:460px}",
        });
        await page.waitForFunction(
          () => typeof window.configureViewers === "function",
        );
        await page.evaluate(
          async (settings) => window.configureViewers!(settings),
          {
            cdpUrl: backend.endpoint,
            windowA: windowId,
            second: false,
            interactive: true,
            captureA: { maxWidth: 4096, maxHeight: 2025 },
          },
        );
        const view = page.locator("#viewer-a .cdpv-root"),
          canvas = view.locator("canvas");
        await expect(view).toHaveAttribute("data-status", "streaming");
        const sync = async () => {
          await view.getByRole("button", { name: "Browser menu" }).click();
          await view
            .getByRole("menuitem", { name: "Fit page to viewer", exact: true })
            .click();
        };
        await sync();
        await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
        const raster = () =>
          canvas.evaluate((element: HTMLCanvasElement) => ({
            width: element.width,
            height: element.height,
          }));
        await expect
          .poll(raster)
          .toEqual({ width: 618 * dpr, height: 370 * dpr });
        const original = await view
          .getByLabel("Remote browser input")
          .elementHandle();
        const before = { starts, stops };
        inject = true;
        await view.evaluate((element: HTMLElement) => {
          element.style.width = "700px";
          element.style.height = "500px";
        });
        await sync();
        await expect.poll(() => clipped).toBe(true);
        await expect.poll(() => starts).toBe(before.starts + 1);
        await expect.poll(() => held.length).toBeGreaterThan(0);
        await expect(view.locator(".cdpv-spinning")).toHaveCount(1);
        expect(await raster()).toEqual({ width: 618 * dpr, height: 370 * dpr });
        const box = (await canvas.boundingBox())!;
        await page.mouse.click(box.x + 30, box.y + 20);
        expect(pointers).toBe(0);
        inject = false;
        for (const deliver of held.splice(0)) deliver();
        await expect.poll(raster).toEqual({
          width: desired.width * dpr,
          height: desired.height * dpr,
        });
        await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
        expect(
          await remote.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
          })),
        ).toEqual(desired);
        expect(
          await view
            .getByLabel("Remote browser input")
            .evaluate((node, input) => node === input, original),
        ).toBe(true);
        expect(starts).toBe(before.starts + 1);
        expect(stops).toBe(before.stops + 1);
        expect(writes).toBe(2);
        expect(attachments).toBe(1);
        await test.info().attach("conditional-refresh", {
          body: JSON.stringify({ dpr, starts, stops, writes, attachments }),
          contentType: "application/json",
        });
      } finally {
        await backend.close();
      }
    });

    test("keeps synchronization pending until a compatible image paints", async ({
      page,
    }) => {
      const backend = await launchNativeBackend(server.origin, true, 1);
      try {
        const created = backend.context.waitForEvent("page");
        const target = await backend.session.send("Target.createTarget", {
          url: "about:blank",
          newWindow: true,
        });
        const remote = await created;
        await remote.goto(server.origin + "/fixture/editor");
        await remote.setContent(`<!doctype html><html><head><style>
          html,body{margin:0;background:#eee}
          #control{position:fixed;left:240px;top:180px;width:100px;height:50px}
        </style></head><body><button id="control">Fixed control</button><input id="plain" aria-label="Text">
        <script>
          window.hits=0;window.ups=0;window.lastPointer=null;
          document.querySelector('#control').onclick=()=>window.hits++;
          document.addEventListener('pointerdown',event=>{
            window.lastPointer={x:event.clientX,y:event.clientY,target:event.target.id};
          });
          document.addEventListener('pointerup',()=>window.ups++);
        </script></body></html>`);
        const { windowId } = await backend.session.send(
          "Browser.getWindowForTarget",
          {
            targetId: target.targetId,
          },
        );
        let holdFrames = false;
        const held: (() => void)[] = [];
        let commands = 0;
        let writes = 0;
        await page.routeWebSocket(backend.endpoint, (socket) => {
          const upstream = socket.connectToServer();
          socket.onMessage((message) => {
            const command = JSON.parse(String(message)) as { method?: string };
            if (command.method === "Input.dispatchMouseEvent") commands++;
            if (
              command.method === "Emulation.setDeviceMetricsOverride" ||
              command.method === "Browser.setContentsSize"
            ) {
              // Allow native acquisition first; withhold images only once the
              // display write starts the presentation barrier under test.
              holdFrames = true;
              writes++;
            }
            upstream.send(message);
          });
          upstream.onMessage((message) => {
            const event = JSON.parse(String(message)) as { method?: string };
            if (holdFrames && event.method === "Page.screencastFrame") {
              if (held.length >= 8)
                throw new Error("Owned held-frame bound exceeded.");
              held.push(() => socket.send(message));
            } else socket.send(message);
          });
        });
        await page.goto(server.origin);
        await page.addStyleTag({
          content:
            "#panels{display:block!important}#viewer-a .cdpv-root{width:620px;height:460px}",
        });
        await page.waitForFunction(
          () => typeof window.configureViewers === "function",
        );
        await page.evaluate(
          async (settings) => window.configureViewers!(settings),
          {
            cdpUrl: backend.endpoint,
            windowA: windowId,
            second: false,
            interactive: true,
            captureA: { maxWidth: 4096, maxHeight: 2025 },
          },
        );
        const view = page.locator("#viewer-a .cdpv-root");
        // Hold native presentation frames at fixed detail, independently of
        // the ordinary container/DPR capture scheduler.
        await expect(view).toHaveAttribute("data-status", "streaming");
        const canvas = view.locator("canvas");
        const raster = () =>
          canvas.evaluate((element: HTMLCanvasElement) => ({
            width: element.width,
            height: element.height,
          }));
        const native = await remote.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }));
        await expect.poll(raster).toEqual(native);
        const control = await remote.locator("#control").boundingBox();
        const box = await canvas.boundingBox();
        if (!box || !control)
          throw new Error("Owned visible control has no geometry.");
        const clickPoint = (
          image: { width: number; height: number },
          surface: { width: number; height: number },
        ) => {
          const scale = Math.min(
            box.width / image.width,
            box.height / image.height,
          );
          const width = image.width * scale,
            height = image.height * scale;
          return {
            x:
              box.x +
              (box.width - width) / 2 +
              ((control.x + control.width / 2) / surface.width) * width,
            y:
              box.y +
              (box.height - height) / 2 +
              ((control.y + control.height / 2) / surface.height) * height,
          };
        };
        const oldPoint = clickPoint(native, native);
        await page.mouse.click(oldPoint.x, oldPoint.y);
        await expect.poll(() => remote.evaluate("window.hits")).toBe(1);
        await expect.poll(() => remote.evaluate("window.ups")).toBe(1);

        await remote.locator("#plain").focus();
        await view.getByRole("button", { name: "Browser menu" }).click();
        await view
          .getByRole("menuitem", { name: "Fit page to viewer", exact: true })
          .click();
        const desired = {
          width: Math.floor(box.width),
          height: Math.floor(box.height),
          dpr,
        };
        await expect
          .poll(() =>
            remote.evaluate(() => ({
              width: innerWidth,
              height: innerHeight,
              dpr: devicePixelRatio,
            })),
          )
          .toEqual(desired);
        await expect(view.locator(".cdpv-spinning")).toHaveCount(1);
        await expect.poll(() => held.length).toBeGreaterThan(0);
        const frozenRaster = await raster();
        const before = commands;
        await page.mouse.click(oldPoint.x, oldPoint.y);
        await page.keyboard.insertText("during presentation");
        await expect(remote.locator("#plain")).toHaveValue(
          "during presentation",
        );
        expect(commands).toBe(before);
        expect(await remote.evaluate("window.ups")).toBe(1);
        const frozen = await remote.evaluate<PointerObservation>(
          "({hits:window.hits,completedReleases:window.ups,pointer:window.lastPointer})",
        );

        holdFrames = false;
        for (const deliver of held.splice(0)) deliver();
        await expect.poll(raster).toEqual({
          width: desired.width * dpr,
          height: desired.height * dpr,
        });
        await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
        const paintedRaster = await raster();
        const newPoint = clickPoint(paintedRaster, desired);
        await page.mouse.click(newPoint.x, newPoint.y);
        await expect
          .poll(() => remote.evaluate("window.hits"))
          .toBeGreaterThan(frozen.hits);
        const painted = await remote.evaluate<PointerObservation>(
          "({hits:window.hits,completedReleases:window.ups,pointer:window.lastPointer})",
        );
        const observation = {
          source: process.env.CDP_VIEWER_SOURCE_SHA,
          dpr,
          native,
          desired,
          frozenRaster,
          paintedRaster,
          frozen,
          painted,
        };
        await test.info().attach("display-coherence", {
          body: JSON.stringify(observation),
          contentType: "application/json",
        });
        expect(frozen.hits).toBe(1);
        expect(painted.hits).toBe(2);
        expect(painted.completedReleases).toBe(2);
        // An unchanged manual request must not wait for a frame the browser has
        // no reason to produce, or perform redundant native display writes.
        holdFrames = true;
        const synchronizedWrites = writes;
        await view.getByRole("button", { name: "Browser menu" }).click();
        await view
          .getByRole("menuitem", { name: "Fit page to viewer", exact: true })
          .click();
        await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
        expect(writes).toBe(synchronizedWrites);
      } finally {
        await backend.close();
      }
    });
  });
}
