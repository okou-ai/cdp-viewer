import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { prepareConsumer } from "../../scripts/consumer.mjs";
import { launchBackend, serveConsumer } from "../browser/backend";
import { ProbeHost } from "./probe-host";
import { installProbeClient } from "./probe-client";
import type { GuardedProbe } from "./guarded-probe";
import type {} from "../consumer/api";

let consumer: Awaited<ReturnType<typeof prepareConsumer>>;
let server: Awaited<ReturnType<typeof serveConsumer>>;
test.beforeAll(async () => {
  consumer = await prepareConsumer();
  server = await serveConsumer(consumer.dist);
});
test.afterAll(async () => {
  try {
    await server?.close();
  } finally {
    await consumer?.cleanup();
  }
});

type Backend = Awaited<ReturnType<typeof launchBackend>>;
interface Remote {
  page: Page;
  targetId: string;
  windowId: number;
}

async function remote(backend: Backend, name: string): Promise<Remote> {
  const created = backend.context.waitForEvent("page");
  const { targetId } = await backend.session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const page = await created;
  await page.goto(server.origin + "/fixture/editor?lane=" + name);
  await page.evaluate(() => {
    const events: { type: string; key: string; shift: boolean }[] = [];
    Object.assign(window, { retirementEvents: events });
    for (const type of ["keydown", "keyup"])
      document.addEventListener(type, (event) => {
        const key = event as KeyboardEvent;
        events.push({ type, key: key.key, shift: key.shiftKey });
      });
    document.documentElement.style.background = document.body.style.background =
      "rgb(232,32,48)";
    document.querySelector("#plain")!.addEventListener("input", () => {
      document.documentElement.style.background =
        document.body.style.background = "rgb(24,224,80)";
    });
  });
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    {
      targetId,
    },
  );
  return { page, targetId, windowId };
}

async function events(remote: Remote) {
  return remote.page.evaluate(
    () =>
      (
        window as unknown as {
          retirementEvents: { type: string; key: string; shift: boolean }[];
        }
      ).retirementEvents,
  );
}

async function shiftCount(remote: Remote, type: "keydown" | "keyup") {
  return (await events(remote)).filter(
    (v) => v.type === type && v.key === "Shift",
  ).length;
}

async function viewer(
  browser: Browser,
  host: ProbeHost,
  backend: Backend,
  remote: Remote,
  name: string,
) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  let probe: GuardedProbe | undefined;
  try {
    let send: ((data: string) => void) | undefined;
    let started!: () => void;
    let finished!: (confirmed: boolean) => void;
    const channelClosed = new Promise<void>((resolve) => {
      started = resolve;
    });
    const retired = new Promise<boolean>((resolve) => {
      finished = resolve;
    });
    probe = await host.admit({
      targetId: remote.targetId,
      windowId: remote.windowId,
      reply: (value) => send?.(JSON.stringify(value)),
    });
    const admitted = probe;
    const endpoint = "wss://executor.fixture.invalid/" + name;
    await context.routeWebSocket(endpoint, (socket) => {
      send = (data) => socket.send(data);
      socket.onMessage((message) => admitted.receive(String(message)));
      socket.onClose(() => {
        // Fixture host reports viewer loss; this is not a shipping adapter.
        const receipt = host.retire(admitted);
        started();
        void receipt.then(finished);
      });
    });
    const page = await context.newPage();
    await page.goto(server.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate((settings) => window.configureViewers!(settings), {
      cdpUrl: backend.endpoint,
      windowA: remote.windowId,
      interactive: false,
      second: false,
    });
    const view = page.locator("#viewer-a .cdpv-root");
    await view.locator(`[data-target-id="${remote.targetId}"]`).click();
    await expect(view).toHaveAttribute("data-status", "streaming");
    await remote.page.locator("#plain").focus();
    await page.evaluate(installProbeClient, {
      endpoint,
      owner: admitted.owner,
    });
    return { page, context, probe: admitted, channelClosed, retired };
  } catch (error) {
    probe?.close();
    await context.close();
    throw error;
  }
}

async function editAndStream(page: Page, remote: Remote, text: string) {
  await page.keyboard.insertText(text);
  await expect(remote.page.locator("#plain")).toHaveValue(text);
  await expect
    .poll(() =>
      page.locator("#viewer-a canvas").evaluate((canvas: HTMLCanvasElement) => {
        const pixel = canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data;
        return [24, 224, 80].every(
          (value, index) => Math.abs(value - pixel[index]!) <= 4,
        );
      }),
    )
    .toBe(true);
}

for (const loss of ["pause", "unmount", "viewer disconnect"] as const) {
  test(`retirement after ${loss} waits for original native ACK while sibling edits and streams`, async ({
    browser,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    const host = new ProbeHost(backend.endpoint);
    const contexts: Awaited<ReturnType<typeof viewer>>[] = [];
    try {
      const first = await remote(backend, "a");
      const second = await remote(backend, "b");
      const a = await viewer(browser, host, backend, first, "a");
      contexts.push(a);
      const b = await viewer(browser, host, backend, second, "b");
      contexts.push(b);
      const held = a.probe.holdNext("Input.dispatchKeyEvent");
      await a.page.keyboard.down("Shift");
      await held.held;
      await b.page.keyboard.down("Shift");
      await expect.poll(() => shiftCount(first, "keydown")).toBe(1);
      await expect.poll(() => shiftCount(second, "keydown")).toBe(1);
      let retirement: Promise<boolean>;
      if (loss === "pause") {
        await a.page.evaluate(
          (settings) => window.configureViewers!(settings),
          {
            cdpUrl: backend.endpoint,
            windowA: first.windowId,
            interactive: false,
            second: false,
            paused: true,
          },
        );
        await expect(a.page.locator(".cdpv-root")).toHaveAttribute(
          "data-status",
          "paused",
        );
        retirement = host.retire(a.probe, "paused");
      } else {
        if (loss === "unmount")
          await a.page.evaluate(() => {
            window.removeFirstViewer!();
            const input = document.querySelector<HTMLTextAreaElement>(
              '[aria-label="Executor experiment input"]',
            )!;
            input.blur();
            input.remove();
          });
        else await a.page.close();
        await a.channelClosed;
        retirement = a.retired;
      }
      await expect.poll(() => shiftCount(first, "keyup")).toBe(1);
      await expect(
        host.admit({
          targetId: first.targetId,
          windowId: first.windowId,
          reply: () => {},
        }),
      ).rejects.toThrow("unsettled owner");
      await editAndStream(b.page, second, "sibling");
      expect(await shiftCount(second, "keyup")).toBe(0);
      held.release();
      expect(await retirement).toBe(true);
      expect(await shiftCount(first, "keyup")).toBe(1);
      expect(first.page.isClosed()).toBe(false);
      expect(second.page.isClosed()).toBe(false);
    } finally {
      host.close();
      try {
        for (const value of contexts) await value.context.close();
      } finally {
        await backend.close();
      }
    }
  });
}

test("actual tab handover discards old queued input and cannot release the replacement modifier", async ({
  browser,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const host = new ProbeHost(backend.endpoint);
  const contexts: Awaited<ReturnType<typeof viewer>>[] = [];
  try {
    const first = await remote(backend, "moving");
    const second = await remote(backend, "destination");
    const a = await viewer(browser, host, backend, first, "old");
    contexts.push(a);
    const b = await viewer(browser, host, backend, second, "sibling");
    contexts.push(b);
    await a.page.keyboard.down("Shift");
    await b.page.keyboard.down("Shift");
    await expect.poll(() => shiftCount(first, "keydown")).toBe(1);
    await expect.poll(() => shiftCount(second, "keydown")).toBe(1);
    const held = a.probe.holdNext("Browser.getWindowForTarget");
    await a.page.keyboard.insertText("discarded old text");
    await held.held;
    const worker =
      backend.context.serviceWorkers()[0] ??
      (await backend.context.waitForEvent("serviceworker"));
    await worker.evaluate(
      async ({ fromUrl, destinationUrl }) => {
        const tabs = (
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
        const all = await tabs.query({});
        const from = all.find((tab) => tab.url === fromUrl);
        const to = all.find((tab) => tab.url === destinationUrl);
        if (!from || !to) throw new Error("Owned fixture tabs are missing");
        await tabs.move(from.id, { windowId: to.windowId, index: -1 });
      },
      { fromUrl: first.page.url(), destinationUrl: second.page.url() },
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
      .toBe(second.windowId);
    expect(await host.retire(a.probe, "target-replaced")).toBe(true);
    await expect(first.page.locator("#plain")).toHaveValue("");
    await expect.poll(() => shiftCount(first, "keyup")).toBe(1);
    const next = await viewer(
      browser,
      host,
      backend,
      { ...first, windowId: second.windowId },
      "replacement",
    );
    contexts.push(next);
    await next.page.keyboard.down("Shift");
    await expect.poll(() => shiftCount(first, "keydown")).toBe(2);
    held.release();
    a.probe.close();
    expect(await host.retire(a.probe)).toBe(false);
    await editAndStream(next.page, first, "new owner");
    expect(await shiftCount(first, "keyup")).toBe(1);
    expect(await shiftCount(second, "keyup")).toBe(0);
    expect(a.probe.receive("late old channel")).toBe(false);
  } finally {
    host.close();
    try {
      for (const value of contexts) await value.context.close();
    } finally {
      await backend.close();
    }
  }
});

test("CDP loss during retirement remains unavailable despite a locally observed release", async ({
  browser,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const wires: WebSocket[] = [];
  const host = new ProbeHost(backend.endpoint, (endpoint) => {
    const socket = new WebSocket(endpoint);
    wires.push(socket);
    return socket;
  });
  const contexts: Awaited<ReturnType<typeof viewer>>[] = [];
  try {
    const first = await remote(backend, "a");
    const second = await remote(backend, "b");
    const a = await viewer(browser, host, backend, first, "a");
    contexts.push(a);
    const b = await viewer(browser, host, backend, second, "b");
    contexts.push(b);
    await a.page.keyboard.down("Shift");
    await expect.poll(() => shiftCount(first, "keydown")).toBe(1);
    const held = a.probe.holdNext("Input.dispatchKeyEvent");
    const retirement = host.retire(a.probe);
    await held.held;
    await expect.poll(() => shiftCount(first, "keyup")).toBe(1);
    wires[0]!.close();
    expect(await retirement).toBe(false);
    held.release();
    await expect(
      host.admit({
        targetId: first.targetId,
        windowId: first.windowId,
        reply: () => {},
      }),
    ).rejects.toThrow("unsettled owner");
    await editAndStream(b.page, second, "live");
  } finally {
    host.close();
    try {
      for (const value of contexts) await value.context.close();
    } finally {
      await backend.close();
    }
  }
});
