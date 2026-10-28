import { expect, test } from "@playwright/test";
import type { WebSocket } from "@playwright/test";
import { launchNativeBackend, serveBrowserConsumer } from "./backend";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

for (const colorScheme of ["light", "dark"] as const) {
  test(`transport settings reconnect only their viewer and retain capture (${colorScheme})`, async ({
    page,
  }, info) => {
    const backend = await launchNativeBackend(server.origin, true, 1);
    try {
      const create = async () => {
        const opened = backend.context.waitForEvent("page");
        const { targetId } = await backend.session.send("Target.createTarget", {
          url: "about:blank",
          newWindow: true,
        });
        const remote = await opened;
        await remote.goto(server.origin + "/fixture/editor");
        const { windowId } = await backend.session.send(
          "Browser.getWindowForTarget",
          { targetId },
        );
        return { remote, targetId, windowId };
      };
      const a = await create(),
        b = await create();
      const sockets: {
        socket: WebSocket;
        targets: Set<string>;
        captures: Record<string, unknown>[];
      }[] = [];
      page.on("websocket", (socket) => {
        if (socket.url() !== backend.endpoint) return;
        const record = {
          socket,
          targets: new Set<string>(),
          captures: [] as Record<string, unknown>[],
        };
        sockets.push(record);
        socket.on("framesent", ({ payload }) => {
          const command = JSON.parse(String(payload)) as {
            method: string;
            params?: Record<string, unknown>;
          };
          if (
            command.method === "Target.attachToTarget" &&
            typeof command.params?.targetId === "string"
          )
            record.targets.add(command.params.targetId);
          if (command.method === "Page.startScreencast")
            record.captures.push(command.params ?? {});
        });
      });
      const active = (id: string) =>
        sockets.filter(
          (record) => record.targets.has(id) && !record.socket.isClosed(),
        );
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(server.origin);
      await page.addStyleTag({
        content: "#viewer-a .cdpv-root, #viewer-b .cdpv-root { height:500px }",
      });
      await page.waitForFunction(
        () => typeof window.configureViewers === "function",
      );
      await page.evaluate((settings) => window.configureViewers!(settings), {
        cdpUrl: backend.endpoint,
        windowA: a.windowId,
        windowB: b.windowId,
        interactive: true,
        hostForm: true,
        colorSchemeA: colorScheme,
      });
      const view = page.locator("#viewer-a .cdpv-root"),
        sibling = page.locator("#viewer-b .cdpv-root");
      await expect(view).toHaveAttribute("data-status", "streaming");
      await expect(sibling).toHaveAttribute("data-status", "streaming");
      await expect.poll(() => active(a.targetId).length).toBe(1);
      await expect.poll(() => active(b.targetId).length).toBe(1);
      const original = active(a.targetId)[0]!,
        independent = active(b.targetId)[0]!;
      const originalCount = sockets.length;
      const menu = view.getByRole("button", { name: "Browser menu" });
      await menu.click();
      const parent = view.getByRole("menu", {
        name: "Browser menu",
        exact: true,
      });
      await expect(parent.getByRole("menuitem").first()).toHaveText(
        "Transport",
      );
      await view.getByRole("menuitem", { name: "Capture quality" }).click();
      const detail = view.getByRole("dialog", { name: "Capture quality" });
      const quality = detail.getByRole("slider", { name: "JPEG quality" });
      await quality.focus();
      await page.keyboard.press("ArrowRight");
      await expect(quality).toHaveValue("71");
      await detail.getByRole("radio", { name: "1280 × 720" }).click();
      await expect
        .poll(() => original.captures.at(-1))
        .toMatchObject({ quality: 71, maxWidth: 1280, maxHeight: 720 });
      await page.keyboard.press("Escape");
      await expect(detail).toHaveCount(0);
      const trigger = view.getByRole("menuitem", {
        name: "Transport",
        exact: true,
      });
      await trigger.focus();
      await page.keyboard.press("ArrowRight");
      const transport = view.getByRole("menu", {
        name: "Transport",
        exact: true,
      });
      const shared = transport.getByRole("menuitemradio", {
        name: "Shared",
        exact: true,
      });
      const split = transport.getByRole("menuitemradio", {
        name: "Split frame / control",
      });
      await expect(transport).toBeVisible();
      await expect(shared).toBeChecked();
      await expect(split).not.toBeChecked();
      await view.screenshot({
        path: info.outputPath(`transport-settings-${colorScheme}.png`),
      });
      await page.addStyleTag({
        content: "#viewer-a .cdpv-root { width:320px;height:420px }",
      });
      await expect
        .poll(async () => {
          const root = (await view.boundingBox())!,
            popup = (await transport.boundingBox())!;
          return (
            popup.x >= root.x &&
            popup.y >= root.y &&
            popup.x + popup.width <= root.x + root.width &&
            popup.y + popup.height <= root.y + root.height
          );
        })
        .toBe(true);
      await split.focus();
      await page.keyboard.press("Enter");
      await expect(menu).toBeFocused();
      await expect.poll(() => sockets.length).toBe(originalCount + 2);
      await expect.poll(() => original.socket.isClosed()).toBe(true);
      await expect.poll(() => active(a.targetId).length).toBe(2);
      await expect(view).toHaveAttribute("data-status", "streaming");
      await expect(sibling).toHaveAttribute("data-status", "streaming");
      expect(active(b.targetId)).toEqual([independent]);
      const separated = active(a.targetId);
      await expect
        .poll(() => separated.flatMap((record) => record.captures))
        .toContainEqual(
          expect.objectContaining({
            quality: 71,
            maxWidth: 1280,
            maxHeight: 720,
          }),
        );
      await expect(page.locator("#host-submissions")).toHaveText("0");
      await menu.click();
      await trigger.click();
      await expect(split).toBeChecked();
      await shared.click();
      await expect.poll(() => sockets.length).toBe(originalCount + 3);
      await expect
        .poll(() => separated.every((record) => record.socket.isClosed()))
        .toBe(true);
      await expect.poll(() => active(a.targetId).length).toBe(1);
      await expect(view).toHaveAttribute("data-status", "streaming");
      expect(active(b.targetId)).toEqual([independent]);
      await expect
        .poll(() => active(a.targetId).flatMap((record) => record.captures))
        .toContainEqual(
          expect.objectContaining({
            quality: 71,
            maxWidth: 1280,
            maxHeight: 720,
          }),
        );
      expect(a.remote.isClosed()).toBe(false);
      expect(b.remote.isClosed()).toBe(false);
      await page.getByRole("button", { name: "Host submit" }).click();
      await expect(page.locator("#host-submissions")).toHaveText("1");
    } finally {
      await backend.close();
    }
  });
}
