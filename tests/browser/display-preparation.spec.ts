import { expect, test } from "@playwright/test";
import { launchNativeBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

interface ZoomTabs {
  query(query: { url: string }): Promise<{ id: number }[]>;
  setZoom(id: number, zoom: number): Promise<void>;
  getZoom(id: number): Promise<number>;
}
interface PointerObservation {
  hits: number;
  ups: number;
  pointer: { x: number; y: number; target: string } | null;
}

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());
test.use({ deviceScaleFactor: 2 });

for (const boundary of [
  "Page.getLayoutMetrics",
  "Page.stopScreencast",
] as const) {
  test(`reprepares invalidated native units while awaiting ${boundary}`, async ({
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
        '<style>html,body{margin:0;background:white}button{position:fixed;left:180px;top:120px;width:80px;height:40px;background:rgb(232,32,48)}</style><button id="control">Control</button><script>window.hits=0;window.ups=0;window.lastPointer=null;document.querySelector("button").onclick=()=>window.hits++;document.onpointerup=()=>window.ups++;document.onpointerdown=e=>window.lastPointer={x:e.clientX,y:e.clientY,target:e.target.id};</script>',
      );
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
      expect(await changeZoom(1.25)).toBeCloseTo(1.25, 6);
      await expect
        .poll(() => remote.evaluate(() => devicePixelRatio))
        .toBeCloseTo(1.25, 6);
      let hold = false;
      let heldId: number | undefined;
      let deliver: (() => void) | undefined;
      let resized = 0;
      let attachments = 0;
      await page.routeWebSocket(backend.endpoint, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as {
            id: number;
            method: string;
          };
          if (command.method === "Target.attachToTarget") attachments++;
          if (hold && command.method === boundary && heldId === undefined)
            heldId = command.id;
          upstream.send(message);
        });
        upstream.onMessage((message) => {
          const response = JSON.parse(String(message)) as {
            id?: number;
            method?: string;
          };
          if (response.method === "Page.frameResized") resized++;
          if (heldId !== undefined && response.id === heldId)
            deliver = () => socket.send(message);
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
          captureA: { maxWidth: 4096, maxHeight: 2025 },
        },
      );
      const view = page.locator("#viewer-a .cdpv-root"),
        canvas = view.locator("canvas");
      await expect(view).toHaveAttribute("data-status", "streaming");
      hold = true;
      await view.getByRole("button", { name: "Browser menu" }).click();
      await view
        .getByRole("menuitem", { name: "Fit page to viewer", exact: true })
        .click();
      await expect.poll(() => !!deliver).toBe(true);
      const before = resized;
      expect(await changeZoom(0.8)).toBeCloseTo(0.8, 6);
      await expect.poll(() => resized).toBeGreaterThan(before);
      await expect
        .poll(() => remote.evaluate(() => devicePixelRatio))
        .toBeCloseTo(0.8, 6);
      deliver!();
      await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
      const actual = await remote.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }));
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Owned viewer has no geometry.");
      const desired = {
        width: Math.floor(box.width),
        height: Math.floor(box.height),
      };
      const rect = await remote.locator("#control").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
          width: visualViewport!.width,
          height: visualViewport!.height,
        };
      });
      const point = await canvas.evaluate(
        (element: HTMLCanvasElement, rect) => {
          const bounds = element.getBoundingClientRect(),
            scale = Math.min(
              bounds.width / element.width,
              bounds.height / element.height,
            ),
            width = element.width * scale,
            height = element.height * scale;
          return {
            x:
              bounds.x +
              (bounds.width - width) / 2 +
              (rect.x / rect.width) * width,
            y:
              bounds.y +
              (bounds.height - height) / 2 +
              (rect.y / rect.height) * height,
          };
        },
        rect,
      );
      await page.mouse.click(point.x, point.y);
      await expect.poll(() => remote.evaluate("window.ups")).toBe(1);
      const pointer = await remote.evaluate<PointerObservation>(
        "({hits:window.hits,ups:window.ups,pointer:window.lastPointer})",
      );
      await test.info().attach("preparation-invalidation", {
        body: JSON.stringify({ boundary, desired, actual, pointer }),
        contentType: "application/json",
      });
      // Fractional native zoom uses integer emulation sizes; retain the same
      // one-CSS-pixel rounding contract as the existing native zoom regressions.
      expect(
        Math.max(
          Math.abs(actual.width - desired.width),
          Math.abs(actual.height - desired.height),
        ),
      ).toBeLessThanOrEqual(1);
      expect(actual.dpr).toBeCloseTo(2, 6);
      expect(pointer.hits).toBe(1);
      expect(attachments).toBe(1);
    } finally {
      await backend.close();
    }
  });
}

test("retains a held manual fit through mode-off and a zero-area surface", async ({
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
      '<style>html,body{margin:0;background:white}button{position:fixed;left:160px;top:100px;width:80px;height:40px}</style><button id="control">Control</button><script>window.hits=0;window.ups=0;document.querySelector("button").onclick=()=>window.hits++;document.onpointerup=()=>window.ups++;</script>',
    );
    const { windowId } = await backend.session.send(
      "Browser.getWindowForTarget",
      { targetId: target.targetId },
    );
    let hold = false;
    let heldId: number | undefined;
    let deliver: (() => void) | undefined;
    let writes = 0;
    let attachments = 0;
    let starts = 0;
    let stops = 0;
    let captureFences = 0;
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as {
          id: number;
          method: string;
          params?: { expression?: string };
        };
        if (command.method === "Browser.setContentsSize") writes++;
        if (command.method === "Target.attachToTarget") attachments++;
        if (command.method === "Page.startScreencast") starts++;
        if (command.method === "Page.stopScreencast") stops++;
        if (
          command.method === "Runtime.evaluate" &&
          String(command.params?.expression).includes("Date.now()")
        )
          captureFences++;
        if (
          hold &&
          command.method === "Page.getLayoutMetrics" &&
          heldId === undefined
        )
          heldId = command.id;
        upstream.send(message);
      });
      upstream.onMessage((message) => {
        const response = JSON.parse(String(message)) as { id?: number };
        if (heldId !== undefined && response.id === heldId)
          deliver = () => socket.send(message);
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
    const configure = (windowSizeSync: "live" | "off") =>
      page.evaluate(async (settings) => window.configureViewers!(settings), {
        cdpUrl: backend.endpoint,
        windowA: windowId,
        second: false,
        interactive: true,
        windowSizeSync,
        captureA: { maxWidth: 4096, maxHeight: 2025 },
      });
    await configure("live");
    const view = page.locator("#viewer-a .cdpv-root");
    const canvas = view.locator("canvas");
    await expect(view).toHaveAttribute("data-status", "streaming");
    await expect
      .poll(() =>
        remote.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        })),
      )
      .toEqual({ width: 618, height: 370, dpr: 2 });
    await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
    const proxy = await view
      .getByRole("textbox", { name: "Remote browser input" })
      .elementHandle();
    if (!proxy) throw new Error("Owned viewer input is unavailable.");
    hold = true;
    await view.getByRole("button", { name: "Browser menu" }).click();
    await view
      .getByRole("menuitem", { name: "Fit page to viewer", exact: true })
      .click();
    await expect.poll(() => !!deliver).toBe(true);
    await canvas.evaluate((element: HTMLCanvasElement) => {
      element.style.width = "0px";
      element.style.height = "0px";
    });
    // An intersecting zero-area surface loses local geometry without retiring
    // the selected session through the separate offscreen pause contract.
    expect(
      await canvas.evaluate(
        (element) =>
          new Promise<boolean>((resolve) => {
            const observer = new IntersectionObserver((entries) => {
              const entry = entries.at(-1);
              if (!entry) return;
              observer.disconnect();
              resolve(entry.isIntersecting);
            });
            observer.observe(element);
          }),
      ),
    ).toBe(true);
    await expect(view).toHaveAttribute("data-status", "streaming");
    await configure("off");
    deliver!();
    await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
    expect(writes).toBe(1);
    await view.evaluate((element: HTMLElement) => {
      element.style.width = "700px";
      element.style.height = "500px";
    });
    await canvas.evaluate((element: HTMLCanvasElement) => {
      element.style.width = "";
      element.style.height = "";
    });
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Owned viewer surface is unavailable.");
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
    await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
    await page.mouse.click(box.x + 200, box.y + 120);
    await expect.poll(() => remote.evaluate("window.ups")).toBe(1);
    expect(await remote.evaluate("window.hits")).toBe(1);
    expect(
      await view
        .getByRole("textbox", { name: "Remote browser input" })
        .evaluate((element, original) => element === original, proxy),
    ).toBe(true);
    expect(writes).toBe(2);
    expect(attachments).toBe(1);
    // Every additional capture belongs to bounded clipped-raster recovery on
    // the original attachment; a native resize does not imply one fixed start.
    expect(captureFences).toBeLessThanOrEqual(writes);
    expect(stops).toBe(captureFences);
    expect(starts).toBe(1 + captureFences);
    await proxy.dispose();
  } finally {
    await backend.close();
  }
});
