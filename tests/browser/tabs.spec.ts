import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { prepareConsumer } from "../../scripts/consumer.mjs";
import { launchBackend, serveConsumer } from "./backend";
import type {} from "../consumer/api";

let consumer: Awaited<ReturnType<typeof prepareConsumer>>;
let server: Awaited<ReturnType<typeof serveConsumer>>;
test.beforeAll(async () => {
  consumer = await prepareConsumer();
  server = await serveConsumer(consumer.dist);
});
test.afterAll(async () => {
  await server?.close();
  await consumer?.cleanup();
});

async function remoteTab(
  backend: Awaited<ReturnType<typeof launchBackend>>,
  title: string,
  newWindow = false,
) {
  const opened = backend.context.waitForEvent("page");
  const target = await backend.session.send("Target.createTarget", {
    url: server.origin + "/fixture/editor",
    newWindow,
  });
  const remote = await opened;
  await remote.waitForLoadState();
  await remote.setContent(`<!doctype html><html><head><title>${title}</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:#232833;font:15px system-ui}header{height:66px;padding:20px 30px;background:white;border-bottom:1px solid #e7e9ef;display:flex;justify-content:space-between}header b{color:#5465d9}main{padding:32px}small{color:#697386}h1{font-size:28px;margin:8px 0}p{color:#697386}.cards{display:flex;gap:16px;margin:30px 0}.card{flex:1;background:white;border:1px solid #e7e9ef;border-radius:12px;padding:20px}.card strong{display:block;font-size:30px;margin-top:10px}article{background:white;border:1px solid #e7e9ef;border-radius:12px;padding:24px}li{padding:14px 0;border-bottom:1px solid #eef0f4}li:last-child{border:0}input{font:inherit;border:1px solid #d9dde7;border-radius:6px;padding:8px}
    </style></head><body><header><b>◈ Workspace</b><small>Design team · Preview</small></header><main><small>WORKSPACE / OVERVIEW</small><h1>Good morning, team.</h1><p>Everything you need for a productive day.</p><div class="cards"><div class="card">Active projects<strong>12</strong></div><div class="card">Tasks completed<strong>38</strong></div><div class="card">Team members<strong>8</strong></div></div><article><b>Today’s priorities</b><ul><li>Review the new browser experience</li><li>Share feedback with the team</li><li>Prepare the next product update</li></ul><input aria-label="Project note" placeholder="Add a note…"></article></main></body></html>`);
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    { targetId: target.targetId },
  );
  return { remote, targetId: target.targetId, windowId };
}

async function host(
  page: Page,
  settings: Parameters<NonNullable<Window["configureViewers"]>>[0],
) {
  await page.goto(server.origin);
  await page.waitForFunction(
    () => typeof window.configureViewers === "function",
  );
  await page.evaluate((value) => window.configureViewers!(value), settings);
  return page.locator("#viewer-a .cdpv-root");
}

test("real tab actions preserve window placement, later selection and stable native nodes", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const first = await remoteTab(backend, "Workspace", true);
    const second = await remoteTab(backend, "Other window", true);
    await first.remote.evaluate(() => {
      window.open = () => {
        throw new Error("Page-world override");
      };
    });
    const a = await host(page, {
      cdpUrl: backend.endpoint,
      windowA: first.windowId,
      windowB: second.windowId,
      interactive: true,
    });
    const b = page.locator("#viewer-b .cdpv-root");
    await expect(a).toHaveAttribute("data-status", "streaming");
    await expect(b).toHaveAttribute("data-status", "streaming");
    const proxy = await a.getByLabel("Remote browser input").elementHandle();
    const canvas = await a.locator("canvas").elementHandle();
    await backend.session.send("Target.activateTarget", {
      targetId: second.targetId,
    });
    const opened = backend.context.waitForEvent("page");
    await a.getByRole("button", { name: "New tab", exact: true }).click();
    const created = await opened;
    await expect(a).toHaveAttribute("data-status", "streaming");
    const selected = a.getByRole("tab", { selected: true });
    await expect(selected).not.toHaveAttribute(
      "data-target-id",
      first.targetId,
    );
    await expect(a).toHaveAttribute("data-status", "streaming");
    const targetId = await selected.getAttribute("data-target-id");
    expect(
      (
        await backend.session.send("Browser.getWindowForTarget", {
          targetId: targetId!,
        })
      ).windowId,
    ).toBe(first.windowId);
    expect(await created.evaluate(() => opener === null)).toBe(true);
    await expect(created).toHaveURL("about:blank");
    await expect(a.getByLabel("Remote page address")).toHaveValue("");
    await expect(a.getByLabel("Remote page address")).toBeFocused();
    expect(
      await a
        .getByLabel("Remote browser input")
        .evaluate((element, old) => element === old, proxy),
    ).toBe(true);
    expect(
      await a
        .locator("canvas")
        .evaluate((element, old) => element === old, canvas),
    ).toBe(true);
    await a
      .getByLabel("Remote page address")
      .fill(server.origin + "/fixture/blue");
    await a.getByLabel("Remote page address").press("Enter");
    await expect(created).toHaveURL(server.origin + "/fixture/blue");
    await a.locator(`[data-target-id="${first.targetId}"]`).click();
    await expect(a).toHaveAttribute("data-status", "streaming");
    await page.keyboard.press("ArrowRight");
    await expect(a.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-target-id",
      first.targetId,
    );
    await page.keyboard.press("Enter");
    await expect(a.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-target-id",
      targetId!,
    );
    await a
      .getByRole("button", { name: "Close Workspace", exact: true })
      .click();
    await expect(a.getByRole("tab")).toHaveCount(1);
    await expect(a.getByRole("tab", { selected: true })).toBeFocused();
    await expect(a.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-target-id",
      targetId!,
    );
    expect(first.remote.isClosed()).toBe(true);
    await a.locator(`[data-close-target="${targetId}"]`).click();
    await expect(a.getByText("No tabs open", { exact: true })).toBeVisible();
    await expect(
      a.getByRole("button", { name: "New tab", exact: true }),
    ).toBeDisabled();
    await expect(b).toHaveAttribute("data-status", "streaming");
    expect(second.remote.isClosed()).toBe(false);
  } finally {
    await backend.close();
  }
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`captures rendered ${colorScheme} tab, recovery, pending and responsive states`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    let holdCreate = false;
    let failClose = false;
    let holdClose = false;
    let holdStream = false;
    let empty = false;
    let release: (() => void) | undefined;
    let disconnect: (() => void) | undefined;
    let releaseClose: (() => void) | undefined;
    let releaseStream: (() => void) | undefined;
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      disconnect = () => socket.close();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as {
          id: number;
          method: string;
        };
        if (holdCreate && command.method === "Page.createIsolatedWorld") {
          release = () => upstream.send(message);
          return;
        }
        if (failClose && command.method === "Target.closeTarget") {
          const reject = () =>
            socket.send(
              JSON.stringify({
                id: command.id,
                error: { code: -32000, message: "Synthetic denial" },
              }),
            );
          if (holdClose) releaseClose = reject;
          else reject();
          return;
        }
        if (holdStream && command.method === "Page.startScreencast") {
          releaseStream = () => upstream.send(message);
          return;
        }
        if (empty && command.method === "Target.getTargets") {
          socket.send(
            JSON.stringify({ id: command.id, result: { targetInfos: [] } }),
          );
          return;
        }
        upstream.send(message);
      });
    });
    try {
      await page.emulateMedia({ colorScheme });
      const first = await remoteTab(backend, "Workspace", true);
      await remoteTab(backend, "Product notes");
      await remoteTab(backend, "Weekly report");
      const a = await host(page, {
        cdpUrl: backend.endpoint,
        windowA: first.windowId,
        second: false,
        interactive: true,
      });
      const arrange = async () => {
        await page.evaluate(() => {
          document.documentElement.style.colorScheme = "light dark";
          document.body.style.margin = "24px";
          document.querySelector<HTMLElement>(
            "#panels",
          )!.style.gridTemplateColumns = "minmax(0, 1fr)";
          document.querySelector<HTMLElement>("#panels")!.style.maxWidth =
            "960px";
          const root = document.querySelector<HTMLElement>(".cdpv-root")!;
          root.style.height = "600px";
        });
      };
      await arrange();
      await a.locator(`[data-target-id="${first.targetId}"]`).click();
      await expect(a).toHaveAttribute("data-status", "streaming");
      await expect(a.getByRole("tab")).toHaveCount(3);
      await a.getByRole("button", { name: "New tab", exact: true }).hover();
      await a.screenshot({ path: info.outputPath("01-normal.png") });
      failClose = true;
      holdClose = true;
      await a
        .getByRole("button", { name: "Close Weekly report", exact: true })
        .click();
      await expect.poll(() => !!releaseClose).toBe(true);
      await expect(a.getByRole("status")).toContainText("Closing tab");
      await a.screenshot({ path: info.outputPath("11-closing.png") });
      holdClose = false;
      releaseClose!();
      await expect(a.getByRole("alert")).toContainText("tab operation");
      await expect(a).toHaveAttribute("data-status", "streaming");
      await a.screenshot({ path: info.outputPath("02-operation-error.png") });
      failClose = false;
      holdCreate = true;
      await a.getByRole("button", { name: "New tab", exact: true }).click();
      await expect.poll(() => !!release).toBe(true);
      await expect(
        a.getByRole("button", { name: "New tab", exact: true }),
      ).toBeDisabled();
      await expect(a.getByRole("status")).toContainText("Creating tab");
      await a.screenshot({ path: info.outputPath("03-creating.png") });
      holdCreate = false;
      release!();
      await expect(a.getByRole("tab")).toHaveCount(4);
      await expect(a.getByRole("tab", { selected: true })).not.toHaveAttribute(
        "data-target-id",
        first.targetId,
      );
      await expect(a).toHaveAttribute("data-status", "streaming");
      await expect(a.getByLabel("Remote page address")).toHaveValue("");
      await expect(a.getByLabel("Remote page address")).toBeFocused();
      await a.screenshot({ path: info.outputPath("12-new-blank.png") });
      await a.locator(`[data-target-id="${first.targetId}"]`).click();
      for (let index = 1; index <= 9; index++)
        await remoteTab(backend, `Project ${index} · Planning and research`);
      await expect(a.getByRole("tab")).toHaveCount(13);
      expect(
        await a
          .getByRole("tablist")
          .evaluate((list) => list.scrollWidth > list.clientWidth),
      ).toBe(true);
      await a.getByRole("tab").last().click();
      await expect(a.getByRole("tab").last()).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(
        a.getByRole("button", { name: "New tab", exact: true }),
      ).toBeInViewport();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await a.screenshot({ path: info.outputPath("04-overflow.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(a.getByLabel("Remote page address")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await a.screenshot({ path: info.outputPath("05-narrow.png") });
      await page.setViewportSize({ width: 1100, height: 850 });
      const lost = await a
        .getByRole("tab", { selected: true })
        .getAttribute("data-target-id");
      await backend.session.send("Target.closeTarget", { targetId: lost! });
      await expect(a).toHaveAttribute("data-status", "unavailable");
      await expect(a.getByRole("tab", { selected: true })).toHaveCount(0);
      await expect(
        a.locator(`[data-target-id="${first.targetId}"]`),
      ).toBeVisible();
      await expect(
        a.getByText("Choose a tab to continue", { exact: true }),
      ).toBeVisible();
      await a.screenshot({ path: info.outputPath("13-selection-lost.png") });
      await a.locator(`[data-target-id="${first.targetId}"]`).click();
      await expect(a).toHaveAttribute("data-status", "streaming");
      await page.evaluate((settings) => window.configureViewers!(settings), {
        cdpUrl: backend.endpoint,
        windowA: first.windowId,
        second: false,
        interactive: false,
      });
      await expect(a).toHaveAttribute("data-status", "streaming");
      await expect(
        a.getByRole("button", { name: "New tab", exact: true }),
      ).toHaveCount(0);
      await expect(a.locator(".cdpv-close")).toHaveCount(0);
      await a.screenshot({ path: info.outputPath("06-view-only.png") });
      await page.evaluate((settings) => window.configureViewers!(settings), {
        cdpUrl: backend.endpoint,
        windowA: first.windowId,
        second: false,
        interactive: true,
        paused: true,
      });
      await expect(a).toHaveAttribute("data-status", "paused");
      await a.screenshot({ path: info.outputPath("07-paused.png") });
      empty = true;
      await page.evaluate((settings) => window.configureViewers!(settings), {
        cdpUrl: backend.endpoint,
        second: false,
        interactive: true,
      });
      await expect(a.getByText("No tabs open", { exact: true })).toBeVisible();
      await expect(
        a.getByRole("button", { name: "Create new tab", exact: true }),
      ).toBeEnabled();
      await a.screenshot({ path: info.outputPath("08-empty.png") });
      empty = false;
      await a.getByRole("button", { name: "Reconnect viewer" }).click();
      await expect(a).toHaveAttribute("data-status", "streaming");
      disconnect!();
      await expect(a).toHaveAttribute("data-status", "disconnected");
      await expect(
        a.getByRole("button", { name: "Reconnect viewer" }),
      ).toBeVisible();
      await a.screenshot({ path: info.outputPath("09-disconnected.png") });
      holdStream = true;
      await a.getByRole("button", { name: "Reconnect viewer" }).click();
      await expect.poll(() => !!releaseStream).toBe(true);
      await expect(a).toHaveAttribute("data-status", "connecting");
      await a.screenshot({ path: info.outputPath("14-connecting.png") });
      holdStream = false;
      releaseStream!();
      await expect(a).toHaveAttribute("data-status", "streaming");
      expect(first.remote.isClosed()).toBe(false);
      await page.evaluate(() =>
        window.configureViewers!({
          cdpUrl: "ws://127.0.0.1:9/devtools/browser/unreachable",
          second: false,
          interactive: true,
        }),
      );
      await expect(a.getByRole("alert")).toContainText(
        "WebSocket connection failed",
      );
      await a.screenshot({ path: info.outputPath("10-connection-failed.png") });
      await expect(a.locator(".cdpv-footer")).toHaveCount(0);
    } finally {
      await backend.close();
    }
  });
}

test("inherits host appearance and isolates explicit and system overrides without reconnecting", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  let connections = 0;
  page.on("websocket", () => {
    connections++;
  });
  try {
    const first = await remoteTab(backend, "Workspace", true);
    const second = await remoteTab(backend, "Notes", true);
    await page.emulateMedia({ colorScheme: "light" });
    const settings = {
      cdpUrl: backend.endpoint,
      windowA: first.windowId,
      windowB: second.windowId,
      interactive: true,
      colorSchemeB: "light" as const,
    };
    const a = await host(page, settings);
    const b = page.locator("#viewer-b .cdpv-root");
    await expect(a).toHaveAttribute("data-status", "streaming");
    await expect(b).toHaveAttribute("data-status", "streaming");
    const socketCount = connections;
    const proxy = await a.getByLabel("Remote browser input").elementHandle();
    const canvas = await a.locator("canvas").elementHandle();
    await page.locator("#panels").evaluate((element) => {
      element.style.colorScheme = "dark";
    });
    await expect(a).toHaveCSS("background-color", "rgb(53, 54, 58)");
    await expect(b).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await page.evaluate(
      (value) => window.configureViewers!({ ...value, colorSchemeA: "system" }),
      settings,
    );
    await expect(a).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(a).toHaveCSS("background-color", "rgb(53, 54, 58)");
    await expect(b).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await page.evaluate(
      (value) => window.configureViewers!({ ...value, colorSchemeA: "light" }),
      settings,
    );
    await expect(a).toHaveCSS("background-color", "rgb(255, 255, 255)");
    expect(
      await a
        .getByLabel("Remote browser input")
        .evaluate((element, old) => element === old, proxy),
    ).toBe(true);
    expect(
      await a
        .locator("canvas")
        .evaluate((element, old) => element === old, canvas),
    ).toBe(true);
    await expect(a.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-target-id",
      first.targetId,
    );
    expect(connections).toBe(socketCount);
  } finally {
    await backend.close();
  }
});
