import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchBackend, launchNativeBackend, serveConsumer } from "./backend";

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

test("capture quality menu stays synchronized with the demo's external controls", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    new URL(demoUrl).origin,
  );
  try {
    const remote = await backend.context.newPage();
    await remote.goto(server.origin + "/fixture/blue");
    await openDemo(page);
    const owner = panel(page, 1);
    await configure(owner, backend.endpoint);
    const view = owner.getByRole("region", { name: "Remote browser viewer" });
    await expect(view).toHaveAttribute("data-status", "streaming");
    const rail = owner.getByRole("complementary");
    await rail
      .locator("summary")
      .filter({ hasText: "Capture quality" })
      .click();
    const externalQuality = rail.getByRole("slider");
    const externalResolution = rail.getByRole("combobox", {
      name: "Capture resolution maximum",
    });
    const externalFormat = rail.getByRole("combobox", { name: "Image format" });
    await expect(externalFormat).toHaveValue("webp");
    const menu = view.getByRole("button", { name: "Browser menu" });
    await menu.click();
    await view.getByRole("menuitem", { name: "Capture quality" }).click();
    const detail = view.getByRole("dialog", { name: "Capture quality" });
    const quality = detail.getByRole("slider", { name: "Image quality" });
    await expect(quality).toBeEnabled();
    await quality.focus();
    await page.keyboard.press("ArrowRight");
    await expect(externalQuality).toHaveValue("71");
    await detail.getByRole("radio", { name: "1280 × 720" }).click();
    await expect(externalResolution).toHaveValue("1280x720");
    await detail.getByRole("radio", { name: "JPEG", exact: true }).click();
    await expect(externalFormat).toHaveValue("jpeg");
    await externalResolution.selectOption("default");
    await expect(externalFormat).toHaveValue("jpeg");
    await externalQuality.click();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Home");
    await expect(externalQuality).toHaveValue("0");
    await externalFormat.selectOption("png");
    await expect(externalQuality).toBeDisabled();
    await expect(externalQuality).toHaveValue("0");
    await expect(rail.getByText("Lossless", { exact: true })).toBeVisible();
    await expect(externalQuality).toHaveAttribute(
      "aria-valuetext",
      "Lossless (PNG)",
    );
    await menu.click();
    await view.getByRole("menuitem", { name: "Capture quality" }).click();
    await expect(
      view
        .getByRole("dialog", { name: "Capture quality" })
        .getByRole("slider", { name: "Image quality" }),
    ).toHaveValue("0");
    await expect(detail.getByRole("radio", { name: "PNG" })).toBeChecked();
    await expect(detail.getByRole("slider")).toBeDisabled();
    await detail.getByRole("radio", { name: "WebP" }).click();
    await expect(externalFormat).toHaveValue("webp");
    await expect(externalQuality).toBeEnabled();
    await expect(externalQuality).toHaveValue("0");
    await expect(rail.getByText("Lossless", { exact: true })).toHaveCount(0);
    await expect(externalQuality).not.toHaveAttribute("aria-valuetext");
  } finally {
    await backend.close();
  }
});

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

async function expectToolbarBounds(owner: Locator) {
  const toolbar = owner.locator(".demo-preview-toolbar");
  await expect(toolbar.locator("select, button")).toHaveCount(3);
  await expect
    .poll(() =>
      toolbar.evaluate((element) => {
        const boundaries = [
          element,
          element.closest(".demo-preview")!,
          element.closest(".demo-panel")!,
        ].map((ancestor) => ancestor.getBoundingClientRect());
        const controls = Array.from(
          element.querySelectorAll(
            ".demo-preview-label, .demo-mode, select, button",
          ),
        );
        const clipped = controls
          .filter((control) => {
            const bounds = control.getBoundingClientRect();
            return (
              !bounds.width ||
              !bounds.height ||
              boundaries.some(
                (boundary) =>
                  bounds.left < boundary.left ||
                  bounds.right > boundary.right ||
                  bounds.top < boundary.top ||
                  bounds.bottom > boundary.bottom,
              )
            );
          })
          .map(
            (control) =>
              control.getAttribute("aria-label") ?? control.textContent?.trim(),
          );
        const peers = controls.filter(
          (control) => control.tagName !== "SELECT",
        );
        const overlapping = peers
          .filter((control, index) => {
            const bounds = control.getBoundingClientRect();
            return peers.slice(index + 1).some((other) => {
              const next = other.getBoundingClientRect();
              return (
                bounds.left < next.right &&
                bounds.right > next.left &&
                bounds.top < next.bottom &&
                bounds.bottom > next.top
              );
            });
          })
          .map((control) => control.textContent?.trim());
        return { clipped, overlapping };
      }),
    )
    .toEqual({ clipped: [], overlapping: [] });
}

for (const width of [320, 360, 390]) {
  test(`demo preview toolbar keeps controls visible and operable at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await openDemo(page);
    const first = panel(page, 1);
    const mode = first.getByLabel("Control mode");
    const transport = first.getByLabel("Transport mode");
    const pause = first.getByRole("button", {
      name: "Pause stream",
      exact: true,
    });
    await expect(pause).toBeDisabled();
    await expectToolbarBounds(first);
    const stage = first.locator(".demo-stage");
    const initialStage = (await stage.boundingBox())!;
    const initialPreview = (await first
      .locator(".demo-disconnected")
      .boundingBox())!;
    await expect(stage).toHaveCSS("min-height", "360px");

    const backend = await launchBackend(
      info.outputPath("backend"),
      new URL(demoUrl).origin,
    );
    try {
      await backend.context.pages()[0]!.goto(server.origin + "/fixture/red");
      let sockets = 0;
      page.on("websocket", (socket) => {
        if (socket.url() === backend.endpoint) sockets++;
      });
      await configure(first, backend.endpoint);
      const view = first.getByRole("region", {
        name: "Remote browser viewer",
      });
      await expectColor(view, [232, 32, 48]);
      const originalView = await view.elementHandle();
      const originalInput = await view
        .getByLabel("Remote browser input")
        .elementHandle();
      expect(sockets).toBe(1);
      await expectToolbarBounds(first);

      await mode.focus();
      await expect(mode).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(transport).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(pause).toBeFocused();
      await page.keyboard.press("Space");
      await expect(view).toHaveAttribute("data-status", "paused");
      const resume = first.getByRole("button", {
        name: "Resume stream",
        exact: true,
      });
      await expect(resume).toHaveAttribute("aria-pressed", "true");
      await expect(resume).toBeFocused();
      await expectToolbarBounds(first);
      await resume.click();
      await expectColor(view, [232, 32, 48]);

      await pause.click();
      await expect(view).toHaveAttribute("data-status", "paused");
      await resume.press("Enter");
      await expectColor(view, [232, 32, 48]);
      await expect(pause).toHaveAttribute("aria-pressed", "false");
      await expectToolbarBounds(first);
      expect(sockets).toBe(1);
      expect(
        await view.evaluate(
          (element, previous) => element === previous,
          originalView,
        ),
      ).toBe(true);
      expect(
        await view
          .getByLabel("Remote browser input")
          .evaluate((element, previous) => element === previous, originalInput),
      ).toBe(true);
      const preview = (await view.boundingBox())!;
      expect(preview.width).toBe(initialPreview.width);
      expect(preview.height).toBe(initialPreview.height);
      expect((await stage.boundingBox())!.height).toBe(initialStage.height);
      await first.locator(".demo-preview").screenshot({
        path: info.outputPath(`preview-toolbar-${width}.png`),
      });
    } finally {
      await backend.close();
    }
  });
}

test("demo preview toolbar keeps complete controls in desktop multi-panel layouts", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openDemo(page);
  await expectToolbarBounds(panel(page, 1));
  await page.getByRole("button", { name: "Add viewer" }).click();
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectToolbarBounds(panel(page, 1));
    await expectToolbarBounds(panel(page, 2));
  }
  await page.screenshot({
    path: info.outputPath("preview-toolbar-two-panels.png"),
    fullPage: true,
  });
});

test("demo applies transport changes explicitly and keeps narrow controls usable", async ({
  page,
}, info) => {
  await openDemo(page);
  const backend = await launchNativeBackend(new URL(demoUrl).origin);
  try {
    const opened = backend.context.waitForEvent("page");
    await backend.session.send("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    });
    const remote = await opened;
    await remote.goto(server.origin + "/fixture/editor");
    let sockets = 0;
    page.on("websocket", (socket) => {
      if (socket.url() === backend.endpoint) sockets++;
    });
    const first = panel(page, 1);
    await configure(first, backend.endpoint);
    const view = first.getByRole("region", { name: "Remote browser viewer" });
    await expect(view).toHaveAttribute("data-status", "streaming");
    expect(sockets).toBe(1);
    await first.getByLabel("Transport mode").selectOption("split");
    await expect.poll(() => sockets).toBe(3);
    await expect(view).toHaveAttribute("data-status", "streaming");
    await first.locator("summary").filter({ hasText: "Usage" }).click();
    await expect(first.getByLabel("Component code")).toContainText(
      'useState<ViewerTransport>("split")',
    );
    const menu = view.getByRole("button", { name: "Browser menu" });
    await menu.click();
    await expect(
      view
        .getByRole("menu", { name: "Browser menu", exact: true })
        .getByRole("menuitem")
        .first(),
    ).toHaveText("Transport");
    await view
      .getByRole("menuitem", { name: "Transport", exact: true })
      .click();
    const transportMenu = view.getByRole("menu", {
      name: "Transport",
      exact: true,
    });
    await expect(
      transportMenu.getByRole("menuitemradio", {
        name: "Split frame / control",
      }),
    ).toBeChecked();
    await transportMenu
      .getByRole("menuitemradio", { name: "Shared (default)" })
      .click();
    await expect.poll(() => sockets).toBe(4);
    await expect(view).toHaveAttribute("data-status", "streaming");
    await expect(first.getByLabel("Transport mode")).toHaveValue("shared");
    await expect(first.getByLabel("Component code")).toContainText(
      'useState<ViewerTransport>("shared")',
    );
    await expect(first.getByLabel("Component code")).toContainText(
      "onTransportChange={setTransport}",
    );
    await menu.click();
    await view
      .getByRole("menuitem", { name: "Transport", exact: true })
      .click();
    await transportMenu
      .getByRole("menuitemradio", { name: "Split frame / control" })
      .click();
    await expect.poll(() => sockets).toBe(6);
    await expect(view).toHaveAttribute("data-status", "streaming");
    await expect(first.getByLabel("Transport mode")).toHaveValue("split");
    await first.getByLabel("Control mode").selectOption("view-only");
    await expect.poll(() => sockets).toBe(7);
    await expect(view).toHaveAttribute("data-status", "streaming");
    await expect(first.getByLabel("Transport mode")).toBeDisabled();
    await first.getByLabel("Control mode").selectOption("interactive");
    await expect.poll(() => sockets).toBe(9);
    await expect(view).toHaveAttribute("data-status", "streaming");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(first.getByLabel("Transport mode")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await menu.click();
    await view
      .getByRole("menuitem", { name: "Transport", exact: true })
      .click();
    await expect(
      transportMenu.getByRole("menuitemradio", {
        name: "Split frame / control",
      }),
    ).toBeChecked();
    await page.screenshot({
      path: info.outputPath("split-transport-mobile.png"),
    });
  } finally {
    await backend.close();
  }
});

test("demo exposes independent live capture quality and resolution controls", async ({
  page,
}, info) => {
  await openDemo(page);
  const backend = await launchBackend(
    info.outputPath("backend"),
    new URL(demoUrl).origin,
  );
  try {
    const remote = backend.context.pages()[0]!;
    await remote.setViewportSize({ width: 1920, height: 1080 });
    await remote.goto(server.origin + "/fixture/editor");
    const first = panel(page, 1);
    await configure(first, backend.endpoint);
    const view = first.getByRole("region", { name: "Remote browser viewer" });
    await expect(view).toHaveAttribute("data-status", "streaming");
    const proxy = await view.getByLabel("Remote browser input").elementHandle();
    await first
      .locator("summary")
      .filter({ hasText: "Capture quality" })
      .click();
    await first.getByLabel(/^Capture resolution/).selectOption("1280x720");
    await expect
      .poll(() =>
        view
          .locator("canvas")
          .evaluate((canvas: HTMLCanvasElement) => canvas.width),
      )
      .toBe(1280);
    const quality = first.getByRole("slider", { name: /^Image quality/ });
    await quality.press("Home");
    await expect(quality).toHaveValue("0");
    await first.getByText("Usage", { exact: true }).click();
    for (const field of ['"quality":0', '"maxWidth":1280', '"maxHeight":720'])
      await expect(first.getByLabel("Component code")).toContainText(field);
    expect(
      await view
        .getByLabel("Remote browser input")
        .evaluate((element, previous) => element === previous, proxy),
    ).toBe(true);
    await expect(view).toHaveAttribute("data-status", "streaming");
    await page.screenshot({
      path: info.outputPath("capture-controls-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(first.getByLabel(/^Capture resolution/)).toBeVisible();
    await page.screenshot({
      path: info.outputPath("capture-controls-mobile.png"),
      fullPage: true,
    });
  } finally {
    await backend.close();
  }
});

test("demo routes native input and navigation to independent windows", async ({
  page,
  browser,
}, info) => {
  const revision = await openDemo(page);
  const backend = await launchBackend(
    info.outputPath("backend"),
    new URL(demoUrl).origin,
  );
  const captures: { width: number; height: number; completed: boolean }[] = [];
  page.on("websocket", (socket) => {
    if (socket.url() !== backend.endpoint) return;
    const pending = new Map<number, (typeof captures)[number]>();
    socket.on("framesent", ({ payload }) => {
      const command = JSON.parse(String(payload)) as {
        id: number;
        method?: string;
        params?: { maxWidth: number; maxHeight: number };
      };
      if (command.method !== "Page.startScreencast" || !command.params) return;
      const capture = {
        width: command.params.maxWidth,
        height: command.params.maxHeight,
        completed: false,
      };
      captures.push(capture);
      pending.set(command.id, capture);
    });
    socket.on("framereceived", ({ payload }) => {
      const response = JSON.parse(String(payload)) as {
        id?: number;
        error?: unknown;
      };
      if (response.id === undefined) return;
      const capture = pending.get(response.id);
      if (!capture) return;
      capture.completed = response.error === undefined;
      pending.delete(response.id);
    });
  });
  try {
    async function editor() {
      const created = backend.context.waitForEvent("page");
      const target = await backend.session.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      const remote = await created;
      await remote.goto(server.origin + "/fixture/red");
      // The viewport center stays the image center under contain fitting.
      await remote.setContent(`<!doctype html><title>Synthetic demo editor</title>
        <style>html,body{height:100%;margin:0}body{display:grid;place-items:center}
        input{width:240px;height:40px;font:20px sans-serif}</style>
        <input aria-label="Fixture input">`);
      const { windowId } = await backend.session.send(
        "Browser.getWindowForTarget",
        { targetId: target.targetId },
      );
      return { remote, windowId };
    }
    const first = await editor();
    const second = await editor();
    const a = panel(page, 1);
    await configure(a, backend.endpoint, first.windowId);
    await page.getByRole("button", { name: "Add viewer" }).click();
    const b = panel(page, 2);
    await configure(b, backend.endpoint, second.windowId);
    const aView = a.getByRole("region", { name: "Remote browser viewer" });
    const bView = b.getByRole("region", { name: "Remote browser viewer" });
    await expect(aView).toHaveAttribute("data-status", "streaming");
    await expect(bView).toHaveAttribute("data-status", "streaming");
    await expect(aView.getByLabel("Remote browser input")).toBeEnabled();
    await aView.getByRole("img", { name: "Live browser view" }).click();
    await page.keyboard.insertText("first🙂");
    await expect(first.remote.getByLabel("Fixture input")).toHaveValue(
      "first🙂",
    );
    await expect(second.remote.getByLabel("Fixture input")).toHaveValue("");
    await page.keyboard.press("F8");
    await expect(aView.getByRole("tab", { selected: true })).toBeFocused();

    await bView.getByRole("img", { name: "Live browser view" }).click();
    await page.keyboard.type("second");
    await expect(second.remote.getByLabel("Fixture input")).toHaveValue(
      "second",
    );
    await page.screenshot({
      path: info.outputPath("interactive-demo-desktop.png"),
      fullPage: true,
    });
    await a.getByLabel("CDP URL", { exact: true }).fill("wss://draft.invalid/");
    await bView
      .getByLabel("Remote page address")
      .fill(server.origin + "/fixture/blue");
    await expect(second.remote).toHaveURL(server.origin + "/fixture/red");
    await expect(first.remote.getByLabel("Fixture input")).toHaveValue(
      "first🙂",
    );
    await expect(second.remote.getByLabel("Fixture input")).toHaveValue(
      "second",
    );
    await a.getByRole("button", { name: "Remove viewer 1" }).click();
    await expect(a).toHaveCount(0);
    expect(first.remote.isClosed()).toBe(false);
    const beforeResize = captures.length;
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const bounds = await bView.locator("canvas").evaluate((canvas) => {
      const box = canvas.getBoundingClientRect();
      return {
        width: Math.floor(box.width * devicePixelRatio),
        height: Math.floor(box.height * devicePixelRatio),
      };
    });
    // Finish the native resize capture before this navigation/input scenario.
    // Concurrent capture replacement is exercised by capture-navigation.spec.ts.
    await expect
      .poll(() =>
        captures
          .slice(beforeResize)
          .some(
            (capture) =>
              capture.completed &&
              capture.width === bounds.width &&
              capture.height === bounds.height,
          ),
      )
      .toBe(true);
    await bView.getByRole("img", { name: "Live browser view" }).click();
    await page.keyboard.insertText(" alive");
    await expect(second.remote.getByLabel("Fixture input")).toHaveValue(
      "second alive",
    );

    await bView
      .getByLabel("Remote page address")
      .fill(server.origin + "/fixture/blue");
    await bView.getByLabel("Remote page address").press("Enter");
    await expect(second.remote).toHaveURL(server.origin + "/fixture/blue");
    await expectColor(bView, [24, 80, 224]);
    await bView.getByRole("button", { name: "Back remote page" }).click();
    await expect(second.remote).toHaveURL(server.origin + "/fixture/red");
    await bView.getByRole("button", { name: "Forward remote page" }).click();
    await expect(second.remote).toHaveURL(server.origin + "/fixture/blue");
    await second.remote.waitForLoadState();
    const loaded = await second.remote.evaluate(() => performance.timeOrigin);
    const reloaded = second.remote.waitForEvent("load");
    await bView.getByRole("button", { name: "Reload remote page" }).click();
    await reloaded;
    expect(
      await second.remote.evaluate(() => performance.timeOrigin),
    ).toBeGreaterThan(loaded);
    await expectColor(bView, [24, 80, 224]);
    await page.screenshot({
      path: info.outputPath("interactive-demo-mobile.png"),
      fullPage: true,
    });
    const version = await backend.session.send("Browser.getVersion");
    await writeFile(
      info.outputPath("demo-receipt.json"),
      JSON.stringify(
        {
          sourceRevision: revision,
          frontend: process.env.CDP_VIEWER_DEMO_URL
            ? "actual-pages-deployment"
            : "local-production-fixture",
          client: browser.version(),
          backend: version.product,
          backendKind: "test-owned Chromium, allowlisted frontend Origin",
          localNetworkPermission: process.env.CDP_VIEWER_DEMO_URL
            ? "explicitly granted for the owned loopback endpoint"
            : "not required for loopback HTTP frontend",
          pointer: true,
          nativeText: true,
          navigation: true,
          localFocusIsolation: true,
          differentWindows: true,
          survivingPanelInput: true,
          systemIme: "unverified",
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

test("page appearance controls drive inherited viewer colors without reconnecting", async ({
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
    await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/red",
      newWindow: true,
    });
    const a = panel(page, 1);
    const appearance = page.getByRole("combobox", { name: "Appearance" });
    const chrome = (root: Locator) =>
      root.evaluate((element) => {
        const style = getComputedStyle(element);
        const toolbar = element.querySelector(".cdpv-toolbar")!;
        const navigation = element.querySelector(".cdpv-navigation")!;
        const address = element.querySelector(".cdpv-address")!;
        const stage = element.querySelector(".cdpv-stage")!;
        return {
          background: style.backgroundColor,
          foreground: style.color,
          border: style.borderColor,
          radius: style.borderRadius,
          tabs: getComputedStyle(toolbar).backgroundColor,
          toolbarHeight: toolbar.getBoundingClientRect().height,
          navigationHeight: navigation.getBoundingClientRect().height,
          address: getComputedStyle(address).backgroundColor,
          addressHeight: address.getBoundingClientRect().height,
          stage: getComputedStyle(stage).backgroundColor,
        };
      });
    const placeholder = a.locator(".demo-disconnected");
    const colors = new Map<string, Awaited<ReturnType<typeof chrome>>>();
    for (const scheme of ["light", "dark"]) {
      await appearance.selectOption(scheme);
      const preview = await chrome(placeholder);
      colors.set(scheme, preview);
      await expect(a).toHaveCSS("background-color", preview.background);
      await expect(a).toHaveCSS("color", preview.foreground);
      await expect(a).toHaveCSS("border-color", preview.border);
    }
    expect(sockets).toBe(0);
    await expect(
      placeholder.locator("button,input,textarea,select,[tabindex]"),
    ).toHaveCount(0);
    await configure(a, backend.endpoint);
    const view = a.getByRole("region", { name: "Remote browser viewer" });
    await expect(view).toHaveAttribute("data-status", "streaming");
    const original = await view
      .getByLabel("Remote browser input")
      .elementHandle();
    const opened = sockets;
    await appearance.selectOption("dark");
    await expect(view).toHaveCSS("background-color", "rgb(53, 54, 58)");
    expect(await chrome(view)).toEqual(colors.get("dark"));
    await page.screenshot({
      path: info.outputPath("demo-dark.png"),
      fullPage: true,
    });
    await appearance.selectOption("light");
    await expect(view).toHaveCSS("background-color", "rgb(255, 255, 255)");
    expect(await chrome(view)).toEqual(colors.get("light"));
    await page.screenshot({
      path: info.outputPath("demo-light.png"),
      fullPage: true,
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await appearance.selectOption("system");
    await expect(view).toHaveCSS("background-color", "rgb(53, 54, 58)");
    expect(sockets).toBe(opened);
    expect(
      await view
        .getByLabel("Remote browser input")
        .evaluate((element, old) => element === old, original),
    ).toBe(true);
  } finally {
    await backend.close();
  }
});

test("playground changes live props independently and observes safe callbacks", async ({
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
    const selected = await view
      .getByRole("tab", { selected: true })
      .getAttribute("data-target-id");
    const original = await view
      .getByLabel("Remote browser input")
      .elementHandle();
    const opened = sockets;
    await a.getByRole("button", { name: "Pause stream", exact: true }).click();
    await expect(view).toHaveAttribute("data-status", "paused");
    await a.getByRole("button", { name: "Resume stream", exact: true }).click();
    await expectColor(view, [232, 32, 48]);
    await a
      .locator("summary")
      .filter({ hasText: "Appearance & layout" })
      .click();
    await a.getByLabel(/^Viewer theme/).selectOption("dark");
    await expect(view).toHaveCSS("background-color", "rgb(53, 54, 58)");
    await a.getByRole("slider", { name: "Height", exact: true }).fill("520");
    await a.getByRole("slider", { name: "Width", exact: true }).fill("75");
    await a.getByRole("slider", { name: "Corner radius" }).fill("20");
    await a.getByRole("checkbox", { name: /Framed presentation/ }).check();
    await a.getByRole("checkbox", { name: "Custom accent" }).check();
    await a.getByLabel("Accent color", { exact: true }).fill("#b84a37");
    await expect(view).toHaveCSS("height", "520px");
    await expect(view).toHaveClass(/demo-viewer-framed/);
    expect(
      await view.evaluate((element) =>
        element.style.getPropertyValue("--cdpv-radius"),
      ),
    ).toBe("20px");
    expect(
      await view.evaluate((element) =>
        element.style.getPropertyValue("--cdpv-accent"),
      ),
    ).toBe("#b84a37");
    await view.getByRole("button", { name: "Reload remote page" }).press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(
      view.getByRole("button", { name: "Reload remote page" }),
    ).toBeFocused();
    await expect(
      view.getByRole("button", { name: "Reload remote page" }),
    ).toHaveCSS("outline-color", "rgb(184, 74, 55)");
    expect(sockets).toBe(opened);
    expect(
      await view
        .getByLabel("Remote browser input")
        .evaluate((element, old) => element === old, original),
    ).toBe(true);
    await expect(view.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-target-id",
      selected!,
    );
    const logs = a.locator(".demo-console");
    await logs.locator(":scope > summary").click();
    await logs.getByText("Viewer 1 current state", { exact: true }).click();
    const summary = logs.getByLabel("Viewer 1 current status summary");
    await expect(summary).toContainText('"status": "streaming"');
    await expect(summary).toContainText('"targetCount": 1');
    await expect(summary).not.toContainText(target.targetId);
    await expect(summary).not.toContainText(server.origin);
    await a.locator("summary").filter({ hasText: "Usage" }).click();
    await expect(a.getByLabel("Component code")).toContainText(
      `windowId={${scope.windowId}}`,
    );
    await expect(a.getByLabel("Component code")).not.toContainText(
      backend.endpoint,
    );
    await a
      .getByLabel("CDP URL", { exact: true })
      .fill("wss://draft.invalid/?token=synthetic");
    await a.getByLabel(/^Window ID/).fill("-1");
    await a.getByLabel("Control mode").selectOption("view-only");
    await expect(view).toHaveAttribute("data-status", "streaming");
    await expect(view.getByLabel("Remote browser input")).toHaveCount(0);
    expect(sockets).toBe(opened + 1);
    await expect(view.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-target-id",
      selected!,
    );
    await expect(a.getByLabel("Component code")).toContainText(
      `windowId={${scope.windowId}}`,
    );
    await page.getByRole("button", { name: "Add viewer" }).click();
    const b = panel(page, 2);
    await b
      .locator("summary")
      .filter({ hasText: "Appearance & layout" })
      .click();
    await expect(b.getByLabel(/^Viewer theme/)).toHaveValue("inherit");
    await expect(
      b.getByRole("checkbox", { name: /Framed presentation/ }),
    ).not.toBeChecked();
    await expect(b.getByLabel("Control mode")).toHaveValue("interactive");
    await page.screenshot({
      path: info.outputPath("playground-props.png"),
      fullPage: true,
    });
  } finally {
    await backend.close();
  }
});

test.describe("controlled window-size synchronization", () => {
  test.use({ deviceScaleFactor: 2 });

  test("demo controls and menu share the mode while live resizing preserves input ownership", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await openDemo(page);
    const backend = await launchNativeBackend(new URL(demoUrl).origin, true, 1);
    // Retain native sizing and frame messages in failure traces without changing them.
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => upstream.send(message));
      upstream.onMessage((message) => socket.send(message));
    });
    let sockets = 0;
    page.on("websocket", () => {
      sockets++;
    });
    try {
      const created = backend.context.waitForEvent("page");
      const target = await backend.session.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      const remote = await created;
      await remote.setContent(`<!doctype html><title>Window sync fixture</title>
        <style>html,body{height:100%;margin:0}body{display:grid;place-items:center}input{width:240px;height:40px;font:20px sans-serif}</style>
        <input aria-label="Fixture input">`);
      const scope = await backend.session.send("Browser.getWindowForTarget", {
        targetId: target.targetId,
      });
      const a = panel(page, 1);
      await a
        .locator("summary")
        .filter({ hasText: "Appearance & layout" })
        .click();
      const mode = a.getByLabel(/^Window size sync/);
      await expect(mode).toHaveValue("off");
      await configure(a, backend.endpoint, scope.windowId);
      const view = a.getByRole("region", { name: "Remote browser viewer" });
      await expect(view).toHaveAttribute("data-status", "streaming");
      const input = await view
        .getByLabel("Remote browser input")
        .elementHandle();
      const opened = sockets;
      const canvas = view.locator("canvas");
      const menu = view.getByRole("button", { name: "Browser menu" });
      const remoteSize = () =>
        remote.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        }));
      const expectFit = async () => {
        const box = (await canvas.boundingBox())!;
        const logical = {
          width: Math.floor(box.width),
          height: Math.floor(box.height),
          dpr: 2,
        };
        await expect.poll(remoteSize).toEqual(logical);
        await expect
          .poll(() =>
            canvas.evaluate((element: HTMLCanvasElement) => ({
              width: element.width,
              height: element.height,
            })),
          )
          .toEqual({ width: logical.width * 2, height: logical.height * 2 });
        return logical;
      };
      await menu.click();
      await view.getByRole("menuitem", { name: "Fit to this viewer" }).click();
      await expect(
        view.getByRole("menuitemradio", { name: "Do not sync automatically" }),
      ).toHaveAttribute("aria-checked", "true");
      await view
        .getByRole("menuitemradio", { name: "Sync once on opening" })
        .click();
      await expect(mode).toHaveValue("initial");
      await expectFit();
      await a.locator("summary").filter({ hasText: "Usage" }).click();
      await expect(a.getByLabel("Component code")).toContainText(
        'useState<WindowSizeSync>("initial")',
      );
      await expect(a.getByLabel("Component code")).toContainText(
        "onWindowSizeSyncChange={setWindowSizeSync}",
      );
      const logs = a.locator(".demo-console");
      await logs.locator(":scope > summary").click();
      const activity = logs.getByRole("list", {
        name: "Viewer 1 console logs",
        exact: true,
      });
      await expect(activity).toContainText("onWindowSizeSyncChange");
      await expect(activity).toContainText("Mode requested: initial");

      await mode.selectOption("live");
      await menu.click();
      await view.getByRole("menuitem", { name: "Fit to this viewer" }).click();
      await expect(
        view.getByRole("menuitemradio", { name: "Sync continuously" }),
      ).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(a.getByLabel("Component code")).toContainText(
        'useState<WindowSizeSync>("live")',
      );
      const handle = a.getByRole("button", {
        name: "Resize viewer 1",
        exact: true,
      });
      const corner = (await handle.boundingBox())!;
      const initial = (await view.boundingBox())!;
      const start = {
        x: corner.x + corner.width / 2,
        y: corner.y + corner.height / 2,
      };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x - initial.width * 0.2, start.y + 83, {
        steps: 8,
      });
      await page.mouse.up();
      await expect(view).toHaveCSS("height", "443px");
      const fitted = await expectFit();

      await menu.click();
      await view.getByRole("menuitem", { name: "Fit to this viewer" }).click();
      await view
        .getByRole("menuitemradio", { name: "Do not sync automatically" })
        .click();
      await expect(mode).toHaveValue("off");
      await expect(activity).toContainText("Mode requested: off");
      await expect(a.getByLabel("Component code")).toContainText(
        'useState<WindowSizeSync>("off")',
      );
      await handle.press("ArrowLeft");
      await handle.press("Shift+ArrowDown");
      await expect(view).toHaveCSS("height", "483px");
      expect(await remoteSize()).toEqual(fitted);
      await menu.click();
      await view
        .getByRole("menuitem", { name: "Fit page to viewer", exact: true })
        .click();
      await expectFit();
      await expect(mode).toHaveValue("off");

      await expect(view.getByLabel("Remote browser input")).toBeEnabled();
      expect(
        await view
          .getByLabel("Remote browser input")
          .evaluate((node, original) => node === original, input),
      ).toBe(true);
      await expect(view.getByRole("tab", { selected: true })).toHaveAttribute(
        "data-target-id",
        target.targetId,
      );
      expect(sockets).toBe(opened);
      await view.getByRole("img", { name: "Live browser view" }).click();
      await page.keyboard.insertText("after sync");
      await expect(remote.getByLabel("Fixture input")).toHaveValue(
        "after sync",
      );
      await page.keyboard.press("F8");
      await page.getByRole("button", { name: "Add viewer" }).click();
      const b = panel(page, 2);
      await b
        .locator("summary")
        .filter({ hasText: "Appearance & layout" })
        .click();
      await expect(b.getByLabel(/^Window size sync/)).toHaveValue("off");
      await b.getByLabel(/^Window size sync/).selectOption("initial");
      await expect(mode).toHaveValue("off");
      expect(sockets).toBe(opened);
      await page.screenshot({
        path: info.outputPath("controlled-window-sync.png"),
        fullPage: true,
      });
    } finally {
      await backend.close();
    }
  });
});

test("corner dragging resizes the live viewer without remote input or reconnection", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
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
    const created = backend.context.waitForEvent("page");
    const target = await backend.session.send("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    });
    const remote = await created;
    await remote.setContent(`<!doctype html><title>Resize fixture</title>
      <style>html,body{height:100%;margin:0}body{display:grid;place-items:center}input{width:240px;height:40px;font:20px sans-serif}</style>
      <input aria-label="Fixture input">
      <script>window.resizeInput={pointer:0,key:0};document.addEventListener('pointerdown',()=>window.resizeInput.pointer++);document.addEventListener('keydown',()=>window.resizeInput.key++);</script>`);
    const scope = await backend.session.send("Browser.getWindowForTarget", {
      targetId: target.targetId,
    });
    const a = panel(page, 1);
    await configure(a, backend.endpoint, scope.windowId);
    const view = a.getByRole("region", { name: "Remote browser viewer" });
    await expect(view).toHaveAttribute("data-status", "streaming");
    await expect(view.getByLabel("Remote browser input")).toBeEnabled();
    const input = await view.getByLabel("Remote browser input").elementHandle();
    const selected = await view
      .getByRole("tab", { selected: true })
      .getAttribute("data-target-id");
    const originalSockets = sockets;
    const originalBounds = await backend.session.send(
      "Browser.getWindowBounds",
      { windowId: scope.windowId },
    );
    await a
      .locator("summary")
      .filter({ hasText: "Appearance & layout" })
      .click();
    const handle = a.getByRole("button", {
      name: "Resize viewer 1",
      exact: true,
    });
    const corner = (await handle.boundingBox())!;
    const initial = (await view.boundingBox())!;
    const start = {
      x: corner.x + corner.width / 2,
      y: corner.y + corner.height / 2,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await expect(handle).toHaveAttribute("data-resizing", "true");
    await page.mouse.move(start.x - initial.width * 0.2, start.y + 137, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(handle).toHaveAttribute("data-resizing", "false");
    await expect(view).toHaveCSS("height", "497px");
    await expect(
      a.getByRole("slider", { name: "Height", exact: true }),
    ).toHaveValue("497");
    await expect(
      a.getByRole("slider", { name: "Width", exact: true }),
    ).toHaveValue("80");
    expect(
      Math.abs((await view.boundingBox())!.width - initial.width * 0.8),
    ).toBeLessThan(1);
    await handle.press("ArrowLeft");
    await handle.press("Shift+ArrowUp");
    await expect(view).toHaveCSS("height", "457px");
    await expect(
      a.getByRole("slider", { name: "Width", exact: true }),
    ).toHaveValue("79");
    await a.locator("summary").filter({ hasText: "Usage" }).click();
    await expect(a.getByLabel("Component code")).toContainText('"height": 457');
    await expect(a.getByLabel("Component code")).toContainText(
      '"width": "79%"',
    );
    expect(sockets).toBe(originalSockets);
    expect(
      await view
        .getByLabel("Remote browser input")
        .evaluate((node, original) => node === original, input),
    ).toBe(true);
    await expect(view.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-target-id",
      selected!,
    );
    expect(
      await backend.session.send("Browser.getWindowBounds", {
        windowId: scope.windowId,
      }),
    ).toEqual(originalBounds);
    expect(
      await remote.evaluate(() => Reflect.get(window, "resizeInput")),
    ).toEqual({ pointer: 0, key: 0 });
    await view.getByRole("img", { name: "Live browser view" }).click();
    await page.keyboard.insertText("after resize");
    await expect(remote.getByLabel("Fixture input")).toHaveValue(
      "after resize",
    );
    await page.keyboard.press("F8");
    await page.getByRole("button", { name: "Add viewer" }).click();
    await expect(panel(page, 2).locator(".demo-disconnected")).toHaveCSS(
      "height",
      "360px",
    );
    await a.getByRole("slider", { name: "Height", exact: true }).fill("520");
    await expect(view).toHaveCSS("height", "520px");
    expect(sockets).toBe(originalSockets);
  } finally {
    await backend.close();
  }
});

test("resize capture ends on Escape and capture loss, with native touch on narrow panels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openDemo(page);
  const a = panel(page, 1);
  await a.locator("summary").filter({ hasText: "Appearance & layout" }).click();
  const handle = a.getByRole("button", {
    name: "Resize viewer 1",
    exact: true,
  });
  const height = a.getByRole("slider", { name: "Height", exact: true });
  const width = a.getByRole("slider", { name: "Width", exact: true });
  let corner = (await handle.boundingBox())!;
  await page.mouse.move(
    corner.x + corner.width / 2,
    corner.y + corner.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(corner.x - 120, corner.y + 32);
  await page.keyboard.press("Escape");
  await expect(handle).toHaveAttribute("data-resizing", "false");
  const stopped = {
    height: await height.inputValue(),
    width: await width.inputValue(),
  };
  await page.mouse.move(corner.x - 240, corner.y + 80);
  await page.mouse.up();
  await expect(height).toHaveValue(stopped.height);
  await expect(width).toHaveValue(stopped.width);

  await handle.evaluate((button) =>
    button.addEventListener(
      "gotpointercapture",
      (event) => {
        if (event instanceof PointerEvent)
          button.dataset.capturedPointer = String(event.pointerId);
      },
      { once: true },
    ),
  );
  corner = (await handle.boundingBox())!;
  await page.mouse.move(
    corner.x + corner.width / 2,
    corner.y + corner.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(corner.x - 40, corner.y + 25);
  await expect(handle).toHaveAttribute("data-captured-pointer", /^\d+$/);
  const pointer = Number(await handle.getAttribute("data-captured-pointer"));
  const released = await height.inputValue();
  await handle.evaluate(
    (button, pointerId) => button.releasePointerCapture(pointerId),
    pointer,
  );
  // Chromium processes pending capture loss before the next pointer event.
  await page.mouse.move(corner.x - 80, corner.y + 75);
  await expect(handle).toHaveAttribute("data-resizing", "false");
  await page.mouse.up();
  await expect(height).toHaveValue(released);

  corner = (await handle.boundingBox())!;
  await page.mouse.move(
    corner.x + corner.width / 2,
    corner.y + corner.height / 2,
  );
  await page.mouse.down();
  const outside = {
    x: (await a.boundingBox())!.x + 20,
    y: corner.y + corner.height / 2 + 25,
  };
  await page.mouse.move(outside.x, outside.y);
  await expect(width).toHaveValue("50");
  await expect(handle).toHaveAttribute("data-resizing", "true");
  expect(outside.x).toBeLessThan((await handle.boundingBox())!.x);
  await page.mouse.up();
  await expect(handle).toHaveAttribute("data-resizing", "false");
  const completed = await height.inputValue();
  await page.mouse.move(outside.x + 100, outside.y + 100);
  await expect(height).toHaveValue(completed);
  await expect(width).toHaveValue("50");
  await width.fill("80");

  await page.setViewportSize({ width: 390, height: 844 });
  await handle.scrollIntoViewIfNeeded();
  corner = (await handle.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  try {
    await touch.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    const start = {
      x: corner.x + corner.width / 2,
      y: corner.y + corner.height / 2,
    };
    const beforeHeight = Number(await height.inputValue());
    const beforeWidth = Number(await width.inputValue());
    const scroll = await page.evaluate(() => scrollY);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...start, id: 1 }],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: start.x - 30, y: start.y + 30, id: 1 }],
    });
    await expect(height).toHaveValue(String(beforeHeight + 30));
    expect(Number(await width.inputValue())).toBeLessThan(beforeWidth);
    expect(await page.evaluate(() => scrollY)).toBe(scroll);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await expect(handle).toHaveAttribute("data-resizing", "false");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await touch.detach();
  }
});

test("preview stage retains its initial height when viewers shrink", async ({
  page,
}) => {
  await openDemo(page);
  const a = panel(page, 1);
  await a.locator("summary").filter({ hasText: "Appearance & layout" }).click();
  const height = a.getByRole("slider", { name: "Height", exact: true });
  const initialHeight = await height.inputValue();
  const view = a.locator(".demo-disconnected");
  const stage = a.locator(".demo-stage");
  const handle = a.getByRole("button", {
    name: "Resize viewer 1",
    exact: true,
  });

  for (const { width, viewers } of [
    { width: 1440, viewers: 1 },
    { width: 800, viewers: 1 },
    { width: 390, viewers: 1 },
    { width: 1280, viewers: 2 },
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    if (viewers === 2)
      await page.getByRole("button", { name: "Add viewer" }).click();
    await height.fill(initialHeight);
    await expect(view).toHaveCSS("height", `${initialHeight}px`);
    const initial = (await stage.boundingBox())!;
    const expectFloor = async () => {
      await expect
        .poll(async () =>
          Math.abs((await stage.boundingBox())!.height - initial.height),
        )
        .toBeLessThan(1);
    };

    await handle.scrollIntoViewIfNeeded();
    const corner = (await handle.boundingBox())!;
    const x = corner.x + corner.width / 2;
    const y = corner.y + corner.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 240 - Number(initialHeight));
    await page.mouse.up();
    await expect(view).toHaveCSS("height", "240px");
    await expectFloor();

    await height.fill("520");
    await expect(view).toHaveCSS("height", "520px");
    expect((await stage.boundingBox())!.height).toBeGreaterThan(initial.height);
    await height.fill("240");
    await expect(view).toHaveCSS("height", "240px");
    await expectFloor();
    expect(
      Math.abs((await stage.boundingBox())!.width - initial.width),
    ).toBeLessThan(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (viewers === 2)
      await expect(panel(page, 2).locator(".demo-disconnected")).toHaveCSS(
        "height",
        `${initialHeight}px`,
      );
  }
});

test("settings disclosure keeps preview height stable and overflow reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openDemo(page);
  const a = panel(page, 1);
  const preview = a.locator(".demo-preview");
  const stage = a.locator(".demo-stage");
  const settings = a.getByRole("complementary", {
    name: "Viewer 1 properties",
  });
  const groups = await settings.locator(":scope > details").all();
  const surfaces = [a, preview, stage];
  const heights = () =>
    Promise.all(
      surfaces.map(async (surface) => (await surface.boundingBox())!.height),
    );
  async function expectHeights(expected: number[]) {
    await expect
      .poll(async () =>
        Math.max(
          ...(await heights()).map((height, i) =>
            Math.abs(height - expected[i]!),
          ),
        ),
      )
      .toBeLessThan(1);
  }
  async function expectWithinRail(control: Locator) {
    await expect(control).toBeInViewport();
    const bounds = (await control.boundingBox())!;
    const rail = (await settings.boundingBox())!;
    // Native scrolling rounds offsets when the Grid row has a fractional size.
    expect(bounds.y).toBeGreaterThanOrEqual(rail.y - 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      rail.y + rail.height + 1,
    );
  }

  const initial = await heights();
  for (const group of groups) {
    if ((await group.getAttribute("open")) === null) {
      await group.locator(":scope > summary").click();
      await expectHeights(initial);
    }
  }
  expect(
    await settings.evaluate((rail) => rail.scrollHeight > rail.clientHeight),
  ).toBe(true);
  const usage = settings.locator("summary").filter({ hasText: "Usage" });
  await usage.focus();
  await expect(usage).toBeFocused();
  await expectWithinRail(usage);
  expect(await settings.evaluate((rail) => rail.scrollTop)).toBeGreaterThan(0);
  await usage.press("Space");
  await expectHeights(initial);
  await usage.press("Space");
  await expectHeights(initial);
  const code = a.getByLabel("Component code");
  await code.scrollIntoViewIfNeeded();
  await expectWithinRail(code);

  await a.getByLabel("Height", { exact: true }).fill("800");
  await expect(a.locator(".demo-disconnected")).toHaveCSS("height", "800px");
  const tall = await heights();
  expect(tall[2]!).toBeGreaterThan(initial[2]!);
  expect(
    Math.abs((await settings.boundingBox())!.height - tall[1]!),
  ).toBeLessThan(1);
  for (const group of groups) {
    await group.locator(":scope > summary").click();
    await expectHeights(tall);
  }

  const appearance = settings
    .locator("summary")
    .filter({ hasText: "Appearance & layout" });
  await appearance.click();
  await a.getByLabel("Height", { exact: true }).fill("360");
  await appearance.click();
  await expectHeights(initial);

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowPreview = (await preview.boundingBox())!.height;
  const closedSettings = (await settings.boundingBox())!.height;
  for (const group of groups) {
    await group.locator(":scope > summary").click();
    expect((await preview.boundingBox())!.height).toBe(narrowPreview);
  }
  expect((await settings.boundingBox())!.height).toBeGreaterThan(
    closedSettings,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Add viewer" }).click();
  const b = panel(page, 2);
  const siblingHeight = (await b.boundingBox())!.height;
  const stackedPreview = (await preview.boundingBox())!;
  expect((await settings.boundingBox())!.y).toBeGreaterThanOrEqual(
    stackedPreview.y + stackedPreview.height,
  );
  for (const group of groups) {
    await group.locator(":scope > summary").click();
    expect((await preview.boundingBox())!.height).toBe(stackedPreview.height);
    expect((await b.boundingBox())!.height).toBe(siblingHeight);
  }
});

test("playground layout keeps the preview and controls usable across appearances and narrow screens", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openDemo(page);
  const a = panel(page, 1);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    a.getByText("Ready when you are.", { exact: true }),
  ).toBeVisible();
  const placeholder = a.locator(".demo-disconnected");
  await expect(placeholder.locator(".cdpv-tab-title")).toHaveText("New tab");
  await expect(placeholder.locator(".cdpv-navigation")).toBeVisible();
  await expect(
    placeholder.locator("button,input,textarea,select,[tabindex]"),
  ).toHaveCount(0);
  const stage = a.locator(".demo-stage");
  const settings = a.getByRole("complementary", {
    name: "Viewer 1 properties",
  });
  const stageBounds = await stage.boundingBox();
  const settingsBounds = await settings.boundingBox();
  expect(stageBounds!.x + stageBounds!.width).toBeLessThanOrEqual(
    settingsBounds!.x + 1,
  );
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("light");
  await page.getByRole("button", { name: "Add viewer" }).hover();
  await expect(a.locator(".demo-disconnected")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await page.screenshot({
    path: info.outputPath("playground-light.png"),
    fullPage: true,
  });
  await page.getByRole("combobox", { name: "Appearance", exact: true }).hover();
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("dark");
  await expect(a.locator(".demo-disconnected")).toHaveCSS(
    "background-color",
    "rgb(53, 54, 58)",
  );
  await expect(page.getByRole("button", { name: "Add viewer" })).toHaveCSS(
    "background-color",
    "rgb(138, 180, 248)",
  );
  await page.screenshot({
    path: info.outputPath("playground-dark.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Add viewer" }).click();
  await expect(panel(page, 2)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  const firstPanel = await a.boundingBox();
  const secondPanel = await panel(page, 2).boundingBox();
  expect(Math.abs(firstPanel!.y - secondPanel!.y)).toBeLessThan(1);
  expect(secondPanel!.x).toBeGreaterThan(firstPanel!.x);
  await page.screenshot({
    path: info.outputPath("playground-two-viewers.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Remove viewer 2" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await a.locator("summary").filter({ hasText: "Appearance & layout" }).click();
  await a.locator("summary").filter({ hasText: "Usage" }).click();
  await expect(a.getByLabel("Component code")).toContainText("cdpUrl={cdpUrl}");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const narrowStage = await stage.boundingBox();
  const narrowSettings = await settings.boundingBox();
  expect(narrowStage!.y + narrowStage!.height).toBeLessThanOrEqual(
    narrowSettings!.y,
  );
  await page.screenshot({
    path: info.outputPath("playground-mobile-dark.png"),
    fullPage: true,
  });
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("light");
  await expect(page.getByRole("button", { name: "Add viewer" })).toHaveCSS(
    "background-color",
    "rgb(26, 115, 232)",
  );
  await page.screenshot({
    path: info.outputPath("playground-mobile-light.png"),
    fullPage: true,
  });
  await a.getByRole("checkbox", { name: "Show settings menu" }).uncheck();
  await expect(placeholder.locator(".cdpv-browser-menu-trigger")).toHaveCount(
    0,
  );
  await a.getByRole("checkbox", { name: "Show settings menu" }).check();
  await expect(placeholder.locator(".cdpv-browser-menu-trigger")).toHaveCount(
    1,
  );
  await a.getByLabel("Control mode").selectOption("view-only");
  await expect(placeholder.locator(".cdpv-navigation")).toHaveCount(0);
  await expect(placeholder.locator(".cdpv-new-tab,.cdpv-close")).toHaveCount(0);
  await expect(placeholder).toHaveCSS("height", "360px");
  await a.getByLabel("Control mode").selectOption("interactive");
  await a.getByLabel(/^Viewer theme/).selectOption("dark");
  await expect(placeholder).toHaveCSS("background-color", "rgb(53, 54, 58)");
  await expect(a).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.emulateMedia({ colorScheme: "light" });
  await a.getByLabel(/^Viewer theme/).selectOption("system");
  await expect(placeholder).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(placeholder).toHaveCSS("background-color", "rgb(53, 54, 58)");
  await a.getByLabel("Height", { exact: true }).fill("240");
  await a.getByLabel("Width", { exact: true }).fill("50");
  await expect(placeholder).toHaveCSS("height", "240px");
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await placeholder.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: info.outputPath("playground-mobile-minimum.png"),
    fullPage: true,
  });
  await expect(
    a.getByRole("region", { name: "Remote browser viewer" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

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
    await a.getByRole("checkbox", { name: "Browser Use" }).check();
    await configure(a, backend.endpoint, aWindow.windowId);
    const aView = a.getByRole("region", { name: "Remote browser viewer" });
    await expectColor(aView, [232, 32, 48]);
    await page.getByRole("button", { name: "Add viewer" }).click();
    const b = panel(page, 2);
    await expect(
      b.getByRole("checkbox", { name: "Browser Use" }),
    ).not.toBeChecked();
    await configure(b, backend.endpoint, bWindow.windowId);
    const bView = b.getByRole("region", { name: "Remote browser viewer" });
    await expectColor(bView, [24, 80, 224]);
    await expect(aView.getByRole("tab")).toHaveCount(1);
    await expect(bView.getByRole("tab")).toHaveCount(1);
    await page.screenshot({
      path: info.outputPath("two-window-demo.png"),
      fullPage: true,
    });

    const opened = sockets.length;
    await a
      .getByLabel("CDP URL", { exact: true })
      .fill("wss://draft.invalid/?token=synthetic");
    await a.getByLabel(/^Window ID/).fill("-1");
    await a.getByRole("checkbox", { name: "Browser Use" }).uncheck();
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
    await expect(aView.getByRole("tab")).toHaveCount(0);
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
          optionalExtensionConfiguration: true,
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
    await expect(view.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-target-id",
      target.targetId,
    );
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
    await expect(view.getByRole("tab")).toHaveCount(0);
    expect(sockets).toBeGreaterThan(0);
    await window.fill("");
    await a
      .getByRole("button", { name: "Apply & connect", exact: true })
      .click();
    await expect(view.getByRole("tab").filter({ hasText: "rgb(" })).toHaveCount(
      2,
    );
    await view.locator(`[data-target-id="${red.targetId}"]`).click();
    await expectColor(view, [232, 32, 48]);
    await view.locator(`[data-target-id="${blue.targetId}"]`).click();
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

test("each viewer owns an independent collapsible console with safe error details", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openDemo(page);
  const a = panel(page, 1);
  const logs = a.locator(".demo-console");
  const toggle = logs.locator(":scope > summary");
  await expect(logs).toHaveAccessibleName("Viewer 1 console");
  await expect(logs).not.toHaveAttribute("open");
  await expect(page.getByText("State & events", { exact: true })).toHaveCount(
    0,
  );
  const backend = await launchBackend(
    info.outputPath("backend"),
    new URL(demoUrl).origin,
  );
  let sockets = 0;
  page.on("websocket", () => sockets++);
  try {
    const target = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/red",
      newWindow: true,
    });
    const scope = await backend.session.send("Browser.getWindowForTarget", {
      targetId: target.targetId,
    });
    let firstConnection = true;
    await page.routeWebSocket(backend.endpoint, (socket) => {
      // Keep only the original viewer's discovery failed until it reconnects.
      // Sibling target events must not recover this controlled error fixture.
      const failDiscovery = firstConnection;
      firstConnection = false;
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as {
          id: number;
          method: string;
        };
        if (failDiscovery && command.method === "Target.getTargets") {
          socket.send(
            JSON.stringify({
              id: command.id,
              error: {
                code: -32000,
                message: "private provider token=synthetic",
                data: { private: "fixture" },
              },
            }),
          );
        } else upstream.send(message);
      });
    });
    await configure(a, backend.endpoint);
    const view = a.getByRole("region", { name: "Remote browser viewer" });
    await expect(view).toHaveAttribute("data-status", "unavailable");
    await page.getByRole("button", { name: "Add viewer" }).click();
    const b = panel(page, 2);
    const siblingLogs = b.locator(".demo-console");
    const siblingToggle = siblingLogs.locator(":scope > summary");
    await expect(page.locator(".demo-console")).toHaveCount(2);
    await expect(siblingLogs).toHaveAccessibleName("Viewer 2 console");
    await configure(b, backend.endpoint, scope.windowId);
    const sibling = b.getByRole("region", { name: "Remote browser viewer" });
    await expectColor(sibling, [232, 32, 48]);
    const originalInput = await sibling
      .getByLabel("Remote browser input")
      .elementHandle();
    const opened = sockets;
    const initial = (await a.locator(".demo-preview").boundingBox())!;
    const siblingInitial = (await b.locator(".demo-preview").boundingBox())!;
    const siblingPanelHeight = (await b.boundingBox())!.height;
    const panelBounds = (await a.locator(".demo-panel-body").boundingBox())!;
    const consoleBounds = (await logs.boundingBox())!;
    expect(consoleBounds.y).toBeGreaterThanOrEqual(
      panelBounds.y + panelBounds.height - 1,
    );
    expect(
      Math.abs(consoleBounds.width - (await a.boundingBox())!.width + 2),
    ).toBeLessThan(1);
    await expect(toggle).toContainText("1 error");
    await expect(siblingToggle).not.toContainText("1 error");
    await expect(logs).not.toHaveAttribute("open");
    await expect(siblingLogs).not.toHaveAttribute("open");
    await toggle.focus();
    await toggle.press("Enter");
    await expect(logs).toHaveAttribute("open", "");
    await expect(siblingLogs).not.toHaveAttribute("open");
    expect((await b.boundingBox())!.height).toBe(siblingPanelHeight);
    const current = logs.getByRole("region", {
      name: "Viewer 1 current error",
      exact: true,
    });
    await expect(current).toContainText("CDP request failed.");
    await expect(current).toContainText("Target.getTargets");
    await expect(current).toContainText("-32000");
    await expect(
      siblingLogs.getByRole("region", {
        name: "Viewer 2 current error",
        exact: true,
      }),
    ).toHaveCount(0);
    const activity = logs.getByRole("list", {
      name: "Viewer 1 console logs",
      exact: true,
    });
    await expect(logs).not.toContainText("Viewer 2");
    const errorRow = activity
      .locator("li")
      .filter({ hasText: "onError" })
      .first();
    const errorSequence = await errorRow
      .locator(".demo-console-sequence")
      .innerText();
    const errorEvent = activity
      .locator("li")
      .filter({
        has: page.getByText(errorSequence, { exact: true }),
      })
      .filter({ hasText: "onError" });
    await errorEvent.locator("summary").click();
    await expect(
      errorEvent.getByLabel("Viewer 1 onError event details"),
    ).toContainText('"method": "Target.getTargets"');
    await expect(
      errorEvent.getByLabel("Viewer 1 onError event details"),
    ).toContainText('"code": -32000');
    const statusEvent = activity
      .locator("li")
      .filter({ hasText: "onStatusChange" })
      .first();
    await statusEvent.locator("summary").click();
    await expect(
      statusEvent.getByLabel("Viewer 1 onStatusChange event details"),
    ).toContainText('"targetCount": 0');
    await logs.getByText("Viewer 1 current state", { exact: true }).click();
    await expect(
      logs.getByLabel("Viewer 1 current status summary"),
    ).toContainText('"method": "Target.getTargets"');
    await expect(logs).not.toContainText(/private|token=|sessionId|params/);
    expect(
      Math.abs(
        (await a.locator(".demo-preview").boundingBox())!.height -
          initial.height,
      ),
    ).toBeLessThan(1);
    expect(
      Math.abs(
        (await b.locator(".demo-preview").boundingBox())!.height -
          siblingInitial.height,
      ),
    ).toBeLessThan(1);
    await siblingToggle.click();
    await expect(siblingLogs).toHaveAttribute("open", "");
    await expect(logs).toHaveAttribute("open", "");
    const siblingActivity = siblingLogs.getByRole("list", {
      name: "Viewer 2 console logs",
      exact: true,
    });
    await expect(siblingActivity).toContainText("onStatusChange");
    await expect(siblingLogs).not.toContainText("Viewer 1");
    await expect(siblingActivity).not.toContainText("onError");
    await page.screenshot({
      path: info.outputPath("viewer-consoles-desktop.png"),
      fullPage: true,
    });

    await toggle.press("Space");
    await expect(logs).not.toHaveAttribute("open");
    await expect(siblingLogs).toHaveAttribute("open", "");
    await b.getByRole("button", { name: "Pause stream", exact: true }).click();
    await expect(sibling).toHaveAttribute("data-status", "paused");
    await expect(logs).not.toHaveAttribute("open");
    await expect(siblingLogs).toHaveAttribute("open", "");
    await b.getByRole("button", { name: "Resume stream", exact: true }).click();
    await expectColor(sibling, [232, 32, 48]);
    expect(sockets).toBe(opened);
    expect(
      await sibling
        .getByLabel("Remote browser input")
        .evaluate((element, old) => element === old, originalInput),
    ).toBe(true);
    await toggle.press("Space");
    await expect(logs).toHaveAttribute("open", "");
    await expect(errorEvent.locator("details")).toHaveAttribute("open", "");
    await logs.getByRole("button", { name: "Clear console" }).click();
    await expect(activity).toHaveCount(0);
    await expect(
      logs.getByRole("button", { name: "Clear console" }),
    ).toBeDisabled();
    await expect(current).toContainText("Target.getTargets");
    await expect(toggle).toContainText("1 error");
    await expect(
      logs.getByLabel("Viewer 1 current status summary"),
    ).toContainText("-32000");

    await expect(siblingLogs).toHaveAttribute("open", "");
    await expect(siblingActivity).toContainText("onStatusChange");
    await expect(
      siblingLogs.getByRole("button", { name: "Clear console" }),
    ).toBeEnabled();

    await page.setViewportSize({ width: 390, height: 844 });
    await current.scrollIntoViewIfNeeded();
    await expect(current).toBeVisible();
    expect(
      await logs
        .locator(".demo-console-body")
        .evaluate((element) => element.clientHeight),
    ).toBeLessThanOrEqual(360);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("viewer-consoles-mobile.png"),
      fullPage: true,
    });
    await a.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(view).toHaveAttribute("data-status", "streaming");
    await expect(current).toHaveCount(0);
    await expect(toggle).not.toContainText("1 error");
    await expect(activity).not.toContainText("onError");
    await expect(logs).toHaveAttribute("open", "");
    await expect(siblingLogs).toHaveAttribute("open", "");
    await expect(siblingActivity).toContainText("onStatusChange");
    await page
      .getByRole("button", { name: "Remove viewer 1", exact: true })
      .click();
    await expect(logs).toHaveCount(0);
    await expect(page.locator(".demo-console")).toHaveCount(1);
    await expect(siblingLogs).toHaveAttribute("open", "");
    await expect(siblingActivity).toContainText("onStatusChange");
    await expectColor(sibling, [232, 32, 48]);
    expect(
      await sibling
        .getByLabel("Remote browser input")
        .evaluate((element, old) => element === old, originalInput),
    ).toBe(true);
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
    await expect(view).toHaveAttribute("data-status", "error");
    await expect(view.getByRole("alert")).toContainText("Origin and TLS");
    await expect(view).not.toContainText(backend.endpoint);
    const logs = a.locator(".demo-console");
    await logs.locator(":scope > summary").click();
    const activity = logs.getByRole("list", {
      name: "Viewer 1 console logs",
      exact: true,
    });
    await expect(activity).toContainText("onError");
    await expect(activity).toContainText("Origin and TLS");
    await expect(activity).not.toContainText(backend.endpoint);
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
  await expect(page.locator(".demo-console")).toHaveCount(0);
  await expect(
    page.getByText("Add a viewer to connect to a browser."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add viewer" }).click();
  await expect(panel(page, 2)).toBeVisible();
  await expect(panel(page, 2).locator(".demo-console")).not.toHaveAttribute(
    "open",
  );
  await expect(
    panel(page, 2).getByRole("list", { name: "Viewer 2 console logs" }),
  ).toHaveCount(0);
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
    await view
      .getByRole("tab", { name: "rgb(232,32,48)", exact: true })
      .click();
    await expectColor(view, [232, 32, 48]);
    expect(new URL(page.url()).origin).toBe("https://okou-ai.github.io");
  } finally {
    await backend.close();
  }
});
