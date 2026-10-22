import { expect, test } from "@playwright/test";
import { launchNativeBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());
test.use({ deviceScaleFactor: 2 });

for (const stage of ["upgrade", "refresh"] as const) {
  for (const method of [
    "Page.stopScreencast",
    "Page.startScreencast",
  ] as const) {
    test(`retains preview and retry when ${stage} loses an applied ${method} acknowledgement`, async ({
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
          '<style>html,body{margin:0;background:rgb(232,32,48)}</style><input id="plain">',
        );
        const { windowId } = await backend.session.send(
          "Browser.getWindowForTarget",
          {
            targetId: target.targetId,
          },
        );
        let fault = false;
        let heldId: number | undefined;
        const replies: (() => void)[] = [];
        let attachments = 0;
        await page.routeWebSocket(backend.endpoint, (socket) => {
          const upstream = socket.connectToServer();
          socket.onMessage((message) => {
            const command = JSON.parse(String(message)) as {
              id: number;
              method: string;
            };
            if (command.method === "Target.attachToTarget") attachments++;
            if (fault && command.method === method && heldId === undefined)
              heldId = command.id;
            upstream.send(message);
          });
          upstream.onMessage((message) => {
            const response = JSON.parse(String(message)) as { id?: number };
            if (heldId !== undefined && response.id === heldId)
              replies.push(() => socket.send(message));
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
          },
        );
        const view = page.locator("#viewer-a .cdpv-root"),
          canvas = view.locator("canvas"),
          proxy = await view
            .getByRole("textbox", { name: "Remote browser input" })
            .elementHandle();
        await expect(view).toHaveAttribute("data-status", "streaming");
        const sync = async () => {
          await view.getByRole("button", { name: "Browser menu" }).click();
          await view
            .getByRole("menuitem", { name: "Sync now", exact: true })
            .click();
        };
        if (stage === "refresh") {
          await sync();
          await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
          const local = await page.context().newCDPSession(page);
          await local.send("Emulation.setDeviceMetricsOverride", {
            width: 1280,
            height: 900,
            deviceScaleFactor: 4,
            mobile: false,
          });
          await view.evaluate((element: HTMLElement) => {
            element.style.width = "311px";
            element.style.height = "275px";
          });
        }
        fault = true;
        await sync();
        await expect.poll(() => replies.length).toBe(1);
        // Only a reply is held: native commands/effects and frame events continue.
        // Let the library's existing request deadline trigger bounded restoration.
        await page.waitForFunction(() =>
          document
            .querySelector("#viewer-a .cdpv-error-current")
            ?.textContent?.includes("could not be synchronized"),
        );
        await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
        await expect(view).toHaveAttribute("data-status", "streaming");
        await remote.evaluate(() => {
          document.body.style.background = "rgb(24,80,224)";
        });
        await expect
          .poll(() =>
            canvas.evaluate((element: HTMLCanvasElement) => {
              const pixel = element
                .getContext("2d")!
                .getImageData(element.width - 2, element.height - 2, 1, 1).data;
              return Math.max(
                Math.abs(pixel[0]! - 24),
                Math.abs(pixel[1]! - 80),
                Math.abs(pixel[2]! - 224),
              );
            }),
          )
          .toBeLessThanOrEqual(5);
        replies.shift()!();
        // The restored native image can be letterboxed. Acquire keyboard focus
        // directly instead of treating a point in its empty margin as an image click.
        await view
          .getByRole("textbox", { name: "Remote browser input" })
          .focus();
        await remote.locator("#plain").focus();
        await page.keyboard.insertText("capture recovered");
        await expect(remote.locator("#plain")).toHaveValue("capture recovered");
        await sync();
        await expect(view.locator(".cdpv-spinning")).toHaveCount(0);
        const box = await canvas.boundingBox();
        if (!box) throw new Error("Owned viewer has no geometry.");
        const dpr = stage === "refresh" ? 4 : 2;
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
            dpr,
          });
        await expect
          .poll(() =>
            canvas.evaluate((element: HTMLCanvasElement) => ({
              width: element.width,
              height: element.height,
            })),
          )
          .toEqual({
            width: Math.floor(box.width) * dpr,
            height: Math.floor(box.height) * dpr,
          });
        expect(attachments).toBe(1);
        expect(await proxy?.evaluate((element) => element.isConnected)).toBe(
          true,
        );
      } finally {
        await backend.close();
      }
    });
  }
}
