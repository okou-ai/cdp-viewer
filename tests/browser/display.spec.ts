import { expect, test } from "@playwright/test";
import {
  launchBackend,
  launchNativeBackend,
  serveBrowserConsumer,
} from "./backend";
import type {} from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

test.use({ deviceScaleFactor: 2 });

interface ZoomTabs {
  query(query: { url: string }): Promise<{ id: number }[]>;
  setZoom(id: number, zoom: number): Promise<void>;
  getZoom(id: number): Promise<number>;
}

for (const boundary of ["override", "restore"] as const) {
  test(`recovers from an applied ${boundary} with a lost acknowledgement`, async ({
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
      const { windowId } = await backend.session.send(
        "Browser.getWindowForTarget",
        {
          targetId: target.targetId,
        },
      );
      const native = await remote.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }));
      await remote.locator("#plain").focus();
      const commands: string[] = [];
      const replies: (() => void)[] = [];
      let heldId: number | undefined;
      let failContents = boundary === "restore";
      const method =
        boundary === "override"
          ? "Emulation.setDeviceMetricsOverride"
          : "Emulation.clearDeviceMetricsOverride";
      await page.routeWebSocket(backend.endpoint, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as {
            id: number;
            method: string;
          };
          commands.push(command.method);
          if (command.method === method && heldId === undefined)
            heldId = command.id;
          if (failContents && command.method === "Browser.setContentsSize") {
            socket.send(
              JSON.stringify({
                id: command.id,
                error: {
                  code: -32601,
                  message: "Synthetic unsupported sizing",
                },
              }),
            );
          } else upstream.send(message);
        });
        upstream.onMessage((message) => {
          const response = JSON.parse(String(message)) as { id?: number };
          if (heldId !== undefined && response.id === heldId) {
            replies.push(() => socket.send(message));
          } else socket.send(message);
        });
      });
      await page.goto(server.origin);
      await page.addStyleTag({
        content:
          "#panels { display:block !important } #viewer-a .cdpv-root { width:620px;height:460px }",
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
        },
      );
      const view = page.locator("#viewer-a .cdpv-root");
      await expect(view).toHaveAttribute("data-status", "streaming");
      const canvas = view.locator("canvas");
      const sync = async () => {
        await view.getByRole("button", { name: "Browser menu" }).click();
        await view
          .getByRole("menuitem", { name: "Sync now", exact: true })
          .click();
      };
      await sync();
      if (boundary === "override") {
        await expect.poll(() => replies.length).toBe(1);
        const before = commands.filter(
          (value) => value === "Input.dispatchMouseEvent",
        ).length;
        await canvas.click({ position: { x: 20, y: 20 } });
        await page.keyboard.insertText("pending ");
        await expect(remote.locator("#plain")).toHaveValue("pending ");
        expect(
          commands.filter((value) => value === "Input.dispatchMouseEvent"),
        ).toHaveLength(before);
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.press("Backspace");
        await expect(remote.locator("#plain")).toHaveValue("");
      }
      // The library's real request deadline, rather than a test sleep, settles the held reply.
      await page.waitForFunction(
        (text) =>
          document
            .querySelector("#viewer-a .cdpv-error-current")
            ?.textContent?.includes(text),
        boundary === "override"
          ? "Check window support"
          : "recovery could not be confirmed",
      );
      expect(replies).toHaveLength(1);
      expect(
        commands.filter(
          (value) => value === "Emulation.clearDeviceMetricsOverride",
        ),
      ).toHaveLength(1);
      await expect
        .poll(() =>
          remote.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
          })),
        )
        .toEqual(native);
      replies.shift()!();
      const clickPlain = async () => {
        const box = await canvas.boundingBox();
        const control = await remote.locator("#plain").boundingBox();
        const raster = await canvas.evaluate((element: HTMLCanvasElement) => ({
          width: element.width,
          height: element.height,
        }));
        const size = await remote.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }));
        if (!box || !control) throw new Error("Owned input has no geometry.");
        const scale = Math.min(
          box.width / raster.width,
          box.height / raster.height,
        );
        const width = raster.width * scale,
          height = raster.height * scale;
        await page.mouse.click(
          box.x +
            (box.width - width) / 2 +
            ((control.x + 20) / size.width) * width,
          box.y +
            (box.height - height) / 2 +
            ((control.y + control.height / 2) / size.height) * height,
        );
      };
      if (boundary === "override") await clickPlain();
      else {
        const before = commands.filter(
          (value) => value === "Input.dispatchMouseEvent",
        ).length;
        await canvas.click({ position: { x: 20, y: 20 } });
        await page.keyboard.insertText("after timeout");
        await expect(remote.locator("#plain")).toHaveValue("after timeout");
        expect(
          commands.filter((value) => value === "Input.dispatchMouseEvent"),
        ).toHaveLength(before);
      }
      if (boundary === "override") {
        await page.keyboard.insertText("after timeout");
        await expect(remote.locator("#plain")).toHaveValue("after timeout");
      }
      expect(
        commands.filter(
          (value) => value === "Emulation.setDeviceMetricsOverride",
        ),
      ).toHaveLength(1);
      failContents = false;
      await sync();
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Owned stage has no geometry.");
      await expect
        .poll(() =>
          remote.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
          })),
        )
        .toEqual({
          width: Math.floor(box.width),
          height: Math.floor(box.height),
          dpr: 2,
        });
      await clickPlain();
      await expect(remote.locator("#plain")).toBeFocused();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText("recovered");
      await expect(remote.locator("#plain")).toHaveValue("recovered");
      expect(
        commands.filter((value) => value === "Target.attachToTarget"),
      ).toHaveLength(1);
      expect(
        commands.filter(
          (value) => value === "Emulation.setDeviceMetricsOverride",
        ),
      ).toHaveLength(2);
    } finally {
      await backend.close();
    }
  });
}

for (const nativeDpr of [1, 2]) {
  test(`synchronizes actual streamed pixels and input at native DPR ${nativeDpr}`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
      nativeDpr,
    );
    try {
      const created = backend.context.waitForEvent("page");
      const target = await backend.session.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      const remote = await created;
      await remote.goto(server.origin + "/fixture/editor");
      const remoteCdp = await backend.context.newCDPSession(remote);
      // Retire Playwright's viewport override before the public viewer owns display adaptation.
      await remoteCdp.send("Emulation.clearDeviceMetricsOverride");
      const { windowId } = await backend.session.send(
        "Browser.getWindowForTarget",
        { targetId: target.targetId },
      );
      await remote.evaluate(() => {
        document.body.dataset.wheel = "0";
        document.addEventListener("wheel", (event) => {
          document.body.dataset.wheel = String(
            Number(document.body.dataset.wheel) + event.deltaY,
          );
        });
        const marker = document.createElement("div");
        marker.style.cssText =
          "position:fixed;right:0;bottom:0;width:30px;height:30px;background:rgb(232,32,48);z-index:999";
        document.body.append(marker);
      });
      const commands: string[] = [];
      await page.routeWebSocket(backend.endpoint, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          commands.push(
            (JSON.parse(String(message)) as { method: string }).method,
          );
          upstream.send(message);
        });
      });
      await page.goto(server.origin);
      await page.addStyleTag({
        content:
          "#panels { display:block !important } #viewer-a .cdpv-root { width:620px;height:460px }",
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
          hostForm: true,
        },
      );
      const view = page.locator("#viewer-a .cdpv-root");
      await expect(view).toHaveAttribute("data-status", "streaming");
      expect(commands).not.toContain("Browser.setContentsSize");
      const input = await view
        .getByRole("textbox", { name: "Remote browser input" })
        .elementHandle();
      const menu = view.getByRole("button", { name: "Browser menu" });
      const menuPosition = await menu.boundingBox();
      await menu.click();
      expect(await menu.boundingBox()).toEqual(menuPosition);
      await expect(
        view.getByRole("menuitemradio", { name: "Do not sync automatically" }),
      ).toHaveAttribute("aria-checked", "true");
      await view
        .getByRole("menuitem", { name: "Sync now", exact: true })
        .click();
      const canvas = view.locator("canvas");
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Owned stage has no geometry.");
      const logical = {
        width: Math.floor(box.width),
        height: Math.floor(box.height),
        dpr: 2,
      };
      await expect
        .poll(() =>
          remote.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
          })),
        )
        .toEqual(logical);
      await expect
        .poll(() =>
          canvas.evaluate((element: HTMLCanvasElement) => ({
            width: element.width,
            height: element.height,
          })),
        )
        .toEqual({ width: logical.width * 2, height: logical.height * 2 });
      // A full-frame corner marker rules out upscaling or an upper-left-only emulated image.
      await expect
        .poll(() =>
          canvas.evaluate((element: HTMLCanvasElement) => {
            const pixel = element
              .getContext("2d")!
              .getImageData(element.width - 10, element.height - 10, 1, 1).data;
            return Math.max(
              Math.abs(pixel[0]! - 232),
              Math.abs(pixel[1]! - 32),
              Math.abs(pixel[2]! - 48),
            );
          }),
        )
        .toBeLessThanOrEqual(5);
      const control = await remote.locator("#plain").boundingBox();
      if (!control) throw new Error("Owned input has no bounds.");
      await page.mouse.click(
        box.x + control.x + 20,
        box.y + control.y + control.height / 2,
      );
      await expect(remote.locator("#plain")).toBeFocused();
      await page.keyboard.insertText("中文🙂");
      await expect(remote.locator("#plain")).toHaveValue("中文🙂");
      await canvas.evaluate(
        (element, position) =>
          element.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              clientX: position.x + 20,
              clientY: position.y + 20,
              deltaY: 120,
            }),
          ),
        box,
      );
      await expect(remote.locator("body")).toHaveAttribute("data-wheel", "120");
      await page.keyboard.press("F8");
      await menu.click();
      await view
        .getByRole("menuitemradio", { name: "Sync once on opening" })
        .click();
      await expect(view.getByRole("menu")).not.toBeVisible();
      await view.evaluate((element: HTMLElement) => {
        element.style.width = "700px";
      });
      await expect
        .poll(() =>
          canvas.evaluate((element) => element.getBoundingClientRect().width),
        )
        .toBe(698);
      // Menu remains a combined manual action in initial mode.
      await menu.click();
      await view
        .getByRole("menuitem", { name: "Sync now", exact: true })
        .click();
      await expect(view.getByRole("menu")).not.toBeVisible();
      await expect.poll(() => remote.evaluate(() => innerWidth)).toBe(698);
      await menu.click();
      await view
        .getByRole("menuitemradio", { name: "Sync continuously" })
        .click();
      await expect(view.getByRole("menu")).not.toBeVisible();
      await view.evaluate((element: HTMLElement) => {
        element.style.width = "740px";
        element.style.height = "500px";
      });
      await expect.poll(() => remote.evaluate(() => innerWidth)).toBe(738);
      const localCdp = await page.context().newCDPSession(page);
      await localCdp.send("Emulation.setDeviceMetricsOverride", {
        // CDP density-only overrides do not emit resolution/resize events in headless Chromium.
        width: 1281,
        height: 720,
        deviceScaleFactor: 1.5,
        mobile: false,
      });
      await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(1.5);
      await expect
        .poll(() => remote.evaluate(() => devicePixelRatio))
        .toBe(1.5);
      await expect
        .poll(() =>
          canvas.evaluate((element: HTMLCanvasElement) =>
            Math.abs(
              element.width - element.getBoundingClientRect().width * 1.5,
            ),
          ),
        )
        .toBeLessThanOrEqual(2);
      await remote.evaluate(() => {
        scrollTo(0, 0);
        document.body.dataset.wheel = "0";
      });
      await expect.poll(() => remote.evaluate(() => scrollY)).toBe(0);
      const updatedBox = await canvas.boundingBox();
      const updatedInput = await remote.locator("#plain").boundingBox();
      if (!updatedBox || !updatedInput)
        throw new Error("Adapted control has no geometry.");
      await page.mouse.click(
        updatedBox.x + updatedInput.x + 20,
        updatedBox.y + updatedInput.y + updatedInput.height / 2,
      );
      await expect(remote.locator("#plain")).toBeFocused();
      await canvas.evaluate(
        (element, position) =>
          element.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              clientX: position.x + 20,
              clientY: position.y + 20,
              deltaY: 120,
            }),
          ),
        updatedBox,
      );
      await expect
        .poll(() => remote.evaluate(() => Number(document.body.dataset.wheel)))
        .toBeCloseTo(120, 2);
      await page.keyboard.press("F8");
      await menu.click();
      await expect(
        view.getByRole("menuitem", { name: "Sync now", exact: true }),
      ).toBeVisible();
      await expect(
        view.getByRole("menuitem", { name: "Sync now", exact: true }),
      ).toBeEnabled();
      await page.keyboard.press("Escape");
      expect(await input!.evaluate((element) => element.isConnected)).toBe(
        true,
      );
      expect(
        commands.filter((method) => method === "Target.attachToTarget"),
      ).toHaveLength(1);
      expect(
        commands.filter((method) => method === "Page.startScreencast"),
      ).toHaveLength(2);
      await expect(page.locator("#host-submissions")).toHaveText("0");
      await menu.click();
      await view
        .getByRole("menuitemradio", { name: "Do not sync automatically" })
        .click();
      await view.evaluate((element: HTMLElement) => {
        element.style.width = "190px";
      });
      await menu.click();
      const narrow = await view.boundingBox();
      if (!narrow) throw new Error("Narrow viewer has no geometry.");
      await expect
        .poll(async () => {
          const popup = await view.getByRole("menu").boundingBox();
          return popup
            ? Math.max(
                narrow.x - popup.x,
                popup.x + popup.width - narrow.x - narrow.width,
              )
            : Infinity;
        })
        .toBeLessThanOrEqual(1);
      await expect(
        view.getByRole("menuitem", { name: "Sync now", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Escape");
      await remoteCdp.detach();
      await localCdp.detach();
    } finally {
      await backend.close();
    }
  });
}

for (const nativeDpr of [1, 2]) {
  test(`preserves native browser zoom while fitting layout, DPR and input at native DPR ${nativeDpr}`, async ({
    page,
  }) => {
    const backend = await launchNativeBackend(server.origin, true, nativeDpr);
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
      const worker =
        backend.context.serviceWorkers()[0] ??
        (await backend.context.waitForEvent("serviceworker"));
      const tabId = await worker.evaluate(async (url) => {
        const tabs = (globalThis as unknown as { chrome: { tabs: ZoomTabs } })
          .chrome.tabs;
        const [tab] = await tabs.query({ url });
        return tab?.id;
      }, server.origin + "/fixture/editor");
      if (tabId === undefined) throw new Error("Owned tab is unavailable.");
      const changeZoom = (zoom: number) =>
        worker.evaluate(
          async ({ tabId, zoom }) => {
            const tabs = (
              globalThis as unknown as { chrome: { tabs: ZoomTabs } }
            ).chrome.tabs;
            await tabs.setZoom(tabId, zoom);
            return await tabs.getZoom(tabId);
          },
          { tabId, zoom },
        );
      expect(await changeZoom(1.25)).toBe(1.25);
      await expect
        .poll(() => remote.evaluate(() => devicePixelRatio))
        .toBeCloseTo(nativeDpr * 1.25, 6);
      await remote.evaluate(() => {
        const marker = document.createElement("div");
        marker.style.cssText =
          "position:fixed;right:0;bottom:0;width:30px;height:30px;background:rgb(232,32,48)";
        document.body.append(marker);
        document.body.dataset.wheel = "0";
        document.addEventListener("wheel", (event) => {
          document.body.dataset.wheel = String(
            Number(document.body.dataset.wheel) + event.deltaY,
          );
        });
      });
      let failContentsSize = false;
      await page.routeWebSocket(backend.endpoint, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as {
            id: number;
            method: string;
          };
          if (failContentsSize && command.method === "Browser.setContentsSize")
            socket.send(
              JSON.stringify({
                id: command.id,
                error: {
                  code: -32601,
                  message: "Synthetic unsupported capability",
                },
              }),
            );
          else upstream.send(message);
        });
      });
      await page.goto(server.origin);
      await page.addStyleTag({
        content:
          "#panels { display:block !important } #viewer-a .cdpv-root { width:620px;height:460px }",
      });
      await page.waitForFunction(
        () => typeof window.configureViewers === "function",
      );
      const configure = (mode: "off" | "initial") =>
        page.evaluate(async (settings) => window.configureViewers!(settings), {
          cdpUrl: backend.endpoint,
          windowA: windowId,
          second: false,
          interactive: true,
          windowSizeSync: mode,
        });
      await configure("off");
      const view = page.locator("#viewer-a .cdpv-root");
      await expect(view).toHaveAttribute("data-status", "streaming");
      const canvas = view.locator("canvas");
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Owned stage has no geometry.");
      const logical = {
        width: Math.floor(box.width),
        height: Math.floor(box.height),
      };
      const input = await view
        .getByRole("textbox", { name: "Remote browser input" })
        .elementHandle();
      const verifyInput = async (text: string) => {
        await remote.evaluate(() => {
          scrollTo(0, 0);
          document.body.dataset.wheel = "0";
        });
        await expect.poll(() => remote.evaluate(() => scrollY)).toBe(0);
        await remote.locator("#plain").fill("");
        await remote.locator("#plain").blur();
        const rect = await remote.locator("#plain").evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            x: bounds.x,
            y: bounds.y,
            height: bounds.height,
            viewportWidth: visualViewport!.width,
            viewportHeight: visualViewport!.height,
          };
        });
        const position = await canvas.evaluate(
          (element: HTMLCanvasElement, rect) => {
            const bounds = element.getBoundingClientRect();
            const scale = Math.min(
              bounds.width / element.width,
              bounds.height / element.height,
            );
            const width = element.width * scale,
              height = element.height * scale;
            return {
              x:
                bounds.x +
                (bounds.width - width) / 2 +
                ((rect.x + 20) / rect.viewportWidth) * width,
              y:
                bounds.y +
                (bounds.height - height) / 2 +
                ((rect.y + rect.height / 2) / rect.viewportHeight) * height,
            };
          },
          rect,
        );
        await page.mouse.click(position.x, position.y);
        await expect(remote.locator("#plain")).toBeFocused();
        await page.keyboard.insertText(text);
        await expect(remote.locator("#plain")).toHaveValue(text);
        await canvas.evaluate(
          (element, position) =>
            element.dispatchEvent(
              new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                clientX: position.x,
                clientY: position.y,
                deltaY: 120,
              }),
            ),
          position,
        );
        await expect
          .poll(() =>
            remote.evaluate(() => Number(document.body.dataset.wheel)),
          )
          .toBeCloseTo(120, 2);
        await page.keyboard.press("F8");
      };
      await verifyInput("untouched native zoom");
      await configure("initial");
      const verify = async (text: string) => {
        await expect
          .poll(() =>
            remote.evaluate(
              (expected) =>
                Math.max(
                  Math.abs(innerWidth - expected.width),
                  Math.abs(innerHeight - expected.height),
                ),
              logical,
            ),
          )
          .toBeLessThanOrEqual(1);
        await expect
          .poll(() => remote.evaluate(() => devicePixelRatio))
          .toBeCloseTo(2, 6);
        await expect
          .poll(() =>
            canvas.evaluate(
              (element: HTMLCanvasElement, expected) =>
                Math.max(
                  Math.abs(element.width - expected.width * 2),
                  Math.abs(element.height - expected.height * 2),
                ),
              logical,
            ),
          )
          .toBeLessThanOrEqual(2);
        await expect
          .poll(() =>
            canvas.evaluate((element: HTMLCanvasElement) => {
              const pixel = element
                .getContext("2d")!
                .getImageData(
                  element.width - 10,
                  element.height - 10,
                  1,
                  1,
                ).data;
              return Math.max(
                Math.abs(pixel[0]! - 232),
                Math.abs(pixel[1]! - 32),
                Math.abs(pixel[2]! - 48),
              );
            }),
          )
          .toBeLessThanOrEqual(5);
        await verifyInput(text);
      };
      await verify("zoom 125%");
      expect(await changeZoom(0.8)).toBe(0.8);
      const menu = view.getByRole("button", { name: "Browser menu" });
      await menu.click();
      await view
        .getByRole("menuitem", { name: "Sync now", exact: true })
        .click();
      await verify("zoom 80%");
      failContentsSize = true;
      await menu.click();
      await view
        .getByRole("menuitem", { name: "Sync now", exact: true })
        .click();
      await expect(view.getByRole("alert")).toContainText(
        "could not be synchronized",
      );
      await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
      await expect
        .poll(() => remote.evaluate(() => devicePixelRatio))
        .toBeCloseTo(nativeDpr * 0.8, 6);
      await verifyInput("restored native zoom");
      expect(await changeZoom(1.25)).toBe(1.25);
      await expect
        .poll(() => remote.evaluate(() => devicePixelRatio))
        .toBeCloseTo(nativeDpr * 1.25, 6);
      await verifyInput("changed native zoom");
      expect(
        await worker.evaluate(
          (id) =>
            (
              globalThis as unknown as { chrome: { tabs: ZoomTabs } }
            ).chrome.tabs.getZoom(id),
          tabId,
        ),
      ).toBe(1.25);
      expect(await input!.evaluate((element) => element.isConnected)).toBe(
        true,
      );
    } finally {
      await backend.close();
    }
  });
}

test("initial density restoration preserves native bounds across fractional-zoom tab changes", async ({
  page,
}) => {
  const backend = await launchNativeBackend(server.origin, true, 2);
  try {
    const created = backend.context.waitForEvent("page");
    const target = await backend.session.send("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    });
    const first = await created;
    await first.goto(server.origin + "/fixture/editor");
    await first.evaluate(() => {
      document.title = "First synthetic tab";
    });
    const { windowId } = await backend.session.send(
      "Browser.getWindowForTarget",
      { targetId: target.targetId },
    );
    const opened = backend.context.waitForEvent("page");
    await first.evaluate((url) => {
      window.open(url, "_blank");
    }, server.origin + "/fixture/editor?second");
    const second = await opened;
    await second.waitForLoadState();
    await second.evaluate(() => {
      document.title = "Second synthetic tab";
    });
    const worker =
      backend.context.serviceWorkers()[0] ??
      (await backend.context.waitForEvent("serviceworker"));
    await worker.evaluate(async (url) => {
      const tabs = (globalThis as unknown as { chrome: { tabs: ZoomTabs } })
        .chrome.tabs;
      const [tab] = await tabs.query({ url });
      if (!tab) throw new Error("Owned tab is unavailable.");
      await tabs.setZoom(tab.id, 0.8);
    }, server.origin + "/fixture/editor");
    await expect
      .poll(() => first.evaluate(() => devicePixelRatio))
      .toBeCloseTo(1.6, 6);
    await expect
      .poll(() => second.evaluate(() => devicePixelRatio))
      .toBeCloseTo(1.6, 6);
    await page.goto(server.origin);
    await page.addStyleTag({
      content:
        "#panels { display:block !important } #viewer-a .cdpv-root { width:620px;height:460px }",
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
        windowSizeSync: "initial" as const,
      },
    );
    const view = page.locator("#viewer-a .cdpv-root");
    const bounds = async () => {
      await expect(view).toHaveAttribute("data-status", "streaming");
      await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
      const result = await backend.session.send("Browser.getWindowForTarget", {
        targetId: target.targetId,
      });
      return { width: result.bounds.width, height: result.bounds.height };
    };
    await view
      .getByRole("tab", { name: "First synthetic tab", exact: true })
      .click();
    await expect
      .poll(() => first.evaluate(() => devicePixelRatio))
      .toBeCloseTo(2, 6);
    const original = await bounds();
    await view.evaluate((element: HTMLElement) => {
      element.style.width = "700px";
    });
    for (const remote of [second, first, second, first]) {
      const name =
        remote === first ? "First synthetic tab" : "Second synthetic tab";
      await view.getByRole("tab", { name, exact: true }).click();
      await expect
        .poll(() => remote.evaluate(() => devicePixelRatio))
        .toBeCloseTo(2, 6);
      expect(await bounds()).toEqual(original);
    }
  } finally {
    await backend.close();
  }
});

test("adapts two windows independently and retains the sibling after unmount", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
    1,
  );
  try {
    const windows = [];
    for (const color of ["red", "blue"]) {
      const created = backend.context.waitForEvent("page");
      const target = await backend.session.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      const remote = await created;
      await remote.goto(server.origin + "/fixture/" + color);
      const cdp = await backend.context.newCDPSession(remote);
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      const { windowId } = await backend.session.send(
        "Browser.getWindowForTarget",
        { targetId: target.targetId },
      );
      windows.push({ remote, windowId, cdp });
    }
    const first = windows[0]!,
      second = windows[1]!;
    await page.goto(server.origin);
    await page.addStyleTag({
      content:
        "#viewer-a .cdpv-root { width:460px;height:380px } #viewer-b .cdpv-root { width:560px;height:430px }",
    });
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate(
      async (settings) => window.configureViewers!(settings),
      {
        cdpUrl: backend.endpoint,
        windowA: first.windowId,
        windowB: second.windowId,
        interactive: true,
        windowSizeSync: "live" as const,
      },
    );
    const a = page.locator("#viewer-a .cdpv-root"),
      b = page.locator("#viewer-b .cdpv-root");
    await expect(a).toHaveAttribute("data-status", "streaming");
    await expect(b).toHaveAttribute("data-status", "streaming");
    await expect
      .poll(() =>
        first.remote.evaluate(() => ({
          width: innerWidth,
          dpr: devicePixelRatio,
        })),
      )
      .toEqual({ width: 458, dpr: 2 });
    await expect
      .poll(() =>
        second.remote.evaluate(() => ({
          width: innerWidth,
          dpr: devicePixelRatio,
        })),
      )
      .toEqual({ width: 558, dpr: 2 });
    await a.evaluate((element: HTMLElement) => {
      element.style.width = "500px";
    });
    await expect.poll(() => first.remote.evaluate(() => innerWidth)).toBe(498);
    expect(await second.remote.evaluate(() => innerWidth)).toBe(558);
    await page.evaluate(() => window.removeFirstViewer!());
    await expect
      .poll(() => first.remote.evaluate(() => devicePixelRatio))
      .toBe(1);
    await expect(b).toHaveAttribute("data-status", "streaming");
    await second.remote.evaluate(() => {
      document.body.style.background = "rgb(232,32,48)";
    });
    await expect
      .poll(() =>
        b
          .locator("canvas")
          .evaluate(
            (element: HTMLCanvasElement) =>
              element.getContext("2d")!.getImageData(10, 10, 1, 1).data[0],
          ),
      )
      .toBeGreaterThan(220);
    expect(
      await second.remote.evaluate(() => ({
        width: innerWidth,
        dpr: devicePixelRatio,
      })),
    ).toEqual({ width: 558, dpr: 2 });
    for (const window of windows) await window.cdp.detach();
  } finally {
    await backend.close();
  }
});
