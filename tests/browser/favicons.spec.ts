import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { createServer } from "node:http";
import { launchNativeBackend, serveBrowserConsumer } from "./backend";
import type { FixtureSettings } from "../consumer/api";

let consumer: Awaited<ReturnType<typeof serveBrowserConsumer>>;
let icons: Awaited<ReturnType<typeof serveIcons>>;
test.beforeAll(async () => {
  consumer = await serveBrowserConsumer();
  icons = await serveIcons();
});
test.afterAll(async () => {
  await consumer?.close();
  await icons?.close();
});

async function serveIcons() {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    response.setHeader("Cache-Control", "no-store");
    if (path.startsWith("/icons/")) {
      if (path.endsWith("broken.svg")) response.writeHead(404).end();
      else {
        response.setHeader("Content-Type", "image/svg+xml");
        response.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#246ee9"/></svg>',
        );
      }
      return;
    }
    const name = path.split("/").at(-1) ?? "none";
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><html><head><title>Icon ${name}</title>${name === "none" ? "" : `<link rel="icon" href="../icons/${name}.svg">`}</head><body><input aria-label="Owned editor"></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not bind.");
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function remoteTab(
  backend: Awaited<ReturnType<typeof launchNativeBackend>>,
  name: string,
  newWindow = false,
) {
  const opened = backend.context.waitForEvent("page");
  const { targetId } = await backend.session.send("Target.createTarget", {
    url: "about:blank",
    newWindow,
  });
  const remote = await opened;
  await remote.goto(icons.origin + "/pages/" + name);
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    { targetId },
  );
  return { remote, targetId, windowId };
}

async function connect(
  page: Page,
  endpoint: string,
  windowId: number,
  transport: "shared" | "split",
) {
  await page.goto(consumer.origin);
  await page.waitForFunction(
    () => typeof window.configureViewers === "function",
  );
  const settings: FixtureSettings = {
    cdpUrl: endpoint,
    windowA: windowId,
    second: false,
    interactive: true,
    transport,
    colorSchemeA: transport === "split" ? "dark" : "light",
  };
  await page.evaluate((value) => window.configureViewers!(value), settings);
  const viewer = page.locator("#viewer-a .cdpv-root");
  await expect(viewer).toHaveAttribute("data-status", "streaming");
  return viewer;
}

for (const transport of ["shared", "split"] as const) {
  test(`${transport}: keeps Globe while loading/failed/absent and shows a successful declared URL`, async ({
    page,
  }, info) => {
    const backend = await launchNativeBackend(consumer.origin, true, 2);
    const held: Route[] = [];
    let holdImages = true;
    let metadataReads = 0;
    let attachments = 0;
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        const command = JSON.parse(String(payload)) as {
          method: string;
          params?: { expression?: string };
        };
        if (command.params?.expression?.startsWith("/* cdp-viewer favicon */"))
          metadataReads++;
        if (command.method === "Target.attachToTarget") attachments++;
      }),
    );
    await page.route(icons.origin + "/icons/slow.svg", (route) => {
      if (holdImages) held.push(route);
      else return route.continue();
    });
    try {
      const selected = await remoteTab(backend, "slow", true);
      const viewer = await connect(
        page,
        backend.endpoint,
        selected.windowId,
        transport,
      );
      const tab = viewer.locator(`[data-target-id="${selected.targetId}"]`);
      await expect(tab).toHaveAttribute("aria-selected", "true");
      const image = tab.locator(".cdpv-favicon img");
      const globe = tab.locator(".cdpv-favicon svg");
      await expect.poll(() => held.length).toBe(1);
      await expect(image).toHaveAttribute(
        "src",
        icons.origin + "/icons/slow.svg",
      );
      await expect(image).toBeHidden();
      await expect(globe).toBeVisible();
      await expect(viewer.getByLabel("Remote browser input")).toBeEnabled();
      const nativeBefore = await selected.remote.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }));
      const background = await remoteTab(backend, "fast");
      expect(background.windowId).toBe(selected.windowId);
      // CDP list ordering is unspecified; establish selection before adding
      // background pages. A narrow host forces the real overflow layout.
      for (let index = 0; index < 4; index++) await remoteTab(backend, "none");
      await page.locator("#viewer-a").evaluate((element) => {
        element.style.width = "180px";
      });

      const picker = viewer.getByRole("combobox", { name: "All tabs" });
      await picker.click();
      const option = viewer.locator(`[data-tab-option="${selected.targetId}"]`);
      // Both image nodes keep Globe while the native request is held. Chromium
      // may coalesce or cache image requests; neither case needs a CDP read.
      await expect(option.locator(".cdpv-favicon img")).toHaveAttribute(
        "src",
        icons.origin + "/icons/slow.svg",
      );
      await expect(option.locator(".cdpv-favicon img")).toBeHidden();
      await expect(option.locator(".cdpv-favicon svg")).toBeVisible();
      const unknown = viewer.locator(
        `[data-tab-option="${background.targetId}"]`,
      );
      await expect(unknown.locator(".cdpv-favicon img")).toHaveCount(0);
      await expect(unknown.locator(".cdpv-favicon svg")).toBeVisible();
      holdImages = false;
      for (const route of held.splice(0)) await route.continue();
      await expect(option.locator(".cdpv-favicon img")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.locator("#viewer-a").evaluate((element) => {
        element.style.removeProperty("width");
      });
      await expect(image).toBeVisible();
      await expect(image).toHaveAttribute("data-loaded", "");
      await expect(globe).toBeHidden();
      // A new overflow image owns its load state even after the tab image loaded.
      await page.locator("#viewer-a").evaluate((element) => {
        element.style.width = "180px";
      });
      await picker.click();
      await expect(option.locator(".cdpv-favicon img")).toBeVisible();
      await expect(option.locator(".cdpv-favicon img")).toHaveAttribute(
        "data-loaded",
        "",
      );
      await page.keyboard.press("Escape");
      await page.locator("#viewer-a").evaluate((element) => {
        element.style.removeProperty("width");
      });
      expect(metadataReads).toBe(1);
      expect(attachments).toBe(transport === "split" ? 2 : 1);

      expect(
        await selected.remote.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        })),
      ).toEqual(nativeBefore);
      // A 404 after navigation must not expose a broken image or turn an
      // optional failure into a viewer diagnostic.
      const response = page.waitForResponse(icons.origin + "/icons/broken.svg");
      await selected.remote.goto(icons.origin + "/pages/broken");
      expect((await response).status()).toBe(404);
      const failed = viewer;
      const failedTab = tab;
      await expect(failedTab.locator(".cdpv-favicon img")).toHaveCount(0);
      await expect(failedTab.locator(".cdpv-favicon svg")).toBeVisible();
      await expect(failed).toHaveAttribute("data-status", "streaming");
      await selected.remote.goto(icons.origin + "/pages/none");
      await expect(failedTab).toHaveAttribute("title", "Icon none");
      await expect(failedTab.locator(".cdpv-favicon img")).toHaveCount(0);
      await expect(failedTab.locator(".cdpv-favicon svg")).toBeVisible();

      await failed.locator(`[data-target-id="${background.targetId}"]`).click();
      const fast = failed.locator(
        `[data-target-id="${background.targetId}"] .cdpv-favicon img`,
      );
      await expect(fast).toHaveAttribute(
        "src",
        icons.origin + "/icons/fast.svg",
      );
      await expect(fast).toBeVisible();
      await expect(fast).toHaveAttribute("data-loaded", "");
      if (process.env.CDP_VIEWER_CAPTURE_TAB_SCREENSHOTS === "1")
        await failed.screenshot({
          path: info.outputPath(`favicons-${transport}.png`),
        });
    } finally {
      for (const route of held) await route.abort().catch(() => {});
      await backend.close();
    }
  });
}
