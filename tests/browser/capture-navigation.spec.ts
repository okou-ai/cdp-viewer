import { expect, test } from "@playwright/test";
import { launchBackend, serveBrowserConsumer } from "./backend";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

for (const transport of ["shared", "split"] as const) {
  test(`${transport}: recovers one automatic capture rejected during document replacement`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    let rejectStart: (() => void) | undefined;
    try {
      const opened = backend.context.waitForEvent("page");
      const target = await backend.session.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      const remote = await opened;
      await remote.setViewportSize({ width: 1280, height: 720 });
      await remote.goto(server.origin + "/fixture/editor");
      const { windowId } = await backend.session.send(
        "Browser.getWindowForTarget",
        {
          targetId: target.targetId,
        },
      );
      let armed = false;
      let sockets = 0;
      let starts = 0;
      let rejections = 0;
      const commands: string[] = [];
      await page.routeWebSocket(backend.endpoint, (socket) => {
        sockets++;
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as {
            id: number;
            method: string;
            sessionId?: string;
          };
          commands.push(command.method);
          if (command.method === "Page.startScreencast") {
            starts++;
            if (armed) {
              armed = false;
              rejectStart = () => {
                rejections++;
                socket.send(
                  JSON.stringify({
                    id: command.id,
                    sessionId: command.sessionId,
                    error: {
                      code: -32000,
                      message: "Synthetic document replacement rejection.",
                    },
                  }),
                );
              };
              return;
            }
          }
          upstream.send(message);
        });
        upstream.onMessage((message) => socket.send(message));
      });
      await page.goto(server.origin);
      await page.addStyleTag({
        content: "#viewer-a .cdpv-root{width:640px;height:430px}",
      });
      await page.waitForFunction(
        () => typeof window.configureViewers === "function",
      );
      await page.evaluate((settings) => window.configureViewers!(settings), {
        cdpUrl: backend.endpoint,
        windowA: windowId,
        interactive: true,
        transport,
        second: false,
      });
      const view = page.locator("#viewer-a .cdpv-root");
      await expect(view).toHaveAttribute("data-status", "streaming");
      const proxy = await view
        .getByLabel("Remote browser input")
        .elementHandle();
      const initial = await view
        .locator("canvas")
        .evaluate((c: HTMLCanvasElement) => c.width);
      const initialStarts = starts;
      armed = true;
      await view.evaluate((e: HTMLElement) => {
        e.style.width = "480px";
      });
      await expect.poll(() => !!rejectStart).toBe(true);
      await view
        .getByLabel("Remote page address")
        .fill(server.origin + "/fixture/blue");
      await view.getByLabel("Remote page address").press("Enter");
      // The selected title proves the control connection observed replacement.
      // Inject the definite failure seen in CI at the held frame connection's
      // real request boundary; avoid depending on Chromium's tiny rejection window.
      await expect(
        view.getByRole("tab", { selected: true }),
      ).toHaveAccessibleName(/rgb\(24,80,224\)/);
      rejectStart!();
      rejectStart = undefined;
      await expect
        .poll(() =>
          view.locator("canvas").evaluate((c: HTMLCanvasElement) => {
            const pixel = c
              .getContext("2d")!
              .getImageData(c.width / 2, c.height / 2, 1, 1).data;
            return Math.max(
              ...[24, 80, 224].map((channel, i) =>
                Math.abs(pixel[i]! - channel),
              ),
            );
          }),
        )
        .toBeLessThanOrEqual(4);
      await expect(view).toHaveAttribute("data-status", "streaming");
      expect(
        await view
          .locator("canvas")
          .evaluate((c: HTMLCanvasElement) => c.width),
      ).toBeLessThan(initial);
      expect(starts).toBe(initialStarts + 2);
      expect(sockets).toBe(transport === "split" ? 2 : 1);
      expect(
        commands.filter((m) => m === "Target.attachToTarget"),
      ).toHaveLength(transport === "split" ? 2 : 1);
      expect(
        commands.some(
          (m) =>
            m.startsWith("Emulation.") ||
            m === "Target.detachFromTarget" ||
            m === "Browser.setContentsSize",
        ),
      ).toBe(false);
      expect(await proxy?.evaluate((e) => e.isConnected)).toBe(true);

      await remote.goto(server.origin + "/fixture/editor");
      // Keyboard input uses the same native node/session after capture recovery.
      await view.getByLabel("Remote browser input").focus();
      await remote.locator("#plain").focus();
      await page.keyboard.insertText("capture recovered");
      await expect(remote.locator("#plain")).toHaveValue("capture recovered");
      expect(rejections).toBe(1);
    } finally {
      await backend.close();
    }
  });
}
