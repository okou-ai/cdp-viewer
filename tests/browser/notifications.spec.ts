import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
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
  try {
    await server?.close();
  } finally {
    await consumer?.cleanup();
  }
});

async function remoteWindow(
  backend: Awaited<ReturnType<typeof launchBackend>>,
) {
  const opened = backend.context.waitForEvent("page");
  const { targetId } = await backend.session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    {
      targetId,
    },
  );
  const remote = await opened;
  await remote.goto(server.origin + "/fixture/editor");
  return { remote, windowId };
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
  const viewer = page.locator("#viewer-a .cdpv-root");
  await expect(viewer).toHaveAttribute("data-status", "streaming");
  return viewer;
}

async function geometry(viewer: Locator) {
  return viewer.evaluate((root) => {
    const top = root.getBoundingClientRect().top;
    return [".cdpv-toolbar", ".cdpv-navigation", ".cdpv-stage", "canvas"].map(
      (selector) => {
        const rect = root.querySelector(selector)!.getBoundingClientRect();
        return { top: rect.top - top, height: rect.height, width: rect.width };
      },
    );
  });
}

async function warn(viewer: Locator) {
  const address = viewer.getByRole("textbox", { name: "Remote page address" });
  await address.fill("not-an-absolute-address");
  await address.press("Enter");
  await expect(viewer.getByRole("alert")).toContainText(
    "Enter an absolute http:// or https:// page address.",
  );
}

async function holdNextExit(viewer: Locator) {
  await viewer.evaluate((root) => {
    const observer = new MutationObserver(() => {
      const notice = root.querySelector('[role="alert"][data-phase="exiting"]');
      if (!notice) return;
      for (const animation of notice.getAnimations()) animation.pause();
      observer.disconnect();
    });
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-phase"],
    });
  });
}

async function sampleMotion(notice: Locator) {
  return notice.evaluate(async (node) => {
    const animation = node.getAnimations()[0];
    if (!animation)
      throw new Error("The notification has no native animation.");
    animation.pause();
    await animation.ready;
    const duration = Number(animation.effect!.getComputedTiming().duration);
    animation.currentTime = duration * 0.25;
    const first = node.getBoundingClientRect().top;
    animation.currentTime = duration * 0.75;
    const second = node.getBoundingClientRect().top;
    const clip = node.parentElement!;
    const stage = clip.parentElement!;
    return {
      first,
      second,
      overflow: getComputedStyle(clip).overflow,
      clipTop: clip.getBoundingClientRect().top,
      stageTop: stage.getBoundingClientRect().top,
    };
  });
}

async function finishMotion(notice: Locator) {
  await notice.evaluate((node) => {
    for (const animation of node.getAnimations()) animation.finish();
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [960, 320]) {
    test(`${colorScheme} ${width}px notification overlays without moving the page and expires while idle`, async ({
      page,
    }, info) => {
      const backend = await launchBackend(
        info.outputPath("backend"),
        server.origin,
      );
      try {
        const { windowId } = await remoteWindow(backend);
        let holdFrames = false;
        await page.routeWebSocket(backend.endpoint, (socket) => {
          const upstream = socket.connectToServer();
          upstream.onMessage((message) => {
            const event = JSON.parse(String(message)) as { method?: string };
            if (holdFrames && event.method === "Page.screencastFrame") return;
            socket.send(message);
          });
        });
        await page.setViewportSize({ width: 1100, height: 850 });
        const viewer = await host(page, {
          cdpUrl: backend.endpoint,
          windowA: windowId,
          interactive: true,
          second: false,
          colorSchemeA: colorScheme,
        });
        await viewer.evaluate((root, size) => {
          root.style.width = `${size}px`;
          document.querySelector<HTMLElement>(
            "#panels",
          )!.style.gridTemplateColumns = "minmax(0, 1fr)";
        }, width);
        const before = await geometry(viewer);
        holdFrames = true;
        const started = await page.evaluate(() => performance.now());
        await warn(viewer);
        await viewer.screenshot({ path: info.outputPath("notification.png") });
        expect(await geometry(viewer)).toEqual(before);
        // The product interval is five seconds, followed by its exit animation.
        await expect(viewer.getByRole("alert")).toHaveCount(0, {
          timeout: 7000,
        });
        const elapsed = await page.evaluate(
          (value) => performance.now() - value,
          started,
        );
        expect(elapsed).toBeGreaterThanOrEqual(5000);
        expect(await geometry(viewer)).toEqual(before);
        await expect(viewer).toHaveAttribute("data-status", "streaming");
      } finally {
        await backend.close();
      }
    });
  }
}

test("replaces an exiting notice immediately and isolates sibling and unmount lifetimes", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const first = await remoteWindow(backend);
    const second = await remoteWindow(backend);
    await page.setViewportSize({ width: 1400, height: 950 });
    const a = await host(page, {
      cdpUrl: backend.endpoint,
      windowA: first.windowId,
      windowB: second.windowId,
      interactive: true,
    });
    const b = page.locator("#viewer-b .cdpv-root");
    await expect(b).toHaveAttribute("data-status", "streaming");
    const before = await geometry(a);
    await warn(a);
    const notice = a.getByRole("alert");
    const old = await notice.elementHandle();
    if (!old) throw new Error("The old notification is missing.");
    const oldId = await notice.getAttribute("data-notification-id");
    const entry = await sampleMotion(notice);
    expect(entry.second).toBeGreaterThan(entry.first);
    expect(entry.overflow).toBe("hidden");
    expect(entry.clipTop).toBe(entry.stageTop);
    expect(await geometry(a)).toEqual(before);
    await a.screenshot({ path: info.outputPath("entry.png") });
    await holdNextExit(a);
    await finishMotion(notice);
    await expect(notice).toHaveAttribute("data-phase", "exiting", {
      timeout: 7000,
    });
    const exit = await sampleMotion(notice);
    expect(exit.second).toBeLessThan(exit.first);
    expect(await geometry(a)).toEqual(before);
    await a.screenshot({ path: info.outputPath("exit.png") });
    await old.evaluate((node) => {
      const complete = () =>
        node.setAttribute("data-test-exit-settled", "true");
      Promise.allSettled(
        node.getAnimations().map((animation) => animation.finished),
      ).then(complete, complete);
    });
    await warn(a);
    await expect
      .poll(() =>
        old.evaluate((node) => node.getAttribute("data-test-exit-settled")),
      )
      .toBe("true");
    expect(await old.evaluate((node) => node.isConnected)).toBe(false);
    await expect(a.getByRole("alert")).toHaveCount(1);
    await expect(notice).not.toHaveAttribute("data-notification-id", oldId!);
    await expect(notice).toHaveAttribute("data-phase", "visible");
    await warn(b);
    await holdNextExit(a);
    await expect(notice).toHaveAttribute("data-phase", "exiting", {
      timeout: 7000,
    });
    await expect(b.getByRole("alert")).toHaveCount(0, { timeout: 7000 });
    // Its native exit is paused: the owner must keep this node until completion.
    await expect(notice).toHaveCount(1);
    expect(await geometry(a)).toEqual(before);
    await finishMotion(notice);
    await expect(notice).toHaveCount(0);
    expect(await geometry(a)).toEqual(before);
    await warn(a);
    await warn(b);
    const siblingId = await b
      .getByRole("alert")
      .getAttribute("data-notification-id");
    await page.evaluate(() => window.removeFirstViewer!());
    await expect(a).toHaveCount(0);
    await expect(b.getByRole("alert")).toHaveAttribute(
      "data-notification-id",
      siblingId!,
    );
    await page.evaluate(() => window.restoreFirstViewer!());
    await expect(a).toHaveAttribute("data-status", "streaming");
    await expect(a.getByRole("alert")).toHaveCount(0);
    await expect(b).toHaveAttribute("data-status", "streaming");
  } finally {
    await backend.close();
  }
});

test("dismisses reduced-motion notices without animation events and retains recovery controls", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    const { windowId } = await remoteWindow(backend);
    const viewer = await host(page, {
      cdpUrl: backend.endpoint,
      windowA: windowId,
      interactive: true,
      second: false,
    });
    const before = await geometry(viewer);
    await warn(viewer);
    expect(
      await viewer
        .getByRole("alert")
        .evaluate((node) => node.getAnimations().length),
    ).toBe(0);
    expect(await geometry(viewer)).toEqual(before);
    await expect(viewer.getByRole("alert")).toHaveCount(0, { timeout: 7000 });
    expect(await geometry(viewer)).toEqual(before);
    await backend.close();
    await expect(viewer).toHaveAttribute("data-status", "disconnected");
    await expect(viewer.getByRole("alert")).toHaveCount(1);
    await expect(viewer.locator(".cdpv-notification-viewport")).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Reconnect viewer" }),
    ).toBeEnabled();
  } finally {
    await backend.close();
  }
});
