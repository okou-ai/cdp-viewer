import { expect, test } from "@playwright/test";
import { launchNativeBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

async function ownedTab(
  backend: Awaited<ReturnType<typeof launchNativeBackend>>,
  path: string,
  title: string,
) {
  const opened = backend.context.waitForEvent("page");
  const target = await backend.session.send("Target.createTarget", {
    url: server.origin + path,
    newWindow: true,
  });
  const remote = await opened;
  await remote.waitForLoadState();
  await remote.evaluate((value) => {
    document.title = value;
  }, title);
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    { targetId: target.targetId },
  );
  return { ...target, windowId, remote };
}

async function move(
  backend: Awaited<ReturnType<typeof launchNativeBackend>>,
  path: string,
  windowId: number,
) {
  const worker =
    backend.context.serviceWorkers()[0] ??
    (await backend.context.waitForEvent("serviceworker"));
  await worker.evaluate(
    async ({ url, windowId }) => {
      const tabs = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query(options: { url: string }): Promise<{ id: number }[]>;
              move(
                id: number,
                options: { windowId: number; index: number },
              ): Promise<unknown>;
            };
          };
        }
      ).chrome.tabs;
      const [tab] = await tabs.query({ url });
      if (!tab) throw new Error("The owned source tab is unavailable.");
      await tabs.move(tab.id, { windowId, index: -1 });
    },
    { url: server.origin + path, windowId },
  );
}

test("retires a selected native tab moved without target inventory events", async ({
  page,
}) => {
  const backend = await launchNativeBackend(server.origin, true);
  let suppress = false;
  try {
    const source = await ownedTab(backend, "/fixture/red", "Owned source");
    const destination = await ownedTab(backend, "/fixture/blue", "Destination");
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      upstream.onMessage((message) => {
        const event = JSON.parse(String(message)) as { method?: string };
        if (
          suppress &&
          [
            "Target.targetCreated",
            "Target.targetInfoChanged",
            "Target.targetDestroyed",
            "Target.detachedFromTarget",
          ].includes(event.method ?? "")
        )
          return;
        socket.send(message);
      });
    });
    await page.goto(server.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate((settings) => window.configureViewers!(settings), {
      cdpUrl: backend.endpoint,
      windowA: source.windowId,
      interactive: true,
      second: false,
    });
    const viewer = page.locator("#viewer-a .cdpv-root");
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    await expect(viewer.getByLabel("Remote browser input")).toBeEnabled();
    suppress = true;
    await move(backend, "/fixture/red", destination.windowId);
    await expect(viewer).toHaveAttribute("data-status", "unavailable");
    await expect(viewer.getByRole("tab", { name: "Owned source" })).toHaveCount(
      0,
    );
    await expect(viewer.getByLabel("Remote browser input")).toBeDisabled();
    expect(
      (
        await backend.session.send("Browser.getWindowForTarget", {
          targetId: source.targetId,
        })
      ).windowId,
    ).toBe(destination.windowId);
  } finally {
    await backend.close();
  }
});

test("reconciles a silent incoming native tab while paused", async ({
  page,
}) => {
  const backend = await launchNativeBackend(server.origin, true);
  let suppress = false;
  let queries = 0;
  try {
    const source = await ownedTab(backend, "/fixture/red", "Owned incoming");
    const destination = await ownedTab(backend, "/fixture/blue", "Destination");
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as { method?: string };
        if (command.method === "Target.getTargets") queries++;
        upstream.send(message);
      });
      upstream.onMessage((message) => {
        const event = JSON.parse(String(message)) as { method?: string };
        if (
          suppress &&
          [
            "Target.targetCreated",
            "Target.targetInfoChanged",
            "Target.targetDestroyed",
          ].includes(event.method ?? "")
        )
          return;
        socket.send(message);
      });
    });
    await page.clock.install();
    await page.goto(server.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate((settings) => window.configureViewers!(settings), {
      cdpUrl: backend.endpoint,
      windowA: destination.windowId,
      paused: true,
      second: false,
    });
    const viewer = page.locator("#viewer-a .cdpv-root");
    await expect(viewer).toHaveAttribute("data-status", "paused");
    await expect(
      viewer.getByRole("tab", { name: "Owned incoming" }),
    ).toHaveCount(0);
    suppress = true;
    await move(backend, "/fixture/red", destination.windowId);
    const initialQueries = queries;
    await page.clock.fastForward(10_000);
    await expect(
      viewer.getByRole("tab", { name: "Owned incoming" }),
    ).toBeVisible();
    await expect(
      viewer.getByRole("tab", { selected: true }),
    ).toHaveAccessibleName("Destination");
    await expect(viewer).toHaveAttribute("data-status", "paused");
    expect(queries - initialQueries).toBe(1);
    expect(
      (
        await backend.session.send("Browser.getWindowForTarget", {
          targetId: source.targetId,
        })
      ).windowId,
    ).toBe(destination.windowId);
  } finally {
    await backend.close();
  }
});
