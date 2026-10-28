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
      await page.clock.install();
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
      const detail = view.getByRole("dialog", { name: "Capture quality" });
      const mainMenu = view.getByRole("menu", {
        name: "Browser menu",
        exact: true,
      });
      const transportTrigger = view.getByRole("menuitem", {
        name: "Transport",
        exact: true,
      });
      await expect(mainMenu).toBeFocused();
      await expect(mainMenu.locator("[data-highlighted]")).toHaveCount(0);
      await expect(detailTrigger).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(detail).toHaveCount(0);
      await page.keyboard.press("ArrowDown");
      await expect(transportTrigger).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(detailTrigger).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(detail).toBeVisible();
      await expect(
        detail.getByRole("slider", { name: "JPEG quality" }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(detailTrigger).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(mainMenu).toHaveCount(0);
      await expect(menu).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(transportTrigger).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(detailTrigger).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();
      await menu.click();
      await expect(mainMenu).toBeFocused();
      await expect(mainMenu.locator("[data-highlighted]")).toHaveCount(0);
      await detailTrigger.hover();
      await expect(detail).toBeVisible();
      const quality = detail.getByRole("slider", { name: "JPEG quality" });
      await expect(quality).not.toBeFocused();
      await expect(quality).toHaveValue("70");
      await quality.hover();
      await expect(detail).toBeVisible();
      const initialCapture = captures.at(-1);
      await detail.getByRole("radio", { name: "1280 × 720" }).click();
      await expect
        .poll(() => captures.at(-1))
        .toMatchObject({
          maxWidth: 1280,
          maxHeight: 720,
        });
      await detail.getByRole("radio", { name: "Auto" }).click();
      await expect.poll(() => captures.at(-1)).toEqual(initialCapture);
      await menu.hover();
      await expect(detail).toHaveCount(0);
      await detailTrigger.hover();
      await expect(detail).toBeVisible();
      await view
        .getByRole("menuitem", { name: "Transport", exact: true })
        .hover();
      await expect(detail).toHaveCount(0);
      const transportMenu = view.getByRole("menu", {
        name: "Transport",
        exact: true,
      });
      await expect(transportMenu).toBeVisible();
      // Move the real pointer out of the submenu's safe polygon before hit testing.
      const triggerBox = (await detailTrigger.boundingBox())!;
      await page.mouse.move(
        triggerBox.x + triggerBox.width / 2,
        triggerBox.y + triggerBox.height / 2,
        { steps: 5 },
      );
      await expect(detail).toBeVisible();
      await expect(transportMenu).toHaveCount(0);
      // Advance the dependency's hover timers after Escape without moving the pointer.
      await page.keyboard.press("Escape");
      await expect(detail).toHaveCount(0);
      await page.clock.runFor(500);
      await expect(detail).toHaveCount(0);
      await expect(detailTrigger).toBeFocused();
      await detailTrigger.click();
      await expect(detail).toBeVisible();
      await expect(quality).toBeFocused();
      await page.keyboard.press("Escape");
      await detailTrigger.focus();
      await page.keyboard.press("Enter");
      await expect(detail).toBeVisible();
      const resolution = detail.getByRole("radiogroup", {
        name: "Capture resolution maximum",
      });
      const automatic = resolution.getByRole("radio", { name: "Auto" });
      const firstPreset = resolution.getByRole("radio", { name: "960 × 540" });
      const selectedPreset = resolution.getByRole("radio", {
        name: "1280 × 720",
      });
      await expect(resolution.getByRole("radio")).toHaveCount(6);
      await expect(detail.getByRole("combobox")).toHaveCount(0);
      for (const option of await resolution.getByRole("radio").all())
        await expect(option).toBeVisible();
      await expect(automatic).toBeChecked();
      await expect(quality).toBeFocused();
      await expect(quality).toHaveValue("70");
      await page.keyboard.press("ArrowRight");
      await expect(quality).toHaveValue("71");
      await expect(quality).toBeFocused();
      await expect.poll(() => captures.at(-1)).toMatchObject({ quality: 71 });
      const automaticCapture = captures.at(-1)!;
      await quality.press("Enter");
      await expect(page.locator("#host-submissions")).toHaveText("0");
      await expect(quality).toBeFocused();
      await expect(quality).toHaveValue("71");
      await page.keyboard.press("Tab");
      await expect(automatic).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(firstPreset).toBeChecked();
      await expect(firstPreset).toBeFocused();
      await selectedPreset.click();
      await expect(selectedPreset).toBeChecked();
      await expect(
        resolution.getByRole("radio", { checked: true }),
      ).toHaveCount(1);
      await expect(selectedPreset.locator("svg")).toBeVisible();
      await expect(automatic.locator("svg")).toHaveCount(0);
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
      await automatic.click();
      await expect(automatic).toBeChecked();
      await expect.poll(() => captures.at(-1)).toEqual(automaticCapture);
      await page.addStyleTag({
        content: "#viewer-a .cdpv-root { width:320px;height:420px }",
      });
      await expect
        .poll(async () => {
          const root = (await view.boundingBox())!;
          const popup = (await detail.boundingBox())!;
          return (
            popup.x >= root.x &&
            popup.y >= root.y &&
            popup.x + popup.width <= root.x + root.width &&
            popup.y + popup.height <= root.y + root.height
          );
        })
        .toBe(true);
      const lastPreset = resolution.getByRole("radio", { name: "3840 × 2160" });
      await lastPreset.click();
      await expect(lastPreset).toBeChecked();
      await automatic.click();
      await expect(automatic).toBeChecked();
      expect(remoteWrites).toBe(originalWrites);
      expect(sockets).toBe(originalSockets);
      await page.keyboard.press("Escape");
      await expect(detail).toHaveCount(0);
      await expect(detailTrigger).toBeFocused();
      await expect(
        view.getByRole("menu", { name: "Browser menu", exact: true }),
      ).toBeVisible();
      const fit = view.getByRole("menuitem", { name: "Fit to this viewer" });
      await fit.hover();
      await expect(
        view.getByRole("menu", { name: "Fit to this viewer", exact: true }),
      ).toBeVisible();
      await view
        .getByRole("menuitemradio", { name: "Do not sync automatically" })
        .click();
      await expect(menu).toBeFocused();
      await menu.click();
      const rootMenu = view.getByRole("menu", {
        name: "Browser menu",
        exact: true,
      });
      await expect
        .poll(() =>
          rootMenu.evaluate((element) =>
            element.contains(element.ownerDocument.activeElement),
          ),
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();
      await page.getByRole("button", { name: "Host submit" }).click();
      await expect(page.locator("#host-submissions")).toHaveText("1");
    } finally {
      await backend.close();
    }
  });
}

test.describe("touch capture quality", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  test("opens and edits without submitting the host form", async ({
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
      await remote.goto(server.origin + "/fixture/editor");
      const { windowId } = await backend.session.send(
        "Browser.getWindowForTarget",
        {
          targetId: target.targetId,
        },
      );
      await page.goto(server.origin);
      await page.addStyleTag({
        content:
          "#panels { display:block !important } #viewer-a .cdpv-root { width:320px;height:500px }",
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
      await view.getByRole("button", { name: "Browser menu" }).tap();
      await view.getByRole("menuitem", { name: "Capture quality" }).tap();
      const detail = view.getByRole("dialog", { name: "Capture quality" });
      await expect(detail).toBeVisible();
      const quality = detail.getByRole("slider", { name: "JPEG quality" });
      await expect(quality).toHaveValue("70");
      await quality.tap();
      await expect(quality).not.toHaveValue("70");
      await detail.getByRole("radio", { name: "1280 × 720" }).tap();
      await expect(
        detail.getByRole("radio", { name: "1280 × 720" }),
      ).toBeChecked();
      await detail.getByRole("radio", { name: "Auto" }).tap();
      await expect(detail.getByRole("radio", { name: "Auto" })).toBeChecked();
      await expect(page.locator("#host-submissions")).toHaveText("0");
      await page.getByRole("button", { name: "Host submit" }).tap();
      await expect(detail).toHaveCount(0);
      await expect(page.locator("#host-submissions")).toHaveText("1");
    } finally {
      await backend.close();
    }
  });
});
