import { expect, test } from "@playwright/test";
import type { Locator, WebSocketRoute } from "@playwright/test";
import { launchNativeBackend, serveBrowserConsumer } from "./backend";
import type { FixtureSettings } from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

async function expectColor(view: Locator, rgb: readonly number[]) {
  await expect
    .poll(() =>
      view.locator("canvas").evaluate((canvas: HTMLCanvasElement, expected) => {
        const pixel = canvas
          .getContext("2d")!
          .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
        return Math.max(
          ...expected.map((channel, index) =>
            Math.abs(channel - pixel[index]!),
          ),
        );
      }, rgb),
    )
    .toBeLessThanOrEqual(4);
}

for (const transport of ["shared", "split"] as const) {
  test(`${transport}: public image retry preserves sessions, native adaptation and another window`, async ({
    page,
  }) => {
    const backend = await launchNativeBackend(server.origin);
    try {
      async function open(color: "red" | "blue") {
        const created = backend.context.waitForEvent("page");
        const target = await backend.session.send("Target.createTarget", {
          url: server.origin + "/fixture/" + color,
          newWindow: true,
        });
        const remote = await created;
        await remote.waitForLoadState();
        const { windowId } = await backend.session.send(
          "Browser.getWindowForTarget",
          { targetId: target.targetId },
        );
        return { targetId: target.targetId, remote, windowId };
      }
      const a = await open("red");
      const b = await open("blue");
      await a.remote.evaluate(() => {
        document.body.dataset.identity = "original-document";
        const input = document.createElement("input");
        input.id = "plain";
        input.value = "preserved";
        document.body.append(input);
      });
      let sockets = 0,
        corrupt = false,
        failures = 0,
        holdFresh = false;
      const commands: {
        method: string;
        targetId?: string;
        sessionId?: string;
      }[] = [];
      const held: { socket: WebSocketRoute; message: string | Buffer }[] = [];
      await page.routeWebSocket(backend.endpoint, (socket) => {
        sockets++;
        const upstream = socket.connectToServer();
        const pending = new Map<number, string>();
        const sessions = new Map<string, string>();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as {
            id: number;
            method: string;
            sessionId?: string;
            params?: { targetId?: string };
          };
          if (
            command.method === "Target.attachToTarget" &&
            command.params?.targetId
          )
            pending.set(command.id, command.params.targetId);
          commands.push({
            method: command.method,
            ...(command.sessionId ? { sessionId: command.sessionId } : {}),
            ...(command.params?.targetId
              ? { targetId: command.params.targetId }
              : {}),
          });
          upstream.send(message);
        });
        upstream.onMessage((message) => {
          const event = JSON.parse(String(message)) as {
            id?: number;
            result?: { sessionId?: string };
            method?: string;
            sessionId?: string;
            params?: Record<string, unknown>;
          };
          if (event.id !== undefined && pending.has(event.id)) {
            if (event.result?.sessionId)
              sessions.set(event.result.sessionId, pending.get(event.id)!);
            pending.delete(event.id);
          }
          if (
            event.method === "Page.screencastFrame" &&
            event.sessionId &&
            sessions.get(event.sessionId) === a.targetId
          ) {
            if (corrupt) {
              corrupt = false;
              failures++;
              socket.send(
                JSON.stringify({
                  ...event,
                  params: {
                    ...event.params,
                    data: btoa("synthetic-invalid-jpeg"),
                  },
                }),
              );
              return;
            }
            if (holdFresh) {
              if (held.length < 3) held.push({ socket, message });
              return;
            }
          }
          socket.send(message);
        });
      });
      await page.goto(server.origin);
      await page.waitForFunction(
        () => typeof window.configureViewers === "function",
      );
      const settings: FixtureSettings = {
        cdpUrl: backend.endpoint,
        windowA: a.windowId,
        windowB: b.windowId,
        interactive: true,
        transport,
        windowSizeSync: "initial",
      };
      await page.evaluate(
        (settings) => window.configureViewers!(settings),
        settings,
      );
      const first = page.locator("#viewer-a .cdpv-root");
      const second = page.locator("#viewer-b .cdpv-root");
      await expect(first).toHaveAttribute("data-status", "streaming");
      await expect(second).toHaveAttribute("data-status", "streaming");
      await expect
        .poll(
          () =>
            commands.filter(
              (command) =>
                command.method === "Emulation.setDeviceMetricsOverride",
            ).length,
        )
        .toBeGreaterThanOrEqual(2);
      await expect(
        first.locator(".cdpv-browser-menu-trigger .cdpv-spinning"),
      ).toHaveCount(0);
      await expect(
        second.locator(".cdpv-browser-menu-trigger .cdpv-spinning"),
      ).toHaveCount(0);
      await expectColor(first, [232, 32, 48]);
      await expectColor(second, [24, 80, 224]);
      const originalSockets = sockets;
      const originalAttachments = commands.filter(
        (command) => command.method === "Target.attachToTarget",
      ).length;
      const originalViewport = await a.remote.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }));
      const beforeFailure = commands.length;
      corrupt = true;
      await a.remote.evaluate(() => {
        document.body.style.background = "rgb(24,224,80)";
      });
      const retry = first.getByRole("button", {
        name: "Retry live image",
        exact: true,
      });
      await expect(retry).toBeEnabled();
      await expect(first).toHaveAttribute("data-status", "error");
      await expect(first.getByLabel("Remote browser input")).toBeDisabled();
      await expect(second).toHaveAttribute("data-status", "streaming");
      holdFresh = true;
      await retry.click();
      await expect.poll(() => held.length).toBeGreaterThan(0);
      await expect(first.getByLabel("Remote browser input")).toBeDisabled();
      await expect(
        first.getByRole("button", { name: "Retrying live image…" }),
      ).toBeDisabled();
      holdFresh = false;
      for (const frame of held.splice(0)) frame.socket.send(frame.message);
      await expect(first).toHaveAttribute("data-status", "streaming");
      await expectColor(first, [24, 224, 80]);
      expect(
        await a.remote.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        })),
      ).toEqual(originalViewport);
      expect(
        await a.remote.evaluate(() => document.body.dataset.identity),
      ).toBe("original-document");
      await expect(a.remote.locator("#plain")).toHaveValue("preserved");
      await first.getByLabel("Remote browser input").focus();
      await a.remote.locator("#plain").focus();
      await page.keyboard.insertText(" recovered");
      await expect(a.remote.locator("#plain")).toHaveValue(
        "preserved recovered",
      );
      await b.remote.evaluate(() => {
        document.body.style.background = "rgb(80,24,224)";
      });
      await expectColor(second, [80, 24, 224]);
      expect(sockets).toBe(originalSockets);
      expect(
        commands.filter(
          (command) => command.method === "Target.attachToTarget",
        ),
      ).toHaveLength(originalAttachments);
      expect(
        commands
          .slice(beforeFailure)
          .some(
            (command) =>
              command.method === "Target.detachFromTarget" ||
              command.method === "Target.closeTarget" ||
              command.method === "Browser.close" ||
              command.method === "Page.navigate" ||
              command.method === "Page.reload" ||
              command.method === "Browser.setContentsSize" ||
              command.method.startsWith("Emulation."),
          ),
      ).toBe(false);
      expect(failures).toBe(1);
    } finally {
      await backend.close();
    }
  });
}
