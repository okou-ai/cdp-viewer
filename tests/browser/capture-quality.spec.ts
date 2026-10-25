import { expect, test } from "@playwright/test";
import { launchBackend, serveBrowserConsumer } from "./backend";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

for (const [transport, colorScheme] of [
  ["shared", "light"],
  ["split", "dark"],
] as const) {
  test(`capture quality keeps native controls, host forms and remote geometry independent (${transport})`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    try {
      const created = backend.context.waitForEvent("page");
      const target = await backend.session.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      const remote = await created;
      await remote.setViewportSize({ width: 1920, height: 1080 });
      await remote.goto(server.origin + "/fixture/editor");
      const { windowId } = await backend.session.send(
        "Browser.getWindowForTarget",
        { targetId: target.targetId },
      );
      const originalGeometry = await remote.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }));
      const captures: Record<string, unknown>[] = [];
      let sockets = 0;
      let remoteWrites = 0;
      await page.routeWebSocket(backend.endpoint, (socket) => {
        sockets++;
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as {
            method: string;
            params?: Record<string, unknown>;
          };
          if (command.method === "Page.startScreencast")
            captures.push(command.params ?? {});
          if (
            command.method.startsWith("Input.") ||
            command.method.startsWith("Emulation.") ||
            command.method === "Browser.setContentsSize"
          )
            remoteWrites++;
          upstream.send(message);
        });
      });
      await page.goto(server.origin);
      await page.addStyleTag({
        content:
          "#panels { display:block !important } #viewer-a .cdpv-root { width:700px;height:500px }",
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
          transport,
          colorSchemeA: colorScheme,
          hostForm: true,
        },
      );
      const view = page.locator("#viewer-a .cdpv-root");
      await expect(view).toHaveAttribute("data-status", "streaming");
      const input = await view
        .getByLabel("Remote browser input")
        .elementHandle();
      const originalWrites = remoteWrites;
      const originalSockets = sockets;
      const menu = view.getByRole("button", { name: "Browser menu" });
      await menu.click();
      const detailTrigger = view.getByRole("menuitem", {
        name: "Capture quality",
      });
      await detailTrigger.focus();
      await page.keyboard.press("Enter");
      const detail = view.getByRole("dialog", { name: "Capture quality" });
      await expect(detail).toBeVisible();
      const quality = detail.getByRole("slider", { name: "JPEG quality" });
      const resolution = detail.getByRole("combobox", {
        name: "Capture resolution maximum",
      });
      await expect(quality).toBeFocused();
      await expect(quality).toHaveValue("70");
      await page.keyboard.press("ArrowRight");
      await expect(quality).toHaveValue("71");
      await expect(quality).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(resolution).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(resolution).toHaveValue("960x540");
      await expect(resolution).toBeFocused();
      await resolution.selectOption("1280x720");
      await expect
        .poll(() => captures.at(-1))
        .toMatchObject({ quality: 71, maxWidth: 1280, maxHeight: 720 });
      await expect(view).toHaveAttribute("data-status", "streaming");
      await expect
        .poll(() =>
          remote.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
          })),
        )
        .toEqual(originalGeometry);
      expect(remoteWrites).toBe(originalWrites);
      expect(sockets).toBe(originalSockets);
      expect(
        await input?.evaluate(
          (element) => element === document.querySelector("#viewer-a textarea"),
        ),
      ).toBe(true);
      await expect(page.locator("#host-submissions")).toHaveText("0");
      await view.screenshot({
        path: info.outputPath(`capture-quality-${colorScheme}.png`),
      });
      await page.keyboard.press("Escape");
      await expect(detail).toHaveCount(0);
      await expect(detailTrigger).toBeFocused();
      await expect(
        view.getByRole("menu", { name: "Browser menu", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();
      await page.getByRole("button", { name: "Host submit" }).click();
      await expect(page.locator("#host-submissions")).toHaveText("1");
    } finally {
      await backend.close();
    }
  });
}
