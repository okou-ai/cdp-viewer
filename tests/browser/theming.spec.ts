import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { CdpViewerStyle } from "cdp-viewer";
import { launchBackend, serveBrowserConsumer } from "./backend";
import type { FixtureSettings } from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

type Paint = readonly [number, number, number, number];
type ColorProperty = "backgroundColor" | "color" | "outlineColor";

const LIGHT_FOREGROUND: Paint = [32, 33, 36, 1];
const DARK_FOREGROUND: Paint = [232, 234, 237, 1];
const LIGHT_ACCENT: Paint = [26, 115, 232, 1];
const ON_ACCENT: Paint = [255, 255, 255, 1];

/** Normalize a CSS color, including color-mix(), to painted channels. */
async function channels(view: Locator, color: string): Promise<Paint> {
  return view.evaluate((_root, value) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#010203";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    return [
      data[0]!,
      data[1]!,
      data[2]!,
      Math.round((data[3]! / 255) * 1000) / 1000,
    ];
  }, color);
}

async function paint(
  view: Locator,
  selector: string,
  property: ColorProperty,
  pseudo?: "before" | "after",
): Promise<Paint> {
  const value = await view.evaluate(
    (root, options) => {
      const element = root.querySelector(options.selector);
      if (!element) throw new Error(`Missing ${options.selector}`);
      return getComputedStyle(
        element,
        options.pseudo ? `::${options.pseudo}` : null,
      )[options.property];
    },
    { selector, property, pseudo },
  );
  return channels(view, value);
}

/**
 * Resolve a documented theme formula through the same painting path as the
 * viewer, so translucent channels are compared without rounding artifacts.
 */
async function reference(view: Locator, formula: string): Promise<Paint> {
  const value = await view.evaluate((root, color) => {
    const probe = document.createElement("div");
    probe.style.setProperty("background-color", color);
    root.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, formula);
  return channels(view, value);
}

const HOVER_FORMULA =
  "color-mix(in srgb, var(--cdpv-foreground) 10%, transparent)";
const SELECTED_OPTION_FORMULA =
  "color-mix(in srgb, var(--cdpv-accent) 12%, transparent)";
const PRIMARY_HOVER_FORMULA =
  "color-mix(in srgb, var(--cdpv-accent) 90%, var(--cdpv-foreground))";

async function shadow(view: Locator, selector: string) {
  return view.evaluate(
    (root, target) => getComputedStyle(root.querySelector(target)!).boxShadow,
    selector,
  );
}

function expectPaint(
  actual: Paint,
  expected: Paint,
  channel = 2,
  alpha = 0.02,
) {
  const [r, g, b, a] = expected;
  for (const [index, value] of [r, g, b].entries())
    expect(
      Math.abs(actual[index]! - value),
      `channel ${index} of rgb(${actual.slice(0, 3).join(", ")})`,
    ).toBeLessThanOrEqual(channel);
  expect(Math.abs(actual[3] - a)).toBeLessThanOrEqual(alpha);
}

function relativeLuminance(value: Paint) {
  const linear = (channel: number) => {
    const scaled = channel / 255;
    return scaled <= 0.04045
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linear(value[0]) +
    0.7152 * linear(value[1]) +
    0.0722 * linear(value[2])
  );
}

function contrast(first: Paint, second: Paint) {
  const [high, low] = [
    relativeLuminance(first),
    relativeLuminance(second),
  ].sort((left, right) => right - left);
  return (high! + 0.05) / (low! + 0.05);
}

async function openWindow(
  backend: Awaited<ReturnType<typeof launchBackend>>,
  url: string,
  sameWindowTabs = 0,
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
  for (let index = 0; index < sameWindowTabs; index++) {
    const extra = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/red",
    });
    expect(
      (
        await backend.session.send("Browser.getWindowForTarget", {
          targetId: extra.targetId,
        })
      ).windowId,
    ).toBe(windowId);
  }
  const remote = await opened;
  await remote.goto(url);
  return { remote, targetId, windowId };
}

async function host(page: Page, settings: FixtureSettings) {
  await page.goto(server.origin);
  await page.waitForFunction(
    () => typeof window.configureViewers === "function",
  );
  await page.evaluate((value) => window.configureViewers!(value), settings);
  const a = page.locator("#viewer-a .cdpv-root");
  await expect(a).toHaveAttribute("data-status", "streaming");
  const b = page.locator("#viewer-b .cdpv-root");
  if (settings.second !== false)
    await expect(b).toHaveAttribute("data-status", "streaming");
  return { a, b };
}

/** Focus a control with keyboard modality so the public focus ring applies. */
async function focusControl(page: Page, view: Locator, selector: string) {
  await page.keyboard.press("Tab");
  await view.locator(selector).focus();
  return view.evaluate((root, target) => {
    const element = root.querySelector(target);
    if (!element) throw new Error(`Missing ${target}`);
    const style = getComputedStyle(element);
    return {
      visible: element.matches(":focus-visible"),
      width: style.outlineWidth,
      style: style.outlineStyle,
      color: style.outlineColor,
    };
  }, selector);
}

/** Grow a scoped window until its tab strip owns the picker form. */
async function overflowTabs(view: Locator) {
  const create = view.getByRole("button", { name: "New tab", exact: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await view.locator(".cdpv-tab-picker").count()) return;
    const tabs = await view.getByRole("tab").count();
    await create.click();
    await expect
      .poll(
        async () =>
          (await view.locator(".cdpv-tab-picker").count()) > 0 ||
          (await view.getByRole("tab").count()) !== tabs,
      )
      .toBe(true);
  }
  throw new Error("The tab strip never reached its overflow form.");
}

async function warn(view: Locator) {
  const address = view.getByRole("textbox", { name: "Remote page address" });
  await address.fill("not-an-absolute-address");
  await address.press("Enter");
  await expect(view.locator(".cdpv-error").first()).toBeVisible();
}

const THEMED_LIGHT: CdpViewerStyle = {
  "--cdpv-hover": "rgb(10, 20, 30)",
  "--cdpv-focus": "rgb(200, 0, 100)",
  "--cdpv-tab-selected-background": "rgb(0, 128, 96)",
  "--cdpv-option-selected-background": "rgb(60, 0, 120)",
  "--cdpv-popup-background": "rgb(250, 240, 230)",
  "--cdpv-popup-foreground": "rgb(20, 10, 0)",
  "--cdpv-popup-shadow": "rgb(1, 2, 3) 0px 0px 7px 1px",
  "--cdpv-primary-hover-background": "rgb(0, 90, 60)",
  "--cdpv-disabled-opacity": "0.6",
  "--cdpv-error": "rgb(0, 100, 0)",
  "--cdpv-error-background": "rgb(240, 255, 240)",
};

test("light: host tokens paint hover, selection, focus, popups and diagnostics per instance", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const first = await openWindow(
      backend,
      server.origin + "/fixture/editor",
      7,
    );
    const second = await openWindow(
      backend,
      server.origin + "/fixture/blue",
      1,
    );
    const { a, b } = await host(page, {
      cdpUrl: backend.endpoint,
      interactive: true,
      windowA: first.windowId,
      windowB: second.windowId,
      styleA: THEMED_LIGHT,
    });
    for (const view of [a, b]) {
      await view.evaluate((root) => {
        root.style.width = "320px";
      });
      await overflowTabs(view);
    }
    const pickers = [
      a.getByRole("combobox", { name: "All tabs" }),
      b.getByRole("combobox", { name: "All tabs" }),
    ];
    for (const picker of pickers) await expect(picker).toBeVisible();

    await a.locator(".cdpv-tab-item:not([data-selected])").first().hover();
    expectPaint(
      await paint(
        a,
        ".cdpv-tab-item:not([data-selected])",
        "backgroundColor",
        "before",
      ),
      [10, 20, 30, 1],
    );
    const lightHover = await reference(b, HOVER_FORMULA);
    expect(lightHover[3]).toBeLessThan(1);
    await b.locator(".cdpv-tab-item:not([data-selected])").first().hover();
    expectPaint(
      await paint(
        b,
        ".cdpv-tab-item:not([data-selected])",
        "backgroundColor",
        "before",
      ),
      lightHover,
    );

    expectPaint(
      await paint(a, ".cdpv-tab-item[data-selected]", "backgroundColor"),
      [0, 128, 96, 1],
    );
    expect(
      await a
        .locator(".cdpv-tab-item[data-selected]")
        .evaluate(
          (element) => getComputedStyle(element, "::before").backgroundImage,
        ),
    ).toContain("rgb(0, 128, 96)");
    expectPaint(
      await paint(b, ".cdpv-tab-item[data-selected]", "backgroundColor"),
      [255, 255, 255, 1],
    );

    expect(await focusControl(page, a, ".cdpv-address")).toEqual({
      visible: true,
      width: "2px",
      style: "solid",
      color: "rgb(200, 0, 100)",
    });
    expect(await focusControl(page, b, ".cdpv-address")).toEqual({
      visible: true,
      width: "2px",
      style: "solid",
      color: "rgb(26, 115, 232)",
    });

    await a.getByRole("button", { name: "Browser menu" }).click();
    const menuA = a.getByRole("menu", { name: "Browser menu", exact: true });
    await expect(menuA).toBeVisible();
    expectPaint(
      await paint(a, ".cdpv-browser-menu", "backgroundColor"),
      [250, 240, 230, 1],
    );
    expectPaint(await paint(a, ".cdpv-browser-menu", "color"), [20, 10, 0, 1]);
    expect(await shadow(a, ".cdpv-browser-menu")).toBe(
      "rgb(1, 2, 3) 0px 0px 7px 1px",
    );
    await menuA.getByRole("menuitem").first().hover();
    await expect(menuA.locator("[data-highlighted]").first()).toBeVisible();
    expectPaint(
      await paint(
        a,
        ".cdpv-browser-menu-item[data-highlighted]",
        "backgroundColor",
      ),
      [10, 20, 30, 1],
    );
    await page.keyboard.press("Escape");
    await expect(menuA).toHaveCount(0);

    await b.getByRole("button", { name: "Browser menu" }).click();
    const menuB = b.getByRole("menu", { name: "Browser menu", exact: true });
    await expect(menuB).toBeVisible();
    expectPaint(
      await paint(b, ".cdpv-browser-menu", "backgroundColor"),
      [255, 255, 255, 1],
    );
    expectPaint(
      await paint(b, ".cdpv-browser-menu", "color"),
      LIGHT_FOREGROUND,
    );
    expect(await shadow(b, ".cdpv-browser-menu")).toContain("0.16");
    await page.keyboard.press("Escape");
    await expect(menuB).toHaveCount(0);

    await pickers[0]!.click();
    const popupA = a.locator(".cdpv-tab-popup");
    await expect(popupA).toBeVisible();
    expectPaint(
      await paint(a, ".cdpv-tab-popup", "backgroundColor"),
      [250, 240, 230, 1],
    );
    expect(await shadow(a, ".cdpv-tab-popup")).toBe(
      "rgb(1, 2, 3) 0px 0px 7px 1px",
    );
    const hoveredOption = a
      .locator(".cdpv-tab-option:not([data-selected])")
      .first();
    await hoveredOption.hover();
    await expect(hoveredOption).toHaveAttribute("data-highlighted", "");
    expectPaint(
      await paint(a, ".cdpv-tab-option[data-highlighted]", "backgroundColor"),
      [10, 20, 30, 1],
    );
    expectPaint(
      await paint(a, ".cdpv-tab-option[data-selected]", "backgroundColor"),
      [60, 0, 120, 1],
    );
    await pickers[0]!.click();
    await expect(pickers[0]!).toHaveAttribute("aria-expanded", "false");

    await pickers[1]!.click();
    const popupB = b.locator(".cdpv-tab-popup");
    await expect(popupB).toBeVisible();
    expectPaint(
      await paint(b, ".cdpv-tab-popup", "backgroundColor"),
      [255, 255, 255, 1],
    );
    await b.locator(".cdpv-tab-option:not([data-selected])").first().hover();
    expectPaint(
      await paint(b, ".cdpv-tab-option[data-selected]", "backgroundColor"),
      await reference(b, SELECTED_OPTION_FORMULA),
    );
    expectPaint(
      await paint(b, ".cdpv-tab-option[data-highlighted]", "backgroundColor"),
      await reference(b, HOVER_FORMULA),
    );
    await pickers[1]!.click();
    await expect(pickers[1]!).toHaveAttribute("aria-expanded", "false");

    await warn(a);
    expectPaint(await paint(a, ".cdpv-error", "color"), [0, 100, 0, 1]);
    expectPaint(
      await paint(a, ".cdpv-error", "backgroundColor"),
      [240, 255, 240, 1],
    );
    await warn(b);
    expectPaint(await paint(b, ".cdpv-error", "color"), [138, 53, 0, 1]);
    expectPaint(
      await paint(b, ".cdpv-error", "backgroundColor"),
      [255, 244, 229, 1],
    );

    // Disabled strength is themeable while standalone defaults stay distinct.
    await backend.close();
    for (const [view, opacity] of [
      [a, "0.6"],
      [b, "0.35"],
    ] as const) {
      const newTab = view.getByRole("button", { name: "New tab", exact: true });
      await expect(newTab).toBeDisabled();
      await expect(newTab).toHaveCSS("opacity", opacity);
    }
  } finally {
    await backend.close();
  }
});

test("dark: sibling instances keep independent palettes and host tokens", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const first = await openWindow(
      backend,
      server.origin + "/fixture/editor",
      1,
    );
    const second = await openWindow(
      backend,
      server.origin + "/fixture/blue",
      1,
    );
    const { a, b } = await host(page, {
      cdpUrl: backend.endpoint,
      interactive: true,
      windowA: first.windowId,
      windowB: second.windowId,
      colorSchemeA: "dark",
      colorSchemeB: "dark",
      styleA: {
        "--cdpv-hover": "rgb(255, 200, 0)",
        "--cdpv-tab-selected-background": "rgb(20, 60, 90)",
        "--cdpv-popup-background": "rgb(30, 20, 10)",
        "--cdpv-popup-foreground": "rgb(250, 250, 250)",
      },
    });

    await a.locator(".cdpv-tab-item:not([data-selected])").first().hover();
    expectPaint(
      await paint(
        a,
        ".cdpv-tab-item:not([data-selected])",
        "backgroundColor",
        "before",
      ),
      [255, 200, 0, 1],
    );
    const darkHover = await reference(b, HOVER_FORMULA);
    expect(darkHover[3]).toBeLessThan(1);
    await b.locator(".cdpv-tab-item:not([data-selected])").first().hover();
    expectPaint(
      await paint(
        b,
        ".cdpv-tab-item:not([data-selected])",
        "backgroundColor",
        "before",
      ),
      darkHover,
    );

    expectPaint(
      await paint(a, ".cdpv-tab-item[data-selected]", "backgroundColor"),
      [20, 60, 90, 1],
    );
    expectPaint(
      await paint(b, ".cdpv-tab-item[data-selected]", "backgroundColor"),
      [53, 54, 58, 1],
    );

    for (const [view, background, foreground] of [
      [a, [30, 20, 10, 1], [250, 250, 250, 1]],
      [b, [53, 54, 58, 1], DARK_FOREGROUND],
    ] as const) {
      await view.getByRole("button", { name: "Browser menu" }).click();
      await expect(
        view.getByRole("menu", { name: "Browser menu", exact: true }),
      ).toBeVisible();
      expectPaint(
        await paint(view, ".cdpv-browser-menu", "backgroundColor"),
        background as Paint,
      );
      expectPaint(
        await paint(view, ".cdpv-browser-menu", "color"),
        foreground as Paint,
      );
      await page.keyboard.press("Escape");
      await expect(
        view.getByRole("menu", { name: "Browser menu", exact: true }),
      ).toHaveCount(0);
    }
  } finally {
    await backend.close();
  }
});

test("primary hover keeps a filled readable surface instead of the neutral wash", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  let holdCreate = false;
  const held: (() => void)[] = [];
  try {
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as {
          id: number;
          method: string;
        };
        if (command.method === "Target.getTargets") {
          socket.send(
            JSON.stringify({ id: command.id, result: { targetInfos: [] } }),
          );
          return;
        }
        if (holdCreate && command.method === "Target.createTarget") {
          held.push(() => upstream.send(message));
          return;
        }
        upstream.send(message);
      });
    });
    await page.goto(server.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate((settings) => window.configureViewers!(settings), {
      cdpUrl: backend.endpoint,
      interactive: true,
      styleA: {
        "--cdpv-hover": "rgb(255, 0, 255)",
        "--cdpv-primary-hover-background": "rgb(0, 90, 60)",
        "--cdpv-busy-opacity": "0.5",
      },
    });
    const a = page.locator("#viewer-a .cdpv-root");
    const b = page.locator("#viewer-b .cdpv-root");
    const primaryA = a.getByRole("button", { name: "Create new tab" });
    const primaryB = b.getByRole("button", { name: "Create new tab" });
    await expect(primaryA).toBeEnabled();
    await expect(primaryB).toBeEnabled();

    expectPaint(
      await paint(a, ".cdpv-primary", "backgroundColor"),
      LIGHT_ACCENT,
    );
    await primaryA.hover();
    expectPaint(
      await paint(a, ".cdpv-primary", "backgroundColor"),
      [0, 90, 60, 1],
    );
    expectPaint(await paint(a, ".cdpv-primary", "color"), ON_ACCENT);

    const primaryDefault = await reference(b, PRIMARY_HOVER_FORMULA);
    expect(primaryDefault[3], "the default primary hover stays opaque").toBe(1);
    await primaryB.hover();
    const hovered = await paint(b, ".cdpv-primary", "backgroundColor");
    expectPaint(hovered, primaryDefault);
    expectPaint(await paint(b, ".cdpv-primary", "color"), ON_ACCENT);
    expect(contrast(hovered, ON_ACCENT)).toBeGreaterThanOrEqual(4.5);
    expect(contrast([0, 90, 60, 1], ON_ACCENT)).toBeGreaterThanOrEqual(4.5);

    // The neutral wash still applies to ordinary recovery actions.
    const reconnect = b.getByRole("button", { name: "Reconnect viewer" });
    await reconnect.hover();
    expectPaint(
      await paint(b, ".cdpv-action", "backgroundColor"),
      await reference(b, HOVER_FORMULA),
    );

    // A pending create reports busy and keeps the primary hover from applying.
    holdCreate = true;
    await a.getByRole("button", { name: "New tab", exact: true }).click();
    const busyA = a.getByRole("button", { name: "New tab", exact: true });
    await expect(busyA).toHaveAttribute("aria-busy", "true");
    await expect(busyA).toBeDisabled();
    await expect(busyA).toHaveCSS("opacity", "0.5");
    await b.getByRole("button", { name: "New tab", exact: true }).click();
    const busyB = b.getByRole("button", { name: "New tab", exact: true });
    await expect(busyB).toHaveAttribute("aria-busy", "true");
    await expect(busyB).toHaveCSS("opacity", "0.8");

    holdCreate = false;
    for (const release of held) release();
  } finally {
    await backend.close();
  }
});
