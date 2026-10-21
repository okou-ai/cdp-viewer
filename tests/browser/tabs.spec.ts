import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
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

async function overflowOptions(viewer: Locator) {
  const trigger = viewer.getByRole("combobox", { name: "All tabs" });
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  await expect(viewer.getByRole("listbox", { name: "All tabs" })).toBeVisible();
  return viewer.getByRole("option");
}

async function selectOverflowTab(viewer: Locator, targetId: string) {
  await overflowOptions(viewer);
  await viewer.locator(`[data-tab-option="${targetId}"]`).click();
  const trigger = viewer.getByRole("combobox", { name: "All tabs" });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
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
  for (const width of [390, 1280]) {
    test(`new-tab progress stays compact after discovery in ${colorScheme} at ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const backend = await launchBackend(
        info.outputPath("backend"),
        server.origin,
      );
      let release: (() => void) | undefined;
      await page.routeWebSocket(backend.endpoint, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as {
            method: string;
            params?: { url?: string };
          };
          if (
            command.method === "Page.navigate" &&
            command.params?.url === "about:blank"
          ) {
            release = () => upstream.send(message);
            return;
          }
          upstream.send(message);
        });
      });
      try {
        const first = await remoteTab(backend, "Workspace", true);
        const viewer = await host(page, {
          cdpUrl: backend.endpoint,
          windowA: first.windowId,
          colorSchemeA: colorScheme,
          interactive: true,
          second: false,
        });
        await page.locator("#panels").evaluate((element) => {
          element.style.gridTemplateColumns = "minmax(0, 1fr)";
        });
        await expect(viewer).toHaveAttribute("data-status", "streaming");
        const create = viewer.getByRole("button", {
          name: "New tab",
          exact: true,
        });
        const idle = await create.boundingBox();
        expect(idle).not.toBeNull();
        const pages = backend.context.pages().length;
        await viewer.screenshot({ path: info.outputPath("idle.png") });
        const opened = backend.context.waitForEvent("page");
        await create.click();
        await expect.poll(() => typeof release).toBe("function");
        await opened;
        await expect(viewer.getByRole("tab")).toHaveCount(2);
        await expect(create).toHaveAttribute("aria-busy", "true");
        await expect(create).toBeDisabled();
        await expect(create.locator(".cdpv-spinning")).toBeVisible();
        await expect(viewer.getByRole("status")).toContainText("Creating tab");
        expect(backend.context.pages()).toHaveLength(pages + 1);
        await viewer.screenshot({ path: info.outputPath("pending.png") });
        await expect(create).toHaveText("");
        expect(await create.boundingBox()).toMatchObject({
          width: idle!.width,
          height: idle!.height,
        });
        await expect(create).toBeInViewport();
        release!();
        await expect(create).toHaveAttribute("aria-busy", "false");
        await expect(create).toBeEnabled();
        await expect(create.locator(".cdpv-spinning")).toHaveCount(0);
        await expect(
          viewer.getByRole("tab", { selected: true }),
        ).not.toHaveAttribute("data-target-id", first.targetId);
        await expect(viewer.getByRole("tab")).toHaveCount(2);
        expect(backend.context.pages()).toHaveLength(pages + 1);
        expect(await create.boundingBox()).toMatchObject({
          width: idle!.width,
          height: idle!.height,
        });
        await viewer.screenshot({ path: info.outputPath("complete.png") });
      } finally {
        await backend.close();
      }
    });
  }
}

test("delayed tab creation preserves a later host input focus", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  let release: (() => void) | undefined;
  await page.routeWebSocket(backend.endpoint, (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const command = JSON.parse(String(message)) as { method: string };
      if (command.method === "Page.createIsolatedWorld") {
        release = () => upstream.send(message);
        return;
      }
      upstream.send(message);
    });
  });
  try {
    const first = await remoteTab(backend, "Workspace", true);
    const viewer = await host(page, {
      cdpUrl: backend.endpoint,
      windowA: first.windowId,
      interactive: true,
      second: false,
    });
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    const create = viewer.getByRole("button", { name: "New tab", exact: true });
    await create.click();
    await expect.poll(() => typeof release).toBe("function");
    const input = page.getByLabel("Host input", { exact: true });
    await input.fill("Keep typing here");
    release!();
    await expect(
      viewer.getByRole("tab", { selected: true }),
    ).not.toHaveAttribute("data-target-id", first.targetId);
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    await expect(create).toHaveAttribute("aria-busy", "false");
    await expect(input).toBeFocused();
    await page.keyboard.type(" after creation");
    await expect(input).toHaveValue("Keep typing here after creation");
  } finally {
    await backend.close();
  }
});

test("tab discovery preserves compressed layout while selection and focus stay visible without scrolling", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const first = await remoteTab(backend, "Workspace", true);
    const background = await remoteTab(backend, "Background");
    await remoteTab(backend, "Notes");
    await remoteTab(backend, "Inbox");
    const viewer = await host(page, {
      cdpUrl: backend.endpoint,
      windowA: first.windowId,
      interactive: true,
      second: false,
    });
    await viewer.evaluate((element) => {
      element.style.width = "360px";
    });
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    const firstTab = viewer.getByRole("tab").first();
    await firstTab.click();
    await expect(firstTab).toHaveAttribute("aria-selected", "true");
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    const strip = viewer.getByRole("tablist");
    const widths = await viewer
      .locator(".cdpv-tab-item")
      .evaluateAll((items) =>
        items.map((item) => item.getBoundingClientRect().width),
      );
    expect(widths.every((width) => width < 100)).toBe(true);
    expect(
      await strip.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
        return element.scrollLeft;
      }),
    ).toBe(0);
    await background.remote.evaluate(() => {
      document.title = "Updated background";
    });
    await expect(
      viewer.getByRole("tab", { name: "Updated background", exact: true }),
    ).toBeVisible();
    expect(
      await viewer
        .locator(".cdpv-tab-item")
        .evaluateAll((items) =>
          items.map((item) => item.getBoundingClientRect().width),
        ),
    ).toEqual(widths);
    await viewer.getByRole("img", { name: "Live browser view" }).click();
    const hostScroll = await page.evaluate(() => [scrollX, scrollY]);
    await page.keyboard.press("F8");
    await expect(firstTab).toBeFocused();
    await expect(firstTab).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual(hostScroll);
    await firstTab.focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    const lastTab = viewer.getByRole("tab").last();
    await expect(lastTab).toHaveAttribute("aria-selected", "true");
    await expect(lastTab).toBeInViewport({ ratio: 1 });
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    await viewer.evaluate((element) => {
      element.style.width = "960px";
    });
    await expect(viewer.locator(".cdpv-close").first()).toBeVisible();
    await viewer.locator(".cdpv-close").first().click();
    await expect(viewer.getByRole("tab")).toHaveCount(3);
    await expect(lastTab).toHaveAttribute("aria-selected", "true");
    await expect(lastTab).toBeFocused();
    await expect(lastTab).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual(hostScroll);
  } finally {
    await backend.close();
  }
});

async function viewerGeometry(viewer: Locator) {
  return viewer.evaluate((root) => {
    const top = root.getBoundingClientRect().top;
    const geometry = (selector: string) => {
      const element = root.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top - top, height: rect.height };
    };
    return {
      toolbar: geometry(".cdpv-toolbar"),
      navigation: geometry(".cdpv-navigation"),
      stage: geometry(".cdpv-stage"),
      canvas: geometry("canvas"),
    };
  });
}

async function expectTabBarAlignment(viewer: Locator) {
  const geometry = await viewer.evaluate((root) => {
    const toolbar = root
      .querySelector(".cdpv-toolbar")!
      .getBoundingClientRect();
    const list = root.querySelector(".cdpv-tabs")!.getBoundingClientRect();
    const rect = root.querySelector(".cdpv-new-tab")?.getBoundingClientRect();
    const tab = root.querySelector(".cdpv-tab-item")?.getBoundingClientRect();
    const center = toolbar.top + toolbar.height / 2;
    return {
      centers: Array.from(
        root.querySelectorAll(
          ".cdpv-tab svg, .cdpv-tab span, .cdpv-close, .cdpv-close svg, .cdpv-new-tab, .cdpv-new-tab svg, .cdpv-new-tab span",
        ),
      )
        .filter((element) => element.getClientRects().length)
        .map((element) => {
          const box = element.getBoundingClientRect();
          return {
            name: element.getAttribute("class") ?? element.tagName,
            offset: box.top + box.height / 2 - center,
          };
        }),
      hitAreas: Array.from(
        root.querySelectorAll(".cdpv-tab, .cdpv-close, .cdpv-new-tab"),
      )
        .filter((element) => element.getClientRects().length)
        .map((element) => ({
          minimum: element.matches(".cdpv-tab")
            ? 35
            : element.matches(".cdpv-close")
              ? 24
              : 32,
          height: element.getBoundingClientRect().height,
        })),
      listBottom: list.bottom - toolbar.bottom,
      tabBottom: (tab?.bottom ?? list.bottom) - toolbar.bottom,
      leadingInset:
        tab && root.querySelector(".cdpv-tabs")!.scrollLeft === 0
          ? tab.left - toolbar.left
          : null,
      afterTabs: rect
        ? (root.querySelector(".cdpv-tab-picker")?.getBoundingClientRect()
            .left ?? rect.left) -
          (list.right -
            parseFloat(
              getComputedStyle(root.querySelector(".cdpv-tabs")!).paddingRight,
            ))
        : null,
      rightInset: rect ? toolbar.right - rect.right : null,
      hostOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(
    geometry.centers.filter((control) => Math.abs(control.offset) > 0.5),
    "All tab controls share the tab bar center line",
  ).toEqual([]);
  expect(
    geometry.hitAreas.filter((area) => area.height < area.minimum),
    "Tab action hit areas retain their minimum heights",
  ).toEqual([]);
  expect(Math.abs(geometry.listBottom)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.tabBottom)).toBeLessThanOrEqual(0.5);
  if (geometry.leadingInset !== null) expect(geometry.leadingInset).toBe(3);
  if (geometry.afterTabs !== null) expect(geometry.afterTabs).toBe(6);
  if (geometry.rightInset !== null)
    expect(geometry.rightInset).toBeGreaterThanOrEqual(0);
  expect(geometry.hostOverflow).toBe(false);
}

async function tabSurfacePixels(viewer: Locator) {
  const sample = await viewer.evaluate((root) => {
    const row = root.querySelector(".cdpv-toolbar")!.getBoundingClientRect();
    const navigation = root.querySelector(".cdpv-navigation");
    const strip = root.querySelector(".cdpv-tabs")!.getBoundingClientRect();
    const selected = root
      .querySelector('[role="tab"][aria-selected="true"]')!
      .parentElement!.getBoundingClientRect();
    const inactive = root
      .querySelector('[role="tab"][aria-selected="false"]')!
      .parentElement!.getBoundingClientRect();
    const points = [
      [
        selected.left + selected.width / 2 - row.left,
        selected.top + 4 - row.top,
      ],
      [
        (Math.max(inactive.left, strip.left) +
          Math.min(inactive.right, strip.right)) /
          2 -
          row.left,
        inactive.top + 4 - row.top,
      ],
      [selected.left - 2 - row.left, selected.bottom - 1 - row.top],
      [selected.right + 1 - row.left, selected.bottom - 1 - row.top],
      [row.width - 2, 2],
    ];
    if (navigation) points.push([row.width - 2, row.height + 1]);
    return {
      points,
      clip: {
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height + (navigation ? 3 : 0),
      },
    };
  });
  return tabBarPixels(viewer, sample);
}

async function tabBarPixels(
  viewer: Locator,
  sample: {
    clip: { x: number; y: number; width: number; height: number };
    points: number[][];
  },
  pixelRatio = 1,
) {
  const image = await viewer.page().screenshot({
    clip: sample.clip,
    scale: pixelRatio === 1 ? "css" : "device",
  });
  return viewer.evaluate(
    async (_, { bytes, points, pixelRatio }) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      );
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        return points.map(([x, y]) =>
          Array.from(
            context.getImageData(
              Math.floor(x! * pixelRatio),
              Math.floor(y! * pixelRatio),
              1,
              1,
            ).data,
          ),
        );
      } finally {
        bitmap.close();
      }
    },
    { bytes: Array.from(image), points: sample.points, pixelRatio },
  );
}

async function expectParallelContour(
  viewer: Locator,
  colors: { hover: number[]; gutter: number[]; outer: number[] },
) {
  const sample = await viewer.evaluate((root) => {
    const row = root.querySelector(".cdpv-toolbar")!.getBoundingClientRect();
    const navigation = root.querySelector(".cdpv-navigation");
    const selected = root
      .querySelector('[role="tab"][aria-selected="true"]')!
      .parentElement!.getBoundingClientRect();
    const inactive = root
      .querySelector('[role="tab"][aria-selected="false"]')!
      .parentElement!.getBoundingClientRect();
    // A 10px hover corner with a 6px clearance has a concentric 16px outer arc.
    const direction = inactive.left < selected.left ? 1 : -1;
    const centerX = direction === 1 ? inactive.right - 13 : inactive.left + 13;
    const centerY = row.bottom - 16;
    const angles = navigation
      ? [0, 15, 30, 45, 60, 65, 75, 90]
      : [0, 15, 30, 45, 60, 65];
    const probes = angles.flatMap((angle) =>
      [8.5, 11.5, 13, 14.5, 17.5].map((radius) => ({
        angle,
        radius,
        band:
          radius === 8.5
            ? ("hover" as const)
            : radius === 17.5
              ? ("outer" as const)
              : ("gutter" as const),
        x: centerX + direction * radius * Math.cos((angle * Math.PI) / 180),
        y: centerY + radius * Math.sin((angle * Math.PI) / 180),
      })),
    );
    return {
      probes,
      points: probes.map(({ x, y }) => [x - row.left, y - row.top]),
      clip: {
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height + (navigation ? 3 : 0),
      },
    };
  });
  const pixels = await tabBarPixels(viewer, sample);
  const incorrect = sample.probes
    .map(({ angle, radius, band }, index) => ({
      angle,
      radius,
      band,
      actual: pixels[index]!,
      expected: colors[band],
    }))
    .filter(({ actual, expected }) =>
      actual.some((channel, index) => channel !== expected[index]),
    );
  expect(
    incorrect,
    "Hover, gutter and outer surface follow concentric offset curves",
  ).toEqual([]);
}

async function expectNewTabHoverAlignment(viewer: Locator) {
  const sample = await viewer.evaluate((root) => {
    const row = root.querySelector(".cdpv-toolbar")!.getBoundingClientRect();
    const tab = root.querySelector(".cdpv-tab-item")!.getBoundingClientRect();
    const button = root.querySelector(".cdpv-new-tab")!.getBoundingClientRect();
    const centerX = button.left + button.width / 2 - row.left;
    const pixelRatio = devicePixelRatio;
    const verticalSamples = row.height * pixelRatio;
    return {
      clip: { x: row.x, y: row.y, width: row.width, height: row.height },
      points: [
        [centerX, 1],
        ...Array.from({ length: verticalSamples }, (_, y) => [
          centerX,
          (y + 0.5) / pixelRatio,
        ]),
        ...Array.from({ length: button.width * pixelRatio }, (_, x) => [
          button.left - row.left + (x + 0.5) / pixelRatio,
          row.height / 2,
        ]),
      ],
      tabTop: tab.top - row.top,
      rowHeight: row.height,
      buttonWidth: button.width,
      pixelRatio,
      verticalSamples,
    };
  });
  const pixels = await tabBarPixels(viewer, sample, sample.pixelRatio);
  const range = (axis: number[][]) => {
    const painted = axis.map((pixel) =>
      pixel.some((channel, index) => channel !== pixels[0]![index]),
    );
    return {
      start: painted.indexOf(true) / sample.pixelRatio,
      end: (painted.lastIndexOf(true) + 1) / sample.pixelRatio,
    };
  };
  const vertical = range(pixels.slice(1, 1 + sample.verticalSamples));
  const horizontal = range(pixels.slice(1 + sample.verticalSamples));
  expect
    .soft(vertical.start, "Hover circle starts at the tab's top edge")
    .toBe(sample.tabTop);
  expect
    .soft(vertical.end, "Hover circle has equal top and bottom clearance")
    .toBe(sample.rowHeight - sample.tabTop);
  expect.soft((vertical.start + vertical.end) / 2).toBe(sample.rowHeight / 2);
  // Odd CSS diameters can quantize a horizontal edge by one device pixel.
  expect
    .soft(
      Math.abs(
        (horizontal.start + horizontal.end) / 2 - sample.buttonWidth / 2,
      ),
    )
    .toBeLessThanOrEqual(1 / sample.pixelRatio);
  expect
    .soft(
      horizontal.end - horizontal.start,
      "The centered hover surface stays circular",
    )
    .toBe(vertical.end - vertical.start);
}

test.describe(() => {
  test.use({ deviceScaleFactor: 2 });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`keeps compact ${colorScheme} tab-strip edge spacing and a clear action gutter`, async ({
      page,
    }, info) => {
      const backend = await launchBackend(
        info.outputPath("backend"),
        server.origin,
      );
      try {
        await page.setViewportSize({ width: 1100, height: 850 });
        const first = await remoteTab(backend, "Workspace", true);
        await remoteTab(backend, "Product notes");
        const viewer = await host(page, {
          cdpUrl: backend.endpoint,
          windowA: first.windowId,
          colorSchemeA: colorScheme,
          interactive: true,
          second: false,
        });
        await page.locator("#panels").evaluate((element) => {
          element.style.gridTemplateColumns = "minmax(0, 1fr)";
          // Pixel-edge assertions need a stable screenshot crop origin.
          const top = element.getBoundingClientRect().top;
          element.style.marginTop = `${Math.ceil(top) - top}px`;
        });
        await expect(viewer).toHaveAttribute("data-status", "streaming");
        const strip = viewer.getByRole("tablist");
        const tabs = viewer.getByRole("tab");
        const create = viewer.getByRole("button", {
          name: "New tab",
          exact: true,
        });
        for (const width of [960, 320]) {
          await viewer.evaluate((root, value) => {
            root.style.width = `${value}px`;
          }, width);
          await tabs.last().click();
          await strip.evaluate((list) => {
            list.scrollLeft = 0;
          });
          await tabs.first().hover();
          await viewer.screenshot({
            path: info.outputPath(`${width}-leading-hover.png`),
          });
          const leading = await viewer.evaluate((root) => {
            const row = root
              .querySelector(".cdpv-toolbar")!
              .getBoundingClientRect();
            const items = root.querySelectorAll(".cdpv-tab-item");
            const first = items[0]!.getBoundingClientRect();
            const second = items[1]!.getBoundingClientRect();
            return {
              inset: first.left - row.left,
              gap: second.left - first.right,
            };
          });
          expect
            .soft(leading.inset, "Leading body inset matches the inter-tab gap")
            .toBe(leading.gap);
          expect.soft(leading.inset).toBe(3);
          await tabs.last().blur();
          await tabs.last().click();
          await create.hover();
          await viewer.screenshot({
            path: info.outputPath(`${width}-new-tab-hover.png`),
          });
          await expectNewTabHoverAlignment(viewer);
          const last = await tabs.last().locator("..").boundingBox();
          const action = await create.boundingBox();
          expect
            .soft(
              action!.x - last!.x - last!.width,
              "New-tab hit box stays close to the final body",
            )
            .toBe(6);
          expect(action).toMatchObject({ width: 32, height: 32 });
          const before = await tabs.count();
          await create.click({ position: { x: 1, y: 16 } });
          await expect(tabs).toHaveCount(before + 1);
          await expect(viewer).toHaveAttribute("data-status", "streaming");
          const created = await tabs.last().getAttribute("data-target-id");
          await viewer.locator(`[data-close-target="${created}"]`).click();
          await expect(tabs).toHaveCount(before);
        }
        for (let index = 0; index < 3; index++)
          await remoteTab(backend, `Overflow ${index}`);
        await expect(tabs).toHaveCount(5);
        // Compressed selected surfaces retain the clear action gutter.
        await page.mouse.move(0, 0);
        for (const selectedIndex of [0, 1, 3, 4]) {
          await tabs.nth(selectedIndex).click();
          expect(
            await strip.evaluate((list) => {
              list.scrollLeft = 207;
              return list.scrollLeft;
            }),
          ).toBe(0);
          const sample = await viewer.evaluate((root) => {
            const row = root
              .querySelector(".cdpv-toolbar")!
              .getBoundingClientRect();
            const button = root
              .querySelector(".cdpv-new-tab")!
              .getBoundingClientRect();
            return {
              clip: {
                x: row.x,
                y: row.y,
                width: row.width,
                height: row.height,
              },
              points: [
                [row.width - 2, 2],
                [button.left + 1 - row.left, button.top + 1 - row.top],
                [
                  button.left + 1 - row.left,
                  button.top + button.height / 2 - row.top,
                ],
                [button.left + 1 - row.left, button.bottom - 1 - row.top],
              ],
            };
          });
          const pixels = await tabBarPixels(viewer, sample);
          expect
            .soft(
              pixels.slice(1),
              "Compressed tabs do not paint beneath the new-tab button",
            )
            .toEqual([pixels[0], pixels[0], pixels[0]]);
          expect(
            await create.evaluate((button) => {
              const rect = button.getBoundingClientRect();
              return [
                [rect.left + 1, rect.top + rect.height / 2],
                [rect.left + rect.width / 2, rect.top + 1],
                [rect.right - 1, rect.top + rect.height / 2],
                [rect.left + rect.width / 2, rect.bottom - 1],
              ].every(
                ([x, y]) =>
                  document
                    .elementFromPoint(x!, y!)
                    ?.closest(".cdpv-new-tab") === button,
              );
            }),
          ).toBe(true);
        }
        await strip.evaluate((list) => {
          list.scrollLeft = 0;
        });
        await tabs.last().focus();
        await expect(tabs.last()).toBeInViewport({ ratio: 1 });
        await page.keyboard.press("Enter");
        await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
        await create.hover();
        await viewer.screenshot({
          path: info.outputPath("320-compressed-end.png"),
        });
        await expectTabBarAlignment(viewer);
      } finally {
        await backend.close();
      }
    });

    for (const interactive of [true, false]) {
      test(`paints distinct ${colorScheme} ${interactive ? "interactive" : "view-only"} selected and hovered tab surfaces`, async ({
        page,
      }, info) => {
        const backend = await launchBackend(
          info.outputPath("backend"),
          server.origin,
        );
        try {
          await page.emulateMedia({ colorScheme });
          const first = await remoteTab(backend, "Workspace", true);
          await remoteTab(backend, "Product notes");
          const viewer = await host(page, {
            cdpUrl: backend.endpoint,
            windowA: first.windowId,
            interactive,
            second: false,
          });
          await expect(viewer).toHaveAttribute("data-status", "streaming");
          await page.evaluate(() => {
            document.documentElement.style.colorScheme = "light dark";
            document.querySelector<HTMLElement>(
              "#panels",
            )!.style.gridTemplateColumns = "minmax(0, 1fr)";
            document.querySelector<HTMLElement>(".cdpv-root")!.style.width =
              "960px";
          });
          const tabs = viewer.getByRole("tab");
          for (const width of [960, 320]) {
            await viewer.evaluate((root, value) => {
              root.style.width = `${value}px`;
            }, width);
            for (const selected of [1, 0]) {
              const prefix = `${width === 960 ? "" : "320-"}${selected}`;
              await tabs.nth(selected).click();
              await expect(tabs.nth(selected)).toHaveAttribute(
                "aria-selected",
                "true",
              );
              await expect(viewer).toHaveAttribute("data-status", "streaming");
              await tabs.nth(selected).blur();
              await page.mouse.move(0, 0);
              const idle = await tabSurfacePixels(viewer);
              expect(idle[0]).not.toEqual(idle[4]);
              if (interactive)
                expect(
                  idle[0],
                  "Selected surface connects into navigation",
                ).toEqual(idle[5]);
              expect(idle[1]).toEqual(idle[4]);
              expect(
                idle[2],
                "Selected left curve remains visible at strip edges",
              ).toEqual(idle[0]);
              expect(
                idle[3],
                "Selected right curve remains visible at strip edges",
              ).toEqual(idle[0]);
              await viewer.screenshot({
                path: info.outputPath(`${prefix}-idle.png`),
              });
              await tabs.nth(selected).hover();
              expect(await tabSurfacePixels(viewer)).toEqual(idle);
              if (width === 960) {
                await tabs.nth(1 - selected).hover();
                const hovered = await tabSurfacePixels(viewer);
                expect(hovered[0]).toEqual(idle[0]);
                expect(hovered[1]).not.toEqual(idle[1]);
                expect(hovered[1]).not.toEqual(idle[0]);
                expect(hovered[2]).toEqual(idle[2]);
                expect(hovered[3]).toEqual(idle[3]);
                await viewer.screenshot({
                  path: info.outputPath(`${prefix}-inactive-hover.png`),
                });
                await expectParallelContour(viewer, {
                  hover: hovered[1]!,
                  gutter: hovered[4]!,
                  outer: hovered[0]!,
                });
              }
              if (interactive) {
                await viewer
                  .getByRole("button", {
                    name: `Close ${selected === 0 ? "Workspace" : "Product notes"}`,
                    exact: true,
                  })
                  .hover();
                await viewer.screenshot({
                  path: info.outputPath(`${prefix}-close-hover.png`),
                });
              }
              await expectTabBarAlignment(viewer);
            }
          }
        } finally {
          await backend.close();
        }
      });
    }
  }
});

for (const nativeScrollbars of [false, true]) {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const interactive of [true, false]) {
      const mode = interactive ? "interactive" : "view-only";
      test(`${nativeScrollbars ? "native" : "hidden"} scrollbars: keeps ${colorScheme} ${mode} tab bar geometry stable through empty and populated states`, async ({
        playwright,
      }, info) => {
        const backend = await launchBackend(
          info.outputPath("backend"),
          server.origin,
        );
        let browser: Browser | undefined;
        try {
          browser = await playwright.chromium.launch({
            channel: "chromium",
            ...(process.env.CDP_VIEWER_CHROMIUM
              ? { executablePath: process.env.CDP_VIEWER_CHROMIUM }
              : {}),
            // Prove component styling works when the browser itself shows scrollbars.
            ignoreDefaultArgs: nativeScrollbars ? ["--hide-scrollbars"] : [],
          });
          const page = await browser.newPage();
          let empty = false;
          let holdCreate = false;
          let releaseCreate: (() => void) | undefined;
          await page.routeWebSocket(backend.endpoint, (socket) => {
            const upstream = socket.connectToServer();
            socket.onMessage((message) => {
              const command = JSON.parse(String(message)) as {
                id: number;
                method: string;
              };
              if (empty && command.method === "Target.getTargets") {
                socket.send(
                  JSON.stringify({
                    id: command.id,
                    result: { targetInfos: [] },
                  }),
                );
                return;
              }
              if (holdCreate && command.method === "Page.createIsolatedWorld") {
                releaseCreate = () => upstream.send(message);
                return;
              }
              upstream.send(message);
            });
          });
          await page.emulateMedia({ colorScheme });
          await page.setViewportSize({ width: 1100, height: 850 });
          const first = await remoteTab(backend, "Layout", true);
          const viewer = await host(page, {
            cdpUrl: backend.endpoint,
            windowA: first.windowId,
            interactive,
            second: false,
          });
          await expect(viewer).toHaveAttribute("data-status", "streaming");
          const hostGutter = await page.evaluate(() => {
            const control = document.createElement("div");
            control.style.cssText =
              "position:absolute;left:0;top:0;width:100px;height:100px;overflow:scroll";
            const content = document.createElement("div");
            content.style.cssText = "width:200px;height:200px";
            control.append(content);
            document.body.append(control);
            const gutter = control.offsetHeight - control.clientHeight;
            control.remove();
            return gutter;
          });
          if (nativeScrollbars) expect(hostGutter).toBeGreaterThan(0);
          else expect(hostGutter).toBe(0);
          await page.evaluate(() => {
            document.documentElement.style.colorScheme = "light dark";
            document.querySelector<HTMLElement>(
              "#panels",
            )!.style.gridTemplateColumns = "minmax(0, 1fr)";
          });
          for (const width of [960, 320]) {
            await viewer.evaluate((root, value) => {
              root.style.width = `${value}px`;
            }, width);
            await expect(viewer.getByRole("tab")).toHaveCount(1);
            const baseline = await viewerGeometry(viewer);
            const create = viewer.getByRole("button", {
              name: "New tab",
              exact: true,
            });
            if (interactive) await create.hover();
            await viewer.screenshot({
              path: info.outputPath(`${width}-one.png`),
            });
            await expectTabBarAlignment(viewer);
            if (interactive) {
              await page.mouse.move(0, 0);
              await expectTabBarAlignment(viewer);
              await create.focus();
              await expect(create).toBeFocused();
              await expectTabBarAlignment(viewer);
            }
            const extras = [];
            for (let index = 0; index < 4; index++)
              extras.push(await remoteTab(backend, `Layout ${index}`));
            await expect(viewer.getByRole("tab")).toHaveCount(5);
            await expect
              .poll(() =>
                viewer
                  .getByRole("tablist")
                  .evaluate((list) => list.scrollWidth <= list.clientWidth + 1),
              )
              .toBe(true);
            const strip = viewer.getByRole("tablist");
            expect(
              await strip.evaluate(
                (list) =>
                  (list as HTMLElement).offsetHeight - list.clientHeight,
              ),
            ).toBe(0);
            await strip.hover();
            await page.mouse.wheel(250, 0);
            await expect
              .poll(() => strip.evaluate((list) => list.scrollLeft))
              .toBe(0);
            expect(await viewerGeometry(viewer)).toEqual(baseline);
            await expectTabBarAlignment(viewer);
            await viewer.screenshot({
              path: info.outputPath(`${width}-overflow.png`),
            });
            for (const extra of extras) await extra.remote.close();
            await expect(viewer.getByRole("tab")).toHaveCount(1);
            expect(await viewerGeometry(viewer)).toEqual(baseline);
            empty = true;
            await first.remote.evaluate((value) => {
              document.title = `Empty ${value}`;
            }, width);
            await expect(viewer.getByRole("tab")).toHaveCount(0);
            await expect(viewer).toHaveAttribute("data-status", "unavailable");
            await viewer.screenshot({
              path: info.outputPath(`${width}-empty.png`),
            });
            expect(await viewerGeometry(viewer)).toEqual(baseline);
            if (interactive) {
              await expect(create).toBeDisabled();
            } else await expect(create).toHaveCount(0);
            await expectTabBarAlignment(viewer);
            empty = false;
            await first.remote.evaluate((value) => {
              document.title = `Layout ${value}`;
            }, width);
            await expect(viewer.getByRole("tab")).toHaveCount(1);
            await viewer.getByRole("tab").click();
            await expect(viewer).toHaveAttribute("data-status", "streaming");
            expect(await viewerGeometry(viewer)).toEqual(baseline);
            if (interactive) {
              holdCreate = true;
              releaseCreate = undefined;
              await create.click();
              await expect.poll(() => !!releaseCreate).toBe(true);
              await expect(create).toBeDisabled();
              await expect(create).toHaveAttribute("aria-busy", "true");
              expect(await viewerGeometry(viewer)).toEqual(baseline);
              await expectTabBarAlignment(viewer);
              await viewer.screenshot({
                path: info.outputPath(`${width}-pending.png`),
              });
              holdCreate = false;
              releaseCreate!();
              await expect(create).toHaveAttribute("aria-busy", "false");
              await expect(viewer.getByRole("tab")).toHaveCount(2);
              await expect(
                viewer.getByRole("tab", { selected: true }),
              ).not.toHaveAttribute("data-target-id", first.targetId);
              await expect(viewer).toHaveAttribute("data-status", "streaming");
              await expectTabBarAlignment(viewer);
              const createdId = await viewer
                .getByRole("tab", { selected: true })
                .getAttribute("data-target-id");
              await viewer
                .locator(`[data-close-target="${createdId}"]`)
                .click();
              await expect(viewer.getByRole("tab")).toHaveCount(1);
              await expect(viewer).toHaveAttribute("data-status", "streaming");
              expect(await viewerGeometry(viewer)).toEqual(baseline);
            }
          }
          const beforeLastClose = await viewerGeometry(viewer);
          if (interactive)
            await viewer
              .locator(`[data-close-target="${first.targetId}"]`)
              .click();
          else await first.remote.close();
          await expect(viewer.getByRole("tab")).toHaveCount(0);
          await expect(viewer).toHaveAttribute("data-status", "unavailable");
          expect(await viewerGeometry(viewer)).toEqual(beforeLastClose);
        } finally {
          try {
            await browser?.close();
          } finally {
            await backend.close();
          }
        }
      });
    }
  }
}

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
          root.style.setProperty("--cdpv-radius", "12px");
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
      const allTabs = a.getByRole("combobox", { name: "All tabs" });
      await expect(a.getByRole("tab")).toHaveCount(13);
      await expect(allTabs).toHaveCount(0);
      await expect
        .poll(() =>
          a
            .locator(".cdpv-tab-item")
            .evaluateAll((items) =>
              items.every((item) => item.getBoundingClientRect().width < 100),
            ),
        )
        .toBe(true);
      await a.getByRole("tab").last().click();
      expect(
        await a.getByRole("tablist").evaluate((list) => list.scrollLeft),
      ).toBe(0);
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
      await a.screenshot({ path: info.outputPath("04-compressed.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(await overflowOptions(a)).toHaveCount(13);
      await page.keyboard.press("Escape");
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

test("styles and bounds overflow popups per viewer without stealing later host focus", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    await page.setViewportSize({ width: 1200, height: 850 });
    let connections = 0;
    page.on("websocket", () => connections++);
    const first = await remoteTab(backend, "Workspace", true);
    const extras = [];
    for (let index = 1; index <= 7; index++)
      extras.push(await remoteTab(backend, `Research ${index}`));
    await extras[0]!.remote.evaluate(() => {
      document.title = "Quarterly planning and customer research ".repeat(6);
    });
    const other = await remoteTab(backend, "Other window", true);
    for (let index = 1; index <= 7; index++)
      await remoteTab(backend, `Other project ${index}`);
    const viewer = await host(page, {
      cdpUrl: backend.endpoint,
      windowA: first.windowId,
      windowB: other.windowId,
      interactive: true,
      hostForm: true,
      colorSchemeA: "light",
      colorSchemeB: "dark",
    });
    const sibling = page.locator("#viewer-b .cdpv-root");
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    await expect(sibling).toHaveAttribute("data-status", "streaming");
    for (const root of [viewer, sibling])
      await root.evaluate((element) => {
        element.style.width = "220px";
        element.style.height = "256px";
      });
    await selectOverflowTab(viewer, first.targetId);
    const canvas = await viewer.locator("canvas").elementHandle();
    const proxy = await viewer
      .getByLabel("Remote browser input")
      .elementHandle();
    const socketCount = connections;
    const hostScroll = await page.evaluate(() => [scrollX, scrollY]);
    const bodyOverflow = await page.evaluate(
      () => document.body.style.overflow,
    );
    const picker = viewer.getByRole("combobox", { name: "All tabs" });
    const popup = viewer.locator(".cdpv-tab-popup");
    const selected = viewer.getByRole("tab", { selected: true });
    const selectedId = await selected.getAttribute("data-target-id");
    await expect(await overflowOptions(viewer)).toHaveCount(8);
    await expect(
      viewer.getByRole("option", { selected: true }),
    ).toHaveAttribute("data-tab-option", selectedId!);
    const geometry = await popup.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const root = element.closest(".cdpv-root")!.getBoundingClientRect();
      const list = element.querySelector('[role="listbox"]')!;
      return {
        inside:
          bounds.left >= root.left &&
          bounds.right <= root.right &&
          bounds.top >= root.top &&
          bounds.bottom <= root.bottom,
        scrolls: list.scrollHeight > list.clientHeight,
        background: getComputedStyle(element).backgroundColor,
        foreground: getComputedStyle(element).color,
        font: getComputedStyle(element).fontFamily,
      };
    });
    expect(geometry.inside).toBe(true);
    expect(geometry.scrolls).toBe(true);
    expect(geometry.background).toBe("rgb(255, 255, 255)");
    expect(geometry.foreground).toBe("rgb(32, 33, 36)");
    expect(geometry.font).toContain("system-ui");
    const longTitle = viewer.locator(
      `[data-tab-option="${extras[0]!.targetId}"]`,
    );
    await longTitle.scrollIntoViewIfNeeded();
    expect((await longTitle.boundingBox())!.height).toBeGreaterThan(60);
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual(hostScroll);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(
      bodyOverflow,
    );
    await page.keyboard.press("Escape");
    await expect(picker).toBeFocused();
    await expect(selected).toHaveAttribute("data-target-id", selectedId!);
    await picker.press("Enter");
    await expect(viewer.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(picker).toBeFocused();
    await expect(selected).toHaveAttribute("data-target-id", selectedId!);
    await expect(page.locator("#host-submissions")).toHaveText("0");
    await overflowOptions(viewer);
    const hostInput = page.getByLabel("Host input", { exact: true });
    await hostInput.click();
    await expect(viewer.getByRole("listbox")).toHaveCount(0);
    await expect(hostInput).toBeFocused();
    await expect(selected).toHaveAttribute("data-target-id", selectedId!);
    await overflowOptions(sibling);
    await expect(sibling.locator(".cdpv-tab-popup")).toHaveCSS(
      "background-color",
      "rgb(53, 54, 58)",
    );
    await expect(
      sibling.getByRole("option", { name: "Workspace" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await viewer.evaluate((element) => {
      element.style.setProperty("--cdpv-background", "rgb(244, 248, 255)");
      element.style.setProperty("--cdpv-foreground", "rgb(12, 34, 56)");
    });
    await overflowOptions(viewer);
    await expect(popup).toHaveCSS("background-color", "rgb(244, 248, 255)");
    await expect(popup).toHaveCSS("color", "rgb(12, 34, 56)");
    await backend.session.send("Target.closeTarget", { targetId: selectedId! });
    await expect(viewer.getByRole("option")).toHaveCount(7);
    await expect(selected).toHaveCount(0);
    await selectOverflowTab(viewer, extras[0]!.targetId);
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    await overflowOptions(viewer);
    await viewer.evaluate((element) => {
      element.style.width = "900px";
    });
    await expect(picker).toHaveCount(0);
    await expect(selected).toBeFocused();
    await viewer.evaluate((element) => {
      element.style.width = "220px";
    });
    expect(
      await viewer
        .locator("canvas")
        .evaluate((element, old) => element === old, canvas),
    ).toBe(true);
    expect(
      await viewer
        .getByLabel("Remote browser input")
        .evaluate((element, old) => element === old, proxy),
    ).toBe(true);
    await overflowOptions(viewer);
    await page.evaluate(() => window.removeFirstViewer!());
    await expect(viewer).toHaveCount(0);
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(sibling).toHaveAttribute("data-status", "streaming");
    await overflowOptions(sibling);
    await page.keyboard.press("Escape");
    expect(connections).toBe(socketCount);
    // The saved elements belonged only to the removed viewer.
    expect(await canvas!.evaluate((element) => element.isConnected)).toBe(
      false,
    );
    expect(await proxy!.evaluate((element) => element.isConnected)).toBe(false);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(
      bodyOverflow,
    );
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual(hostScroll);
    await page
      .getByRole("button", { name: "Host submit", exact: true })
      .click();
    await expect(page.locator("#host-submissions")).toHaveText("1");
  } finally {
    await backend.close();
  }
});

test("keeps view-only overflow lists and resizing scoped to their own window and viewer", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    await page.setViewportSize({ width: 1200, height: 850 });
    const first = await remoteTab(backend, "Workspace", true);
    const extras = [];
    for (let index = 1; index <= 7; index++)
      extras.push(await remoteTab(backend, `Research ${index}`));
    const other = await remoteTab(backend, "Other window", true);
    const viewer = await host(page, {
      cdpUrl: backend.endpoint,
      windowA: first.windowId,
      windowB: other.windowId,
    });
    const sibling = page.locator("#viewer-b .cdpv-root");
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    await expect(sibling).toHaveAttribute("data-status", "streaming");
    const siblingBounds = await sibling.boundingBox();
    const siblingCanvas = await sibling.locator("canvas").elementHandle();
    await viewer.evaluate((root) => {
      root.style.width = "220px";
    });
    const allTabs = viewer.getByRole("combobox", { name: "All tabs" });
    await expect(await overflowOptions(viewer)).toHaveCount(8);
    await expect(
      viewer.getByRole("option", { name: "Other window" }),
    ).toHaveCount(0);
    await selectOverflowTab(viewer, extras.at(-1)!.targetId);
    await expect(
      viewer.getByRole("tab", { selected: true }),
    ).toHaveAccessibleName("Research 7");
    await expect(
      viewer.getByRole("button", { name: "New tab", exact: true }),
    ).toHaveCount(0);
    await expect(viewer.locator(".cdpv-close")).toHaveCount(0);
    await allTabs.focus();
    await viewer.evaluate((root) => {
      root.style.width = "500px";
    });
    await expect(allTabs).toHaveCount(0);
    await expect(viewer.getByRole("tab", { selected: true })).toBeFocused();
    await expect(viewer.getByRole("tab")).toHaveCount(8);
    await expect(
      sibling.getByRole("tab", { selected: true }),
    ).toHaveAccessibleName("Other window");
    expect(await sibling.boundingBox()).toEqual(siblingBounds);
    expect(
      await sibling
        .locator("canvas")
        .evaluate((element, old) => element === old, siblingCanvas),
    ).toBe(true);
    expect(
      await viewer.getByRole("tablist").evaluate((list) => {
        list.scrollLeft = 1000;
        return list.scrollLeft;
      }),
    ).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await backend.close();
  }
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`compresses ${colorScheme} tabs at exact boundaries and keeps every target accessible without scrolling`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    try {
      await page.setViewportSize({ width: 1200, height: 850 });
      const first = await remoteTab(
        backend,
        "Workspace · Planning and research",
        true,
      );
      await remoteTab(backend, "Product notes · Quarterly objectives");
      const last = await remoteTab(backend, "Inbox · Customer conversations");
      const viewer = await host(page, {
        cdpUrl: backend.endpoint,
        windowA: first.windowId,
        interactive: true,
        colorSchemeA: colorScheme,
        second: false,
      });
      await page.locator("#panels").evaluate((element) => {
        element.style.gridTemplateColumns = "minmax(0, 1fr)";
      });
      const size = async (width: number) =>
        viewer.evaluate((root, value) => {
          root.style.width = `${value}px`;
        }, width);
      await size(900);
      await viewer.locator(`[data-target-id="${first.targetId}"]`).click();
      await expect(viewer).toHaveAttribute("data-status", "streaming");
      const canvas = await viewer.locator("canvas").elementHandle();
      const proxy = await viewer
        .getByLabel("Remote browser input")
        .elementHandle();
      const tabs = viewer.getByRole("tab");
      const strip = viewer.getByRole("tablist");
      const allTabs = viewer.getByRole("combobox", { name: "All tabs" });
      const create = viewer.getByRole("button", {
        name: "New tab",
        exact: true,
      });
      await expect
        .poll(() =>
          viewer
            .locator(".cdpv-tab-item")
            .evaluateAll((items) =>
              items.map((item) => item.getBoundingClientRect().width),
            ),
        )
        .toEqual([232, 232, 232]);
      await viewer.screenshot({ path: info.outputPath("comfortable.png") });
      await viewer.locator(`[data-close-target="${last.targetId}"]`).focus();
      await size(320);
      await expect
        .poll(() =>
          viewer
            .locator(".cdpv-tab-item")
            .evaluateAll((items) =>
              items.map((item) => item.getBoundingClientRect().width),
            ),
        )
        .toEqual([85, 85, 85]);
      await expect(
        viewer.locator(`[data-close-target="${first.targetId}"]`),
      ).toBeVisible();
      await expect(
        viewer.locator(`[data-close-target="${last.targetId}"]`),
      ).toBeHidden();
      await expect(viewer.getByRole("tab", { selected: true })).toBeFocused();
      await expect(
        viewer.locator(`[data-target-id="${last.targetId}"]`),
      ).toHaveAccessibleName("Inbox · Customer conversations");
      await viewer.screenshot({ path: info.outputPath("compressed.png") });
      const hostScroll = await page.evaluate(() => [scrollX, scrollY]);
      for (const width of [178, 177, 176, 177, 178]) {
        await size(width);
        await expect(tabs).toHaveCount(width < 177 ? 1 : 3);
        await expect(allTabs).toHaveCount(width < 177 ? 1 : 0);
        expect(
          await strip.evaluate((list) => {
            list.scrollLeft = 500;
            return list.scrollLeft;
          }),
        ).toBe(0);
        await strip.hover();
        await page.mouse.wheel(250, 0);
        expect(await strip.evaluate((list) => list.scrollLeft)).toBe(0);
        await expect(create).toBeInViewport({ ratio: 1 });
        await expectTabBarAlignment(viewer);
      }
      await size(176);
      await expect(allTabs).toBeVisible();
      expect(
        await allTabs.evaluate((select) => {
          const rect = select.getBoundingClientRect();
          return [
            [rect.left + 1, rect.top + rect.height / 2],
            [rect.right - 1, rect.top + rect.height / 2],
          ].every(([x, y]) => document.elementFromPoint(x!, y!) === select);
        }),
      ).toBe(true);
      await selectOverflowTab(viewer, last.targetId);
      await expect(tabs).toHaveCount(1);
      await expect(tabs.first()).toHaveAttribute(
        "data-target-id",
        last.targetId,
      );
      await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
      await allTabs.focus();
      await size(320);
      await expect(allTabs).toHaveCount(0);
      await expect(
        viewer.locator(`[data-target-id="${last.targetId}"]`),
      ).toBeFocused();
      await viewer.getByRole("tab", { selected: false }).first().focus();
      await size(176);
      await expect(tabs).toHaveCount(1);
      await expect(tabs.first()).toBeFocused();
      await viewer.getByRole("img", { name: "Live browser view" }).click();
      await page.keyboard.press("F8");
      await expect(tabs.first()).toBeFocused();
      await viewer.screenshot({ path: info.outputPath("narrow.png") });
      const hostInput = page.getByLabel("Host input", { exact: true });
      await hostInput.focus();
      await size(900);
      await expect(tabs).toHaveCount(3);
      await expect(hostInput).toBeFocused();
      expect(await page.evaluate(() => [scrollX, scrollY])).toEqual(hostScroll);
      expect(
        await viewer
          .locator("canvas")
          .evaluate((element, old) => element === old, canvas),
      ).toBe(true);
      expect(
        await viewer
          .getByLabel("Remote browser input")
          .evaluate((element, old) => element === old, proxy),
      ).toBe(true);
      await expect(viewer).toHaveAttribute("data-status", "streaming");
    } finally {
      await backend.close();
    }
  });

  test(`keeps ${colorScheme} extreme-count tabs reachable through creation closure and metadata updates`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    try {
      const first = await remoteTab(backend, "Workspace", true);
      const extras = [];
      for (let index = 1; index <= 9; index++)
        extras.push(await remoteTab(backend, `Project ${index}`));
      const viewer = await host(page, {
        cdpUrl: backend.endpoint,
        windowA: first.windowId,
        interactive: true,
        colorSchemeA: colorScheme,
        second: false,
      });
      await page.locator("#panels").evaluate((element) => {
        element.style.gridTemplateColumns = "minmax(0, 1fr)";
      });
      await viewer.evaluate((root) => {
        root.style.width = "320px";
      });
      const allTabs = viewer.getByRole("combobox", { name: "All tabs" });
      const options = await overflowOptions(viewer);
      await expect(options).toHaveCount(10);
      const ordered = await options.evaluateAll((options) =>
        options.map((option) => ({
          id: option.getAttribute("data-tab-option")!,
          title: option.textContent!,
        })),
      );
      await selectOverflowTab(viewer, ordered[0]!.id);
      await allTabs.press("ArrowDown");
      await page.keyboard.press("End");
      const selected = viewer.getByRole("tab", { selected: true });
      await expect(selected).toHaveAttribute("data-target-id", ordered[0]!.id);
      await page.keyboard.press("Enter");
      await expect(allTabs).toBeFocused();
      await expect(selected).toHaveAttribute(
        "data-target-id",
        ordered.at(-1)!.id,
      );
      await expect(selected).toHaveAccessibleName(ordered.at(-1)!.title);
      await expect(selected).toBeInViewport({ ratio: 1 });
      const ids = await viewer
        .getByRole("tab")
        .evaluateAll((items) =>
          items.map((item) => item.getAttribute("data-target-id")),
        );
      await extras
        .find((extra) => extra.targetId !== ordered.at(-1)!.id)!
        .remote.evaluate(() => {
          document.title = "Updated background";
        });
      await overflowOptions(viewer);
      await expect(
        viewer.getByRole("option", { name: "Updated background", exact: true }),
      ).toHaveCount(1);
      expect(
        await viewer
          .getByRole("tab")
          .evaluateAll((items) =>
            items.map((item) => item.getAttribute("data-target-id")),
          ),
      ).toEqual(ids);
      await viewer.screenshot({ path: info.outputPath("all-tabs-open.png") });
      await page.keyboard.press("Escape");
      await expect(allTabs).toBeFocused();
      await viewer.screenshot({ path: info.outputPath("extreme.png") });
      await viewer
        .getByRole("button", { name: "New tab", exact: true })
        .click();
      await expect(selected).not.toHaveAttribute(
        "data-target-id",
        ordered.at(-1)!.id,
      );
      await expect(viewer.getByLabel("Remote page address")).toBeFocused();
      await expect(await overflowOptions(viewer)).toHaveCount(11);
      await page.keyboard.press("Escape");
      const created = await selected.getAttribute("data-target-id");
      await viewer.locator(`[data-close-target="${created}"]`).click();
      await expect(selected).toBeFocused();
      await expect(selected).toBeInViewport({ ratio: 1 });
      await expect(await overflowOptions(viewer)).toHaveCount(10);
      await page.keyboard.press("Escape");
      for (const extra of extras) await extra.remote.close();
      await expect(viewer.getByRole("tab")).toHaveCount(1);
      await expect(allTabs).toHaveCount(0);
      await expect(viewer.getByRole("tab")).toHaveAttribute(
        "data-target-id",
        first.targetId,
      );
      expect(
        await viewer.getByRole("tablist").evaluate((list) => list.scrollLeft),
      ).toBe(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await backend.close();
    }
  });
}
