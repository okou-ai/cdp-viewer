import { expect, test } from "@playwright/test";
import type { Locator, Worker } from "@playwright/test";
import { createServer } from "node:http";
import { prepareConsumer } from "../../scripts/consumer.mjs";
import { launchBackend, serveConsumer } from "./backend";
import type {} from "../consumer/api";

let consumer: Awaited<ReturnType<typeof prepareConsumer>>;
let host: Awaited<ReturnType<typeof serveConsumer>>;
test.beforeAll(async () => {
  consumer = await prepareConsumer();
  host = await serveConsumer(consumer.dist);
});
test.afterAll(async () => {
  await host?.close();
  await consumer?.cleanup();
});

async function sites(defaultIcon = false, protectedOrigin?: string) {
  let authenticatedReads = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://owned.invalid").pathname;
    if (path.startsWith("/icons/") || path === "/favicon.ico") {
      if (path.includes("protected")) {
        if (!request.headers.cookie?.includes("favicon=owned")) {
          response.writeHead(403).end();
          return;
        }
        authenticatedReads++;
      }
      if (
        path.includes("missing") ||
        (path === "/favicon.ico" && !defaultIcon)
      ) {
        response.writeHead(404).end();
        return;
      }
      const color = path.includes("blue")
        ? "#1850e0"
        : path === "/favicon.ico"
          ? "#18e050"
          : "#e82030";
      response.setHeader("Content-Type", "image/svg+xml");
      const width = path.includes("wide") ? 32 : 16;
      response.end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="16"><rect width="${width}" height="16" fill="${color}"/></svg>`,
      );
      return;
    }
    const name = path.slice(1) || "red";
    const title = name[0]!.toUpperCase() + name.slice(1);
    const icon =
      name === "inline"
        ? "data:image/svg+xml," +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#e82030"/></svg>',
          )
        : name === "protected"
          ? `${protectedOrigin}/icons/protected.svg`
          : name === "mixed"
            ? "/icons/red.svg"
            : name === "broken"
              ? "/icons/missing.svg"
              : `./icons/${name}.svg`;
    response.setHeader("Content-Type", "text/html");
    if (name === "protected")
      response.setHeader("Set-Cookie", "favicon=owned; Path=/; SameSite=Lax");
    response.end(
      `<html><head><title>${title}</title>${name === "default" ? "" : `<link rel="icon" sizes="16x16" href="${icon}">`}${name === "multiple" ? '<link rel="icon" sizes="16x16" href="/icons/blue.svg"><link rel="icon" sizes="any" media="not all" href="/icons/red.svg">' : ""}${name === "mixed" ? '<link rel="icon" href="http://[">' : ""}</head><body style="background:#ddd"><h1>${title}</h1></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Owned icon server unavailable");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    authenticatedReads: () => authenticatedReads,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function expectIcon(tab: Locator, color: [number, number, number]) {
  await expect
    .poll(async () => {
      const icon = tab.locator("img.cdpv-favicon");
      if (!(await icon.count())) return null;
      return icon.evaluate((image: HTMLImageElement) => {
        if (!image.complete || !image.naturalWidth) return null;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0, 16, 16);
        return [...context.getImageData(8, 8, 1, 1).data].slice(0, 3);
      });
    })
    .toEqual(color);
  await expect(tab.locator("img.cdpv-favicon")).toHaveCSS("width", "16px");
  await expect(tab.locator("img.cdpv-favicon")).toHaveCSS("height", "16px");
}

async function nativeTabs(worker: Worker) {
  return worker.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        chrome: {
          tabs: {
            query(query: object): Promise<
              {
                id: number;
                url: string;
                favIconUrl?: string;
                active: boolean;
                windowId: number;
              }[]
            >;
          };
        };
      }
    ).chrome.tabs;
    return api.query({});
  });
}

test("installed viewers show native fixture icons, background updates, navigation fallback and independent cleanup", async ({
  page,
}, info) => {
  const site = await sites();
  let backend: Awaited<ReturnType<typeof launchBackend>> | undefined;
  try {
    backend = await launchBackend(info.outputPath("backend"), host.origin);
    const first = await backend.session.send("Target.createTarget", {
      url: site.origin + "/red",
      newWindow: true,
    });
    const second = await backend.session.send("Target.createTarget", {
      url: site.origin + "/blue",
      newWindow: true,
    });
    const aWindow = await backend.session.send("Browser.getWindowForTarget", {
      targetId: first.targetId,
    });
    const bWindow = await backend.session.send("Browser.getWindowForTarget", {
      targetId: second.targetId,
    });
    const worker =
      backend.context.serviceWorkers()[0] ??
      (await backend.context.waitForEvent("serviceworker"));
    const hostImageRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(site.origin))
        hostImageRequests.push(request.url());
    });
    await page.goto(host.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate((settings) => window.configureViewers!(settings), {
      cdpUrl: backend.endpoint,
      windowA: aWindow.windowId,
      windowB: bWindow.windowId,
      colorSchemeA: "light" as const,
      colorSchemeB: "dark" as const,
    });
    const a = page.locator("#viewer-a section");
    const b = page.locator("#viewer-b section");
    await expect(a).toHaveAttribute("data-status", "streaming");
    await expect(b).toHaveAttribute("data-status", "streaming");
    await expectIcon(
      a.getByRole("tab", { name: "Red", exact: true }),
      [232, 32, 48],
    );
    await expectIcon(
      b.getByRole("tab", { name: "Blue", exact: true }),
      [24, 80, 224],
    );
    await expect
      .poll(
        async () =>
          (await nativeTabs(worker)).find(
            (tab) => tab.url === site.origin + "/red",
          )?.favIconUrl,
      )
      .toBe(site.origin + "/icons/red.svg");
    await page.screenshot({ path: info.outputPath("favicon-light-dark.png") });

    await worker.evaluate(
      async ({ windowId, url }) => {
        const tabs = (
          globalThis as unknown as {
            chrome: {
              tabs: {
                create(options: {
                  windowId: number;
                  url: string;
                  active: boolean;
                }): Promise<unknown>;
              };
            };
          }
        ).chrome.tabs;
        await tabs.create({ windowId, url, active: false });
      },
      { windowId: aWindow.windowId, url: site.origin + "/multiple" },
    );
    const background = a.getByRole("tab", { name: "Multiple", exact: true });
    await expectIcon(background, [24, 80, 224]);
    await expect
      .poll(
        async () =>
          (await nativeTabs(worker)).find(
            (tab) => tab.url === site.origin + "/multiple",
          )?.favIconUrl,
      )
      .toBe(site.origin + "/icons/blue.svg");
    const remoteBackground = backend.context
      .pages()
      .find((remote) => remote.url() === site.origin + "/multiple")!;
    await remoteBackground.evaluate(() => {
      document.querySelectorAll<HTMLLinkElement>("link")[1]!.href =
        "/icons/red.svg";
    });
    await expectIcon(background, [232, 32, 48]);
    expect(
      (await nativeTabs(worker)).find(
        (tab) => tab.windowId === aWindow.windowId && tab.active,
      )?.url,
    ).toBe(site.origin + "/red");

    const red = backend.context
      .pages()
      .find((remote) => remote.url() === site.origin + "/red")!;
    await red.goto(site.origin + "/broken");
    const broken = a.getByRole("tab", { name: "Broken", exact: true });
    await expect(broken).toBeVisible();
    await expect(broken.locator("img.cdpv-favicon")).toHaveCount(0);
    await expect(a).toHaveAttribute("data-status", "streaming");
    await page.evaluate(() => window.removeFirstViewer!());
    await expect(a).toHaveCount(0);
    const blue = backend.context
      .pages()
      .find((remote) => remote.url() === site.origin + "/blue")!;
    await blue.evaluate(() => {
      document.querySelector<HTMLLinkElement>("link")!.href = "/icons/red.svg";
    });
    await expectIcon(
      b.getByRole("tab", { name: "Blue", exact: true }),
      [232, 32, 48],
    );
    await expect(b).toHaveAttribute("data-status", "streaming");
    expect(hostImageRequests).toEqual([]);
    await page.screenshot({
      path: info.outputPath("favicon-independent-cleanup.png"),
    });
  } finally {
    await backend?.close();
    await site.close();
  }
});

test("default icons and cookie-protected cross-origin icons load through the remote browser", async ({
  page,
}, info) => {
  const icons = await sites();
  let site: Awaited<ReturnType<typeof sites>> | undefined;
  let backend: Awaited<ReturnType<typeof launchBackend>> | undefined;
  try {
    site = await sites(true, icons.origin);
    backend = await launchBackend(info.outputPath("backend"), host.origin);
    const first = await backend.session.send("Target.createTarget", {
      url: site.origin + "/default",
      newWindow: true,
    });
    const second = await backend.session.send("Target.createTarget", {
      url: site.origin + "/protected",
      newWindow: true,
    });
    const aWindow = await backend.session.send("Browser.getWindowForTarget", {
      targetId: first.targetId,
    });
    const bWindow = await backend.session.send("Browser.getWindowForTarget", {
      targetId: second.targetId,
    });
    const hostImageRequests: string[] = [];
    page.on("request", (request) => {
      if (
        request.url().startsWith(site!.origin) ||
        request.url().startsWith(icons.origin)
      )
        hostImageRequests.push(request.url());
    });
    await page.goto(host.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate((settings) => window.configureViewers!(settings), {
      cdpUrl: backend.endpoint,
      windowA: aWindow.windowId,
      windowB: bWindow.windowId,
    });
    await expectIcon(
      page
        .locator("#viewer-a")
        .getByRole("tab", { name: "Default", exact: true }),
      [24, 224, 80],
    );
    await expectIcon(
      page
        .locator("#viewer-b")
        .getByRole("tab", { name: "Protected", exact: true }),
      [232, 32, 48],
    );
    expect(icons.authenticatedReads()).toBeGreaterThan(0);
    expect(hostImageRequests).toEqual([]);
    await page.screenshot({
      path: info.outputPath("favicon-default-authenticated.png"),
    });
  } finally {
    await backend?.close();
    await site?.close();
    await icons.close();
  }
});

test("inline icons preserve aspect ratio and host image policy falls back without stopping the stream", async ({
  page,
}, info) => {
  const site = await sites();
  let backend: Awaited<ReturnType<typeof launchBackend>> | undefined;
  try {
    backend = await launchBackend(info.outputPath("backend"), host.origin);
    const first = await backend.session.send("Target.createTarget", {
      url: site.origin + "/inline",
      newWindow: true,
    });
    const second = await backend.session.send("Target.createTarget", {
      url: site.origin + "/wide",
      newWindow: true,
    });
    const aWindow = await backend.session.send("Browser.getWindowForTarget", {
      targetId: first.targetId,
    });
    const bWindow = await backend.session.send("Browser.getWindowForTarget", {
      targetId: second.targetId,
    });
    await page.goto(host.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate((settings) => window.configureViewers!(settings), {
      cdpUrl: backend.endpoint,
      windowA: aWindow.windowId,
      windowB: bWindow.windowId,
    });
    const a = page.locator("#viewer-a section");
    const b = page.locator("#viewer-b section");
    await expectIcon(
      a.getByRole("tab", { name: "Inline", exact: true }),
      [232, 32, 48],
    );
    const wide = b.getByRole("tab", { name: "Wide", exact: true });
    await expectIcon(wide, [232, 32, 48]);
    expect(
      await wide.locator("img").evaluate((image: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 32;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(16, 0, 1, 1).data[3];
      }),
    ).toBe(0);
    const remote = backend.context
      .pages()
      .find((target) => target.url() === site.origin + "/inline")!;
    await remote.goto(site.origin + "/mixed");
    await expectIcon(
      a.getByRole("tab", { name: "Mixed", exact: true }),
      [232, 32, 48],
    );
    // Blob decoding remains allowed while the rendered data PNG is denied.
    await page.evaluate(() => {
      const policy = document.createElement("meta");
      policy.httpEquiv = "Content-Security-Policy";
      policy.content = "img-src blob:";
      document.head.append(policy);
    });
    await remote.evaluate(() => {
      document.querySelector<HTMLLinkElement>("link")!.href = "/icons/blue.svg";
    });
    const inline = a.getByRole("tab", { name: "Mixed", exact: true });
    await expect(inline.locator("img.cdpv-favicon")).toHaveCount(0);
    await expect(a).toHaveAttribute("data-status", "streaming");
    await expect(b).toHaveAttribute("data-status", "streaming");
    await expect(a.getByRole("alert")).toHaveCount(0);
  } finally {
    await backend?.close();
    await site.close();
  }
});
