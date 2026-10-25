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
  ["shared", "initial late metadata"],
  ["shared", "initial bounds change"],
  ["split", "before"],
  ["split", "during"],
  ["split", "late metadata"],
  ["split", "initial late metadata"],
  ["split", "initial bounds change"],
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
      const initial = timing.startsWith("initial");
      const boundsChange = timing === "initial bounds change";
      if (initial) {
        const emulation = await backend.context.newCDPSession(remote);
        await emulation.send("Emulation.setDeviceMetricsOverride", {
          width: 900,
          height: 600,
          deviceScaleFactor: 2,
          scale: 1,
          dontSetVisibleSize: true,
          mobile: false,
        });
      }
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
      let windowReadsToHold = 0;
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
          if (
            windowReadsToHold > 0 &&
            command.method === "Browser.getWindowForTarget" &&
            command.params?.targetId === targetId &&
            --windowReadsToHold === 0
          ) {
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
        // Native window reassociation must preserve its full-raster assertions.
        captureA: { maxWidth: 4096, maxHeight: 2025 },
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
          .getByRole("menuitem", { name: "Fit page to viewer", exact: true })
          .click();
      };
      const finishSync = async () => {
        await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
        await expect(view.getByRole("alert")).toHaveCount(0);
      };
      if (!initial) {
        await requestSync();
        await finishSync();
      }
      expect(writes).toHaveLength(initial ? 0 : 1);
      const firstWindow = writes[0];
      const beforeMove = { frames: frames.length, resizes };
      if (timing.includes("late metadata")) {
        delayMetadata = true;
        holdRebindEffect = true;
      }
      if (timing === "during") {
        windowReadsToHold = 1;
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
        if (boundsChange) windowReadsToHold = 2;
        await requestSync();
        if (boundsChange) {
          // This second window command follows accepted causal native capture.
          // Resize that same window before its confirmation, holding metadata.
          await expect.poll(() => releaseWindow !== null).toBe(true);
          delayMetadata = true;
          holdRebindEffect = true;
          const framesBeforeResize = frames.length;
          await backend.session.send("Browser.setContentsSize", {
            windowId,
            width: 1400,
            height: 1000,
          });
          await expect
            .poll(() =>
              frames
                .slice(framesBeforeResize)
                .some((frame) => frame.width > 1300),
            )
            .toBe(true);
          expect(resizes).toBe(beforeMove.resizes);
          releaseWindow!();
          releaseWindow = null;
        }
        if (timing.includes("late metadata") || boundsChange) {
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
      if (timing.includes("late metadata") || boundsChange)
        expect(firstEffect).toBe("Page.stopScreencast");
      expect(writes).toEqual(initial ? [windowId] : [firstWindow, windowId]);
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
