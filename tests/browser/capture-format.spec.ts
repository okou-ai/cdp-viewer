import { expect, test } from "@playwright/test";
import { launchBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

for (const transport of ["shared", "split"] as const) {
  test(`renders real WebP and JPEG and preserves click feedback across ${transport} format changes`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    try {
      const created = backend.context.waitForEvent("page");
      const target = await backend.session.send("Target.createTarget", {
        url: server.origin + "/fixture/red",
        newWindow: true,
      });
      const remote = await created;
      await remote.setViewportSize({ width: 800, height: 600 });
      await remote.waitForURL(server.origin + "/fixture/red");
      await remote.waitForLoadState();
      await remote.evaluate(() => {
        document.body.innerHTML =
          '<button id="toggle" style="position:absolute;left:100px;top:100px;width:160px;height:60px">Toggle color</button><output id="clicks">0</output>';
        document.querySelector("#toggle")!.addEventListener("click", () => {
          const output = document.querySelector("#clicks")!;
          const clicks = Number(output.textContent) + 1;
          output.textContent = String(clicks);
          document.body.style.background =
            clicks % 2 ? "rgb(24,224,80)" : "rgb(232,32,48)";
        });
      });
      const { windowId } = await backend.session.send(
        "Browser.getWindowForTarget",
        { targetId: target.targetId },
      );
      let sockets = 0;
      let lastFrameFormat = "";
      const captures: { sessionId?: string; format?: string }[] = [];
      await page.routeWebSocket(backend.endpoint, (socket) => {
        sockets++;
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as {
            method: string;
            sessionId?: string;
            params?: { format?: string };
          };
          if (command.method === "Page.startScreencast")
            captures.push({
              ...command.params,
              ...(command.sessionId ? { sessionId: command.sessionId } : {}),
            });
          upstream.send(message);
        });
        upstream.onMessage((message) => {
          const event = JSON.parse(String(message)) as {
            method?: string;
            params?: { data?: string };
          };
          if (event.method === "Page.screencastFrame" && event.params?.data) {
            const bytes = Buffer.from(event.params.data, "base64");
            lastFrameFormat =
              bytes[0] === 0xff && bytes[1] === 0xd8
                ? "jpeg"
                : bytes.toString("ascii", 0, 4) === "RIFF" &&
                    bytes.toString("ascii", 8, 12) === "WEBP"
                  ? "webp"
                  : "other";
          }
          socket.send(message);
        });
      });
      await page.goto(server.origin);
      await page.waitForFunction(
        () => typeof window.configureViewers === "function",
      );
      await page.evaluate((settings) => window.configureViewers!(settings), {
        cdpUrl: backend.endpoint,
        windowA: windowId,
        second: false,
        interactive: true,
        transport,
      });
      const view = page.locator("#viewer-a .cdpv-root");
      const canvas = view.locator("canvas");
      await expect(view).toHaveAttribute("data-status", "streaming");
      await expect.poll(() => lastFrameFormat).toBe("webp");
      expect(captures).toHaveLength(1);
      expect(captures[0]!.format).toBe("webp");
      const input = await view
        .getByLabel("Remote browser input")
        .elementHandle();
      const originalSockets = sockets;
      const captureSession = captures[0]!.sessionId;

      for (const [format, label, clicks, color] of [
        ["jpeg", "JPEG", 1, [24, 224, 80]],
        ["webp", "WebP", 2, [232, 32, 48]],
      ] as const) {
        await view.getByRole("button", { name: "Browser menu" }).click();
        await view.getByRole("menuitem", { name: "Capture quality" }).click();
        const detail = view.getByRole("dialog", { name: "Capture quality" });
        await detail.getByRole("radio", { name: label, exact: true }).click();
        await expect.poll(() => captures.at(-1)?.format).toBe(format);
        await expect.poll(() => lastFrameFormat).toBe(format);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        const viewport = await remote.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }));
        const point = await canvas.evaluate(
          (element: HTMLCanvasElement, viewport) => {
            const rect = element.getBoundingClientRect();
            const scale = Math.min(
              rect.width / element.width,
              rect.height / element.height,
            );
            const width = element.width * scale,
              height = element.height * scale;
            return {
              x:
                rect.left +
                (rect.width - width) / 2 +
                (180 / viewport.width) * width,
              y:
                rect.top +
                (rect.height - height) / 2 +
                (130 / viewport.height) * height,
            };
          },
          viewport,
        );
        await page.mouse.click(point.x, point.y);
        await expect(remote.locator("#clicks")).toHaveText(String(clicks));
        await expect
          .poll(() =>
            canvas.evaluate((element: HTMLCanvasElement, expected) => {
              const pixel = element
                .getContext("2d")!
                .getImageData(0, 0, 1, 1).data;
              return Math.max(
                ...expected.map((value, i) => Math.abs(pixel[i]! - value)),
              );
            }, color),
          )
          .toBeLessThanOrEqual(4);
        expect(sockets).toBe(originalSockets);
        expect(captures.at(-1)!.sessionId).toBe(captureSession);
        expect(
          await input!.evaluate(
            (element) =>
              element === document.querySelector("#viewer-a textarea"),
          ),
        ).toBe(true);
        await expect(view.getByLabel("Remote browser input")).toBeEnabled();
      }
    } finally {
      await backend.close();
    }
  });
}
