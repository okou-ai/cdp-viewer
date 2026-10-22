import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { launchBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => {
  await server?.close();
});

async function editor(backend: Awaited<ReturnType<typeof launchBackend>>) {
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
  return { remote, windowId, targetId: target.targetId };
}

async function host(
  page: Page,
  endpoint: string,
  windowA?: number,
  windowB?: number,
) {
  await page.goto(server.origin);
  await page.waitForFunction(
    () => typeof window.configureViewers === "function",
  );
  await page.evaluate(async (settings) => window.configureViewers!(settings), {
    cdpUrl: endpoint,
    interactive: true,
    ...(windowA === undefined ? {} : { windowA }),
    ...(windowB === undefined ? { second: false } : { windowB }),
  });
  const view = page.locator("#viewer-a .cdpv-root");
  await expect(view).toHaveAttribute("data-status", "streaming");
  return view;
}

for (const scoped of [false, true]) {
  test(`native input proceeds during an optional history response (${scoped ? "scoped" : "unscoped"})`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    let release: (() => void) | undefined;
    try {
      const { remote, windowId, targetId } = await editor(backend);
      let armed = false;
      let historyId: number | undefined;
      let signalHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      await page.routeWebSocket(backend.endpoint, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as {
            id: number;
            method: string;
          };
          if (armed && command.method === "Page.getNavigationHistory") {
            armed = false;
            historyId = command.id;
          }
          upstream.send(message);
        });
        upstream.onMessage((message) => {
          const response = JSON.parse(String(message)) as { id?: number };
          if (historyId !== undefined && response.id === historyId) {
            historyId = undefined;
            release = () => socket.send(message);
            signalHeld();
          } else socket.send(message);
        });
      });
      const view = await host(
        page,
        backend.endpoint,
        scoped ? windowId : undefined,
      );
      if (!scoped) {
        await view.locator(`[data-target-id="${targetId}"]`).click();
        await expect(view).toHaveAttribute("data-status", "streaming");
      }
      await expect(view.getByLabel("Remote page address")).toHaveValue(
        server.origin + "/fixture/editor",
      );
      armed = true;
      await remote.reload();
      await held;
      await remote.locator("#plain").focus();
      await view.getByRole("textbox", { name: "Remote browser input" }).focus();
      await page.keyboard.insertText("input before history");
      await expect(remote.locator("#plain")).toHaveValue(
        "input before history",
      );
      release!();
      release = undefined;
      await expect(view.getByLabel("Remote page address")).toHaveValue(
        server.origin + "/fixture/editor",
      );
      await expect(view.getByRole("alert")).toHaveCount(0);
    } finally {
      release?.();
      await backend.close();
    }
  });
}

test("same-page different-window viewers survive a sibling's pending history read and removal", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  let removed = false;
  let release: (() => void) | undefined;
  try {
    const first = await editor(backend);
    const second = await editor(backend);
    let armed = false;
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      let attachId: number | undefined;
      let sessionId: string | undefined;
      let historyId: number | undefined;
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as {
          id: number;
          method: string;
          sessionId?: string;
          params?: { targetId?: string };
        };
        if (
          command.method === "Target.attachToTarget" &&
          command.params?.targetId === first.targetId
        )
          attachId = command.id;
        if (
          armed &&
          sessionId !== undefined &&
          command.sessionId === sessionId &&
          command.method === "Page.getNavigationHistory"
        ) {
          armed = false;
          historyId = command.id;
        }
        upstream.send(message);
      });
      upstream.onMessage((message) => {
        const response = JSON.parse(String(message)) as {
          id?: number;
          result?: { sessionId?: string };
        };
        if (attachId !== undefined && response.id === attachId)
          sessionId = response.result?.sessionId;
        if (historyId !== undefined && response.id === historyId) {
          historyId = undefined;
          release = () => {
            if (!removed) socket.send(message);
          };
          signalHeld();
        } else socket.send(message);
      });
    });
    const a = await host(
      page,
      backend.endpoint,
      first.windowId,
      second.windowId,
    );
    const b = page.locator("#viewer-b .cdpv-root");
    await expect(b).toHaveAttribute("data-status", "streaming");
    await expect(a.getByLabel("Remote page address")).toHaveValue(
      server.origin + "/fixture/editor",
    );
    armed = true;
    await first.remote.reload();
    await held;
    removed = true;
    await page.evaluate(() => window.removeFirstViewer!());
    await expect(a).toHaveCount(0);
    await second.remote.locator("#plain").focus();
    await b.getByRole("textbox", { name: "Remote browser input" }).focus();
    await page.keyboard.insertText("sibling survives");
    await expect(second.remote.locator("#plain")).toHaveValue(
      "sibling survives",
    );
    await second.remote.evaluate(() => {
      document.documentElement.style.background = "rgb(24,224,80)";
    });
    await expect
      .poll(() =>
        b.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
          const pixel = canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data;
          return [24, 224, 80].every(
            (value, index) => Math.abs(value - pixel[index]!) <= 4,
          );
        }),
      )
      .toBe(true);
    expect(first.remote.isClosed()).toBe(false);
    expect(second.remote.isClosed()).toBe(false);
    await expect(b.getByLabel("Remote page address")).toHaveValue(
      server.origin + "/fixture/editor",
    );
  } finally {
    release?.();
    await backend.close();
  }
});

test("reload and reattachment retain browser-owned back and forward history", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const view = await host(page, backend.endpoint, windowId);
    const original = server.origin + "/fixture/editor";
    const next = original + "?next";
    const address = view.getByLabel("Remote page address");
    await expect(address).toHaveValue(original);
    await address.fill(next);
    await address.press("Enter");
    await expect(remote).toHaveURL(next);
    const back = view.getByRole("button", { name: "Back remote page" });
    const forward = view.getByRole("button", { name: "Forward remote page" });
    await expect(back).toBeEnabled();
    await back.click();
    await expect(remote).toHaveURL(original);
    await expect(forward).toBeEnabled();
    const peer = await backend.context.newCDPSession(remote);
    const before = await peer.send("Page.getNavigationHistory");
    const loaded = remote.waitForEvent("load");
    await view.getByRole("button", { name: "Reload remote page" }).click();
    await loaded;
    await expect(address).toHaveValue(original);
    await expect(forward).toBeEnabled();
    const afterReload = await peer.send("Page.getNavigationHistory");
    expect(afterReload.entries.map((entry) => entry.url)).toEqual(
      before.entries.map((entry) => entry.url),
    );
    expect(afterReload.currentIndex).toBe(before.currentIndex);
    await page.evaluate(() => window.removeFirstViewer!());
    await expect(view).toHaveCount(0);
    await page.evaluate(() => window.restoreFirstViewer!());
    await expect(view).toHaveAttribute("data-status", "streaming");
    await expect(address).toHaveValue(original);
    await expect(forward).toBeEnabled();
    const afterAttach = await peer.send("Page.getNavigationHistory");
    expect(afterAttach.entries.map((entry) => entry.url)).toEqual(
      before.entries.map((entry) => entry.url),
    );
    expect(afterAttach.currentIndex).toBe(before.currentIndex);
    await forward.click();
    await expect(remote).toHaveURL(next);
    await expect(back).toBeEnabled();
    await expect(view.getByRole("alert")).toHaveCount(0);
    await peer.detach();
  } finally {
    await backend.close();
  }
});
