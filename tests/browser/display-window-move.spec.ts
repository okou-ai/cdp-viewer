import { expect, test } from "@playwright/test";
import { launchNativeBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.use({ deviceScaleFactor: 1 });
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

for (const [transport, timing] of [
  ["shared", "before"],
  ["shared", "during"],
  ["shared", "late metadata"],
  ["split", "before"],
  ["split", "during"],
  ["split", "late metadata"],
] as const) {
  test(`synchronizes an emulated page after a native window move without a resize event (${transport}, ${timing} preparation)`, async ({
    page,
  }) => {
    const backend = await launchNativeBackend(server.origin, true, 1.25);
    try {
      const opened = backend.context.waitForEvent("page");
      const { targetId } = await backend.session.send("Target.createTarget", {
        url: server.origin + "/fixture/red",
        newWindow: true,
      });
      const remote = await opened;
      await remote.waitForLoadState();
      await remote.evaluate(() => {
        document.title = "Owned source";
        (window as unknown as { hits: number }).hits = 0;
        document.addEventListener("click", () => {
          (window as unknown as { hits: number }).hits++;
        });
      });
      const destinationOpened = backend.context.waitForEvent("page");
      const destination = await backend.session.send("Target.createTarget", {
        url: server.origin + "/fixture/blue",
        newWindow: true,
      });
      await destinationOpened;
      const { windowId } = await backend.session.send(
        "Browser.getWindowForTarget",
        { targetId: destination.targetId },
      );
      await backend.session.send("Browser.setContentsSize", {
        windowId,
        width: 1230,
        height: 850,
      });
      const frames: { width: number; height: number }[] = [];
      const writes: number[] = [];
      let resizes = 0;
      let holdWindow = false;
      let releaseWindow: (() => void) | null = null;
      let delayMetadata = false;
      const delayedMetadata: (() => void)[] = [];
      let holdRebindEffect = false;
      let releaseEffect: (() => void) | null = null;
      let firstEffect: string | null = null;
      await page.routeWebSocket(backend.endpoint, (socket) => {
        const attaching = new Map<number, string>();
        const sessions = new Set<string>();
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message));
          if (command.method === "Target.attachToTarget")
            attaching.set(command.id, command.params.targetId);
          if (command.method === "Browser.setContentsSize")
            writes.push(command.params.windowId);
          if (
            holdRebindEffect &&
            sessions.has(command.sessionId) &&
            (command.method === "Page.stopScreencast" ||
              command.method === "Emulation.setDeviceMetricsOverride")
          ) {
            holdRebindEffect = false;
            firstEffect = command.method;
            releaseEffect = () => upstream.send(message);
            return;
          }
          if (holdWindow && command.method === "Browser.getWindowForTarget") {
            holdWindow = false;
            releaseWindow = () => upstream.send(message);
            return;
          }
          upstream.send(message);
        });
        upstream.onMessage((message) => {
          const event = JSON.parse(String(message));
          if (attaching.get(event.id) === targetId && event.result?.sessionId)
            sessions.add(event.result.sessionId);
          if (sessions.has(event.sessionId)) {
            if (event.method === "Page.frameResized") resizes++;
            if (event.method === "Page.screencastFrame") {
              frames.push({
                width: event.params.metadata.deviceWidth,
                height: event.params.metadata.deviceHeight,
              });
              if (frames.length > 64) frames.shift();
              if (delayMetadata) {
                delayedMetadata.push(() => socket.send(message));
                if (delayedMetadata.length > 64)
                  throw new Error("Owned delayed frame bound exceeded.");
                return;
              }
            }
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
      await page.evaluate((settings) => window.configureViewers!(settings), {
        cdpUrl: backend.endpoint,
        second: false,
        interactive: true,
        transport,
      });
      const view = page.locator("#viewer-a .cdpv-root");
      await view.locator(`[data-target-id="${targetId}"]`).click();
      await expect(view).toHaveAttribute("data-status", "streaming");
      const input = await view
        .getByLabel("Remote browser input")
        .elementHandle();
      const requestSync = async () => {
        await view.getByRole("button", { name: "Browser menu" }).click();
        await view
          .getByRole("menuitem", { name: "Sync now", exact: true })
          .click();
      };
      const finishSync = async () => {
        await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
        await expect(view.getByRole("alert")).toHaveCount(0);
      };
      await requestSync();
      await finishSync();
      expect(writes).toHaveLength(1);
      const firstWindow = writes[0];
      const beforeMove = { frames: frames.length, resizes };
      if (timing === "late metadata") {
        delayMetadata = true;
        holdRebindEffect = true;
      }
      if (timing === "during") {
        holdWindow = true;
        await requestSync();
        await expect.poll(() => releaseWindow !== null).toBe(true);
      }
      const worker =
        backend.context.serviceWorkers()[0] ??
        (await backend.context.waitForEvent("serviceworker"));
      await worker.evaluate(
        async ({ url, windowId }) => {
          const tabs = (
            globalThis as unknown as {
              chrome: {
                tabs: {
                  query(options: { url: string }): Promise<{ id: number }[]>;
                  move(
                    id: number,
                    options: { windowId: number; index: number },
                  ): Promise<unknown>;
                  update(
                    id: number,
                    options: { active: boolean },
                  ): Promise<unknown>;
                };
              };
            }
          ).chrome.tabs;
          const [tab] = await tabs.query({ url });
          if (!tab) throw new Error("The owned source tab is unavailable.");
          await tabs.move(tab.id, { windowId, index: -1 });
          await tabs.update(tab.id, { active: true });
        },
        { url: server.origin + "/fixture/red", windowId },
      );
      await expect
        .poll(() =>
          frames.slice(beforeMove.frames).some((frame) => frame.width > 1100),
        )
        .toBe(true);
      expect(
        (
          await backend.session.send("Browser.getWindowForTarget", {
            targetId,
          })
        ).windowId,
      ).toBe(windowId);
      // Existing emulation keeps page layout stable during the native move.
      expect(resizes).toBe(beforeMove.resizes);
      if (timing === "during") {
        releaseWindow!();
        releaseWindow = null;
      } else {
        await requestSync();
        if (timing === "late metadata") {
          // The first outgoing effect proves preparation consumed the new-window
          // reply. A frame held on the other transport cannot arrive before it.
          await expect.poll(() => releaseEffect !== null).toBe(true);
          delayMetadata = false;
          for (const deliver of delayedMetadata.splice(0)) deliver();
          releaseEffect!();
          releaseEffect = null;
        }
      }
      await finishSync();
      if (timing === "late metadata")
        expect(firstEffect).toBe("Page.stopScreencast");
      expect(writes).toEqual([firstWindow, windowId]);
      await expect(view.getByRole("tab", { selected: true })).toHaveAttribute(
        "data-target-id",
        targetId,
      );
      expect(await input!.evaluate((element) => element.isConnected)).toBe(
        true,
      );
      expect(await remote.evaluate(() => innerWidth)).toBe(1098);
      const canvas = view.locator("canvas");
      const raster = await canvas.evaluate((element: HTMLCanvasElement) => ({
        width: element.width,
        height: element.height,
      }));
      const frame = frames.at(-1)!;
      expect(raster).toEqual({
        width: Math.round(frame.width * 1.25),
        height: Math.round(frame.height * 1.25),
      });
      await canvas.click();
      await expect.poll(() => remote.evaluate("window.hits")).toBe(1);
      await test.info().attach("native-window-move", {
        body: JSON.stringify({
          transport,
          timing,
          firstEffect,
          writes,
          beforeMove,
          resizes,
          frames,
          raster,
        }),
        contentType: "application/json",
      });
    } finally {
      await backend.close();
    }
  });
}
