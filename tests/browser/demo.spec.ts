import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchBackend, serveConsumer } from "./backend";

let server: Awaited<ReturnType<typeof serveConsumer>>;
let demoUrl: string;
test.beforeAll(async () => {
  server = await serveConsumer(resolve("dist/demo"), "/cdp-viewer/");
  demoUrl = process.env.CDP_VIEWER_DEMO_URL ?? server.origin + "/cdp-viewer/";
  const url = new URL(demoUrl);
  if (
    url.pathname !== "/cdp-viewer/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (process.env.CDP_VIEWER_DEMO_URL && url.protocol !== "https:")
  ) {
    throw new Error("The deployed demo must use the HTTPS project-site URL.");
  }
});
test.afterAll(async () => server?.close());

async function openDemo(page: Page) {
  if (process.env.CDP_VIEWER_DEMO_URL) {
    // The rollout probes an owned loopback endpoint from the public HTTPS page.
    // Model an explicit user grant; record it, rather than bypassing security.
    await page.context().grantPermissions(["local-network-access"], {
      origin: new URL(demoUrl).origin,
    });
  }
  const response = await page.goto(demoUrl);
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "cdp-viewer", exact: true }),
  ).toBeVisible();
  const revision = await page
    .locator('meta[name="cdp-viewer-revision"]')
    .getAttribute("content");
  expect(revision).toBeTruthy();
  if (process.env.GITHUB_SHA) expect(revision).toBe(process.env.GITHUB_SHA);
  return revision;
}

function panel(page: Page, number: number) {
  return page.getByRole("region", { name: `Viewer ${number}`, exact: true });
}

async function configure(panel: Locator, endpoint: string, windowId?: number) {
  await panel.getByLabel("CDP URL", { exact: true }).fill(endpoint);
  await panel
    .getByLabel(/^Window ID/)
    .fill(windowId === undefined ? "" : String(windowId));
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
}

async function expectColor(viewer: Locator, color: [number, number, number]) {
  await expect(viewer).toHaveAttribute("data-status", "streaming");
  await expect
    .poll(async () =>
      viewer
        .locator("canvas")
        .evaluate((canvas: HTMLCanvasElement, expected) => {
          const context = canvas.getContext("2d");
          if (!context || !canvas.width || !canvas.height) return Infinity;
          const pixel = context.getImageData(0, 0, 1, 1).data;
          return Math.max(
            ...expected.map((channel, i) => Math.abs(pixel[i]! - channel)),
          );
        }, color),
    )
    .toBeLessThanOrEqual(4);
}

test("demo applies settings explicitly and isolates two real windows and cleanup", async ({
  page,
  browser,
}, info) => {
  const revision = await openDemo(page);
  const backend = await launchBackend(
    info.outputPath("backend"),
    new URL(demoUrl).origin,
  );
  const sockets: { closed: boolean }[] = [];
  page.on("websocket", (socket) => {
    const entry = { closed: false };
    sockets.push(entry);
    socket.on("close", () => {
      entry.closed = true;
    });
  });
  try {
    const red = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/red",
      newWindow: true,
    });
    const blue = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/blue",
      newWindow: true,
    });
    const aWindow = await backend.session.send("Browser.getWindowForTarget", {
      targetId: red.targetId,
    });
    const bWindow = await backend.session.send("Browser.getWindowForTarget", {
      targetId: blue.targetId,
    });
    expect(aWindow.windowId).not.toBe(bWindow.windowId);
    const a = panel(page, 1);
    await configure(a, backend.endpoint, aWindow.windowId);
    const aView = a.getByRole("region", { name: "Remote browser viewer" });
    await expectColor(aView, [232, 32, 48]);
    await page.getByRole("button", { name: "Add viewer" }).click();
    const b = panel(page, 2);
    await configure(b, backend.endpoint, bWindow.windowId);
    const bView = b.getByRole("region", { name: "Remote browser viewer" });
    await expectColor(bView, [24, 80, 224]);
    await expect(aView.locator("option")).toHaveCount(1);
    await expect(bView.locator("option")).toHaveCount(1);
    await page.screenshot({
      path: info.outputPath("two-window-demo.png"),
      fullPage: true,
    });

    const opened = sockets.length;
    await a
      .getByLabel("CDP URL", { exact: true })
      .fill("wss://draft.invalid/?token=synthetic");
    await a.getByLabel(/^Window ID/).fill("-1");
    await expectColor(aView, [232, 32, 48]);
    expect(sockets.length).toBe(opened);
    await a.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect.poll(() => sockets.length).toBeGreaterThan(opened);
    await expectColor(aView, [232, 32, 48]);
    await expectColor(bView, [24, 80, 224]);

    await a.getByLabel("CDP URL", { exact: true }).fill(backend.endpoint);
    await a
      .getByRole("button", { name: "Apply & connect", exact: true })
      .click();
    await expect(aView).toHaveAttribute("data-status", "unavailable");
    await expect(aView.getByRole("combobox")).toBeDisabled();
    await expectColor(bView, [24, 80, 224]);
    await a.getByLabel(/^Window ID/).fill(String(aWindow.windowId));
    await a
      .getByRole("button", { name: "Apply & connect", exact: true })
      .click();
    await expectColor(aView, [232, 32, 48]);
    await a.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(aView).toHaveCount(0);
    await expect(
      a.getByRole("button", { name: "Reconnect", exact: true }),
    ).toBeDisabled();
    await expectColor(bView, [24, 80, 224]);
    await a.getByRole("button", { name: "Connect", exact: true }).click();
    await expectColor(aView, [232, 32, 48]);
    await a.getByRole("button", { name: "Remove viewer 1" }).click();
    await expect(a).toHaveCount(0);
    expect(
      (
        await backend.session.send("Browser.getWindowForTarget", {
          targetId: red.targetId,
        })
      ).windowId,
    ).toBe(aWindow.windowId);
    const bluePage = backend.context
      .pages()
      .find((p) => p.url() === server.origin + "/fixture/blue");
    if (!bluePage) throw new Error("The other remote fixture was closed.");
    await bluePage.evaluate(() => {
      document.body.style.background = "rgb(24,224,80)";
    });
    await expectColor(bView, [24, 224, 80]);
    await page.getByRole("button", { name: "Add viewer" }).click();
    await expect(panel(page, 3)).toBeVisible();
    await expectColor(bView, [24, 224, 80]);
    await b.getByRole("button", { name: "Remove viewer 2" }).click();
    await expect
      .poll(() => sockets.filter((socket) => !socket.closed).length)
      .toBe(0);

    const version = await backend.session.send("Browser.getVersion");
    await writeFile(
      info.outputPath("demo-receipt.json"),
      JSON.stringify(
        {
          sourceRevision: revision,
          frontend: process.env.CDP_VIEWER_DEMO_URL
            ? "actual-pages-deployment"
            : "local-production-fixture",
          page: new URL(demoUrl).origin + new URL(demoUrl).pathname,
          client: browser.version(),
          backend: version.product,
          backendKind: "test-owned Chromium, allowlisted frontend Origin",
          localNetworkPermission: process.env.CDP_VIEWER_DEMO_URL
            ? "explicitly granted for the owned loopback endpoint"
            : "not required for loopback HTTP frontend",
          directBrowserWebSocket: true,
          differentWindows: true,
          draftIsolation: true,
          reconnect: true,
          independentCleanup: true,
          otherProviders: "unverified",
        },
        null,
        2,
      ),
    );
  } finally {
    await backend.close();
  }
});

test("invalid applied drafts preserve the active connection and live frames", async ({
  page,
}, info) => {
  await openDemo(page);
  const backend = await launchBackend(
    info.outputPath("backend"),
    new URL(demoUrl).origin,
  );
  let sockets = 0;
  page.on("websocket", () => {
    sockets++;
  });
  try {
    const target = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/red",
      newWindow: true,
    });
    const scope = await backend.session.send("Browser.getWindowForTarget", {
      targetId: target.targetId,
    });
    const a = panel(page, 1);
    await configure(a, backend.endpoint, scope.windowId);
    const view = a.getByRole("region", { name: "Remote browser viewer" });
    await expectColor(view, [232, 32, 48]);
    const opened = sockets;

    for (const suffix of ["#", "#fragment"]) {
      await a
        .getByLabel("CDP URL", { exact: true })
        .fill(backend.endpoint + suffix);
      await a
        .getByRole("button", { name: "Apply & connect", exact: true })
        .click();
      await expect(a.getByRole("alert")).toContainText(
        "without userinfo or a fragment",
      );
      await expectColor(view, [232, 32, 48]);
      expect(sockets).toBe(opened);
    }
    await a.getByLabel("CDP URL", { exact: true }).fill(backend.endpoint);
    for (const value of ["0.5", "9007199254740992"]) {
      await a.getByLabel(/^Window ID/).fill(value);
      await a
        .getByRole("button", { name: "Apply & connect", exact: true })
        .click();
      await expect(a.getByRole("alert")).toContainText("safe integer");
      await expectColor(view, [232, 32, 48]);
      expect(sockets).toBe(opened);
    }

    const remote = backend.context
      .pages()
      .find((p) => p.url() === server.origin + "/fixture/red");
    if (!remote) throw new Error("The active remote fixture was closed.");
    await remote.evaluate(() => {
      document.body.style.background = "rgb(24,224,80)";
    });
    await expectColor(view, [24, 224, 80]);
    await expect(view.getByRole("combobox")).toHaveValue(target.targetId);
    expect(sockets).toBe(opened);
  } finally {
    await backend.close();
  }
});

test("demo validates without navigation, preserves zero, and forgets settings on refresh", async ({
  page,
}, info) => {
  await openDemo(page);
  const backend = await launchBackend(
    info.outputPath("backend"),
    new URL(demoUrl).origin,
  );
  let sockets = 0;
  page.on("websocket", () => {
    sockets++;
  });
  try {
    const red = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/red",
      newWindow: true,
    });
    const blue = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/blue",
      newWindow: true,
    });
    const a = panel(page, 1);
    const endpoint = a.getByLabel("CDP URL", { exact: true });
    const window = a.getByLabel(/^Window ID/);
    await endpoint.fill("https://invalid.example/?secret=synthetic");
    await endpoint.press("Enter");
    await expect(a.getByRole("alert")).toContainText(
      "absolute ws:// or wss://",
    );
    expect(sockets).toBe(0);
    expect(page.url()).toBe(demoUrl);
    await expect(page.locator("main")).not.toContainText("secret=synthetic");
    await endpoint.fill(backend.endpoint);
    await window.fill("9007199254740992");
    await a.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(a.getByRole("alert")).toContainText("safe integer");
    expect(sockets).toBe(0);
    await window.fill("0");
    await a.getByRole("button", { name: "Connect", exact: true }).click();
    const view = a.getByRole("region", { name: "Remote browser viewer" });
    await expect(view).toHaveAttribute("data-status", "unavailable");
    await expect(view.getByRole("combobox")).toBeDisabled();
    expect(sockets).toBeGreaterThan(0);
    await window.fill("");
    await a
      .getByRole("button", { name: "Apply & connect", exact: true })
      .click();
    await expect(
      view.locator("option").filter({ hasText: "rgb(" }),
    ).toHaveCount(2);
    await view.getByRole("combobox").selectOption(red.targetId);
    await expectColor(view, [232, 32, 48]);
    await view.getByRole("combobox").selectOption(blue.targetId);
    await expectColor(view, [24, 80, 224]);
    expect(page.url()).toBe(demoUrl);
    expect(
      await page.evaluate(() => [localStorage.length, sessionStorage.length]),
    ).toEqual([0, 0]);
    await page.reload();
    await expect(
      panel(page, 1).getByLabel("CDP URL", { exact: true }),
    ).toHaveValue("");
    await expect(panel(page, 1).getByLabel(/^Window ID/)).toHaveValue("");
    await expect(
      page.getByRole("region", { name: "Remote browser viewer" }),
    ).toHaveCount(0);
  } finally {
    await backend.close();
  }
});

test("demo reports real Origin denial without echoing the endpoint", async ({
  page,
}, info) => {
  await openDemo(page);
  const backend = await launchBackend(
    info.outputPath("backend"),
    "https://not-the-demo.invalid",
  );
  try {
    const a = panel(page, 1);
    await configure(a, backend.endpoint);
    const view = a.getByRole("region", { name: "Remote browser viewer" });
    await expect(view).toHaveAttribute("data-status", "disconnected");
    await expect(view.getByRole("alert")).toContainText("Origin and TLS");
    await expect(view).not.toContainText(backend.endpoint);
    expect(page.url()).toBe(demoUrl);
  } finally {
    await backend.close();
  }
});

test("demo fits a narrow screen and can remove and add disconnected panels", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("mobile-demo.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Remove viewer 1" }).click();
  await expect(
    page.getByText("Add a viewer to connect to a browser."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add viewer" }).click();
  await expect(panel(page, 2)).toBeVisible();
});

test("HTTPS-origin fixture uses a native CDP connection with explicit network permission", async ({
  page,
  context,
}, info) => {
  test.skip(
    !!process.env.CDP_VIEWER_DEMO_URL,
    "The rollout scenarios above use the actual deployment instead.",
  );
  // Only the app assets are locally fulfilled. CDP remains a real browser-native
  // WebSocket; this is not an actual Pages deployment or a provider receipt.
  const fixtureUrl = "https://okou-ai.github.io/cdp-viewer/";
  await context.grantPermissions(["local-network-access"], {
    origin: new URL(fixtureUrl).origin,
  });
  await page.route(fixtureUrl + "**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const response = await page.request.get(server.origin + pathname);
    await route.fulfill({ response });
  });
  const backend = await launchBackend(
    info.outputPath("backend"),
    new URL(fixtureUrl).origin,
  );
  try {
    await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/red",
      newWindow: true,
    });
    await page.goto(fixtureUrl);
    await configure(panel(page, 1), backend.endpoint);
    const view = panel(page, 1).getByRole("region", {
      name: "Remote browser viewer",
    });
    await view.getByRole("combobox").selectOption({ label: "rgb(232,32,48)" });
    await expectColor(view, [232, 32, 48]);
    expect(new URL(page.url()).origin).toBe("https://okou-ai.github.io");
  } finally {
    await backend.close();
  }
});
