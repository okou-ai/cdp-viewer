import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
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

async function pixel(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d");
    if (!context || !element.width || !element.height) return [];
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  });
}

async function expectColor(
  canvas: Locator,
  expected: [number, number, number],
) {
  // Screencast frames are JPEG, so allow small chroma/rounding differences.
  await expect
    .poll(async () => {
      const value = await pixel(canvas);
      return value.length === 3
        ? Math.max(
            ...value.map((channel, i) => Math.abs(channel - expected[i]!)),
          )
        : Infinity;
    })
    .toBeLessThanOrEqual(4);
}

test("offscreen panels release only their own stream and resume with portable frame decoding", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const first = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/red",
      newWindow: true,
    });
    const second = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/blue",
      newWindow: true,
    });
    const aWindow = await backend.session.send("Browser.getWindowForTarget", {
      targetId: first.targetId,
    });
    const bWindow = await backend.session.send("Browser.getWindowForTarget", {
      targetId: second.targetId,
    });
    // Exercise the documented fallback in a real browser, not only a fake bitmap.
    await page.addInitScript(() => {
      Reflect.deleteProperty(Uint8Array, "fromBase64");
    });
    await page.goto(server.origin);
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
    await expect(a).toHaveAttribute("data-status", "streaming");
    await expect(b).toHaveAttribute("data-status", "streaming");
    await page.locator("#viewer-a").evaluate((element) => {
      element.style.transform = "translateY(200vh)";
    });
    await expect(a).toHaveAttribute("data-status", "paused");
    await expect(b).toHaveAttribute("data-status", "streaming");
    const blue = backend.context
      .pages()
      .find((p) => p.url() === server.origin + "/fixture/blue")!;
    await blue.evaluate(() => {
      document.body.style.background = "rgb(24,224,80)";
    });
    await expectColor(b.locator("canvas"), [24, 224, 80]);
    await page.locator("#viewer-a").evaluate((element) => {
      element.style.transform = "";
    });
    await expect(a).toHaveAttribute("data-status", "streaming");
    await expectColor(a.locator("canvas"), [232, 32, 48]);
    expect(
      (
        await backend.session.send("Browser.getWindowForTarget", {
          targetId: first.targetId,
        })
      ).windowId,
    ).toBe(aWindow.windowId);
  } finally {
    await backend.close();
  }
});

test("installed viewers stream separate windows, detect a real moved tab, and isolate cleanup", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const first = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/red",
      newWindow: true,
    });
    const second = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/blue",
      newWindow: true,
    });
    const windowA = await backend.session.send("Browser.getWindowForTarget", {
      targetId: first.targetId,
    });
    const windowB = await backend.session.send("Browser.getWindowForTarget", {
      targetId: second.targetId,
    });
    expect(windowA.windowId).not.toBe(windowB.windowId);
    await page.goto(server.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    const before = await page.locator(".host-button").evaluate((element) => {
      const s = getComputedStyle(element);
      return [s.borderTopWidth, s.padding, s.fontFamily, s.backgroundColor];
    });
    await page.evaluate(
      async (settings) => {
        await window.configureViewers!(settings);
      },
      {
        cdpUrl: backend.endpoint,
        windowA: windowA.windowId,
        windowB: windowB.windowId,
      },
    );
    const a = page.locator("#viewer-a section");
    const b = page.locator("#viewer-b section");
    await expect(a).toHaveAttribute("data-status", "streaming");
    await expect(b).toHaveAttribute("data-status", "streaming");
    await expect(a).toHaveCSS("display", "flex");
    await expect(a.locator(".cdpv-toolbar")).toHaveCSS("column-gap", "8px");
    await expect(page.locator("#host-prefix-probe")).toHaveCSS(
      "display",
      "inline",
    );
    await expect(page.locator("#host-prefix-probe")).toBeVisible();
    await expect(a.locator("option")).toHaveCount(1);
    await expect(b.locator("option")).toHaveCount(1);
    await expectColor(a.locator("canvas"), [232, 32, 48]);
    await expectColor(b.locator("canvas"), [24, 80, 224]);
    expect(
      await page.locator(".host-button").evaluate((element) => {
        const s = getComputedStyle(element);
        return [s.borderTopWidth, s.padding, s.fontFamily, s.backgroundColor];
      }),
    ).toEqual(before);
    await expect(page.locator("#host-utility")).toHaveCSS("display", "grid");
    await page.getByRole("button", { name: "Host count: 0" }).click();
    await expect(
      page.getByRole("button", { name: "Host count: 1" }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("two-window-viewer.png") });

    // Unmount a streaming viewer, then prove the other still paints new frames.
    await page.evaluate(() => window.removeFirstViewer!());
    await expect(a).toHaveCount(0);
    expect(
      (
        await backend.session.send("Browser.getWindowForTarget", {
          targetId: first.targetId,
        })
      ).windowId,
    ).toBe(windowA.windowId);
    const blue = backend.context
      .pages()
      .find((p) => p.url() === server.origin + "/fixture/blue");
    if (!blue) throw new Error("The remaining fixture page was closed.");
    await blue.evaluate(() => {
      document.body.style.background = "rgb(24,224,80)";
    });
    await expectColor(b.locator("canvas"), [24, 224, 80]);
    await page.screenshot({ path: info.outputPath("remaining-viewer.png") });
    await page.evaluate(() => window.restoreFirstViewer!());
    await expect(a).toHaveAttribute("data-status", "streaming");
    await expectColor(a.locator("canvas"), [232, 32, 48]);

    // A real Chromium extension moves the existing tab; CDP has no move-tab API.
    const worker =
      backend.context.serviceWorkers()[0] ??
      (await backend.context.waitForEvent("serviceworker"));
    await worker.evaluate(
      async ({ red, blue }) => {
        const api = (
          globalThis as unknown as {
            chrome: {
              tabs: {
                query(
                  query: object,
                ): Promise<{ id: number; windowId: number; url: string }[]>;
                move(
                  id: number,
                  options: { windowId: number; index: number },
                ): Promise<unknown>;
              };
            };
          }
        ).chrome.tabs;
        const tabs = await api.query({});
        const from = tabs.find((tab) => tab.url === red);
        const to = tabs.find((tab) => tab.url === blue);
        if (!from || !to) throw new Error("Fixture tabs are missing.");
        await api.move(from.id, { windowId: to.windowId, index: -1 });
      },
      {
        red: server.origin + "/fixture/red",
        blue: server.origin + "/fixture/blue",
      },
    );
    await expect
      .poll(
        async () =>
          (
            await backend.session.send("Browser.getWindowForTarget", {
              targetId: first.targetId,
            })
          ).windowId,
      )
      .toBe(windowB.windowId);
    await expect(a).toHaveAttribute("data-status", "unavailable");
    await expect(b.locator("option")).toHaveCount(2);
    await expect(b).toHaveAttribute("data-status", "streaming");
    await expectColor(b.locator("canvas"), [24, 224, 80]);
    await page.screenshot({ path: info.outputPath("moved-window-viewer.png") });
  } finally {
    await backend.close();
  }
});

test("unscoped discovery shows pages across windows and does not guess after target destruction", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const first = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/red",
      newWindow: true,
    });
    await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/blue",
      newWindow: true,
    });
    await page.goto(server.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate(async (cdpUrl) => {
      await window.configureViewers!({ cdpUrl, second: false });
    }, backend.endpoint);
    const viewer = page.locator("#viewer-a section");
    await expect(
      viewer.locator("option").filter({ hasText: "rgb(" }),
    ).toHaveCount(2);
    await viewer.getByRole("combobox").selectOption(first.targetId);
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    await backend.session.send("Target.closeTarget", {
      targetId: first.targetId,
    });
    await expect(viewer).toHaveAttribute("data-status", "unavailable");
    await expect(viewer.getByRole("combobox")).toHaveValue("");
    await expect(
      viewer.locator("option").filter({ hasText: "rgb(" }),
    ).toHaveCount(1);
  } finally {
    await backend.close();
  }
});

test("browser-native Origin rejection yields a fixed diagnostic", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    await page.goto(server.origin.replace("127.0.0.1", "localhost"));
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate(async (cdpUrl) => {
      await window.configureViewers!({ cdpUrl, second: false });
    }, backend.endpoint);
    const viewer = page.locator("#viewer-a section");
    await expect(viewer).toHaveAttribute("data-status", "disconnected");
    await expect(viewer.getByRole("alert")).toContainText("Origin and TLS");
    await expect(viewer).not.toContainText(backend.endpoint);
  } finally {
    await backend.close();
  }
});
