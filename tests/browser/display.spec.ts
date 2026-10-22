import { expect, test } from "@playwright/test";
import { launchBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

test.use({ deviceScaleFactor: 2 });

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
      await menu.click();
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
      await remoteCdp.detach();
      await localCdp.detach();
    } finally {
      await backend.close();
    }
  });
}

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
