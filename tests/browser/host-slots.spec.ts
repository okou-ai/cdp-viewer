import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { launchBackend, serveBrowserConsumer } from "./backend";
import type { FixtureSettings } from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

async function openHost(
  page: Page,
  backend: Awaited<ReturnType<typeof launchBackend>>,
  options: Partial<FixtureSettings>,
  tabs = 1,
  blank = false,
) {
  const opened = backend.context.waitForEvent("page");
  const { targetId } = await backend.session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const remote = await opened;
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    {
      targetId,
    },
  );
  if (!blank) await remote.goto(server.origin + "/fixture/editor");
  for (let index = 1; index < tabs; index++) {
    const { targetId } = await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/blue",
    });
    expect(
      (await backend.session.send("Browser.getWindowForTarget", { targetId }))
        .windowId,
    ).toBe(windowId);
  }
  const traffic = { sockets: 0, attachments: 0 };
  await page.routeWebSocket(backend.endpoint, (socket) => {
    traffic.sockets++;
    const upstream = socket.connectToServer();
    socket.onMessage((data) => {
      const request = JSON.parse(String(data)) as { method: string };
      if (request.method === "Target.attachToTarget") traffic.attachments++;
      upstream.send(data);
    });
  });
  await page.goto(server.origin);
  await page.waitForFunction(
    () => typeof window.configureViewers === "function",
  );
  const settings: FixtureSettings = {
    cdpUrl: backend.endpoint,
    windowA: windowId,
    interactive: true,
    second: false,
    styleA: { width: "500px" },
    ...options,
  };
  await page.evaluate((value) => window.configureViewers!(value), settings);
  const view = page.locator("#viewer-a .cdpv-root");
  await expect(view).toHaveAttribute("data-status", "streaming");
  await view.locator(`[role="tab"][data-target-id="${targetId}"]`).click();
  await expect(view.getByRole("tab", { selected: true })).toHaveAttribute(
    "data-target-id",
    targetId,
  );
  await expect(view).toHaveAttribute("data-status", "streaming");
  return { remote, view, settings, traffic };
}

async function clickRemoteField(page: Page, view: Locator, remote: Page) {
  const field = await remote.locator("#plain").boundingBox();
  if (!field) throw new Error("Remote input bounds missing");
  const viewport = await remote.evaluate(() => ({
    width: visualViewport?.width ?? innerWidth,
    height: visualViewport?.height ?? innerHeight,
  }));
  const point = await view.locator("canvas").evaluate(
    (canvas: HTMLCanvasElement, { field, viewport }) => {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(
        rect.width / canvas.width,
        rect.height / canvas.height,
      );
      const width = canvas.width * scale;
      const height = canvas.height * scale;
      return {
        x:
          rect.left +
          (rect.width - width) / 2 +
          (width * (field.x + field.width / 2)) / viewport.width,
        y:
          rect.top +
          (rect.height - height) / 2 +
          (height * (field.y + field.height / 2)) / viewport.height,
      };
    },
    { field, viewport },
  );
  await page.mouse.click(point.x, point.y);
}

for (const tabStyleA of ["attached", "floating"] as const) {
  test(`${tabStyleA}: changing host controls reflows tabs without replacing the viewer`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    try {
      const { view, remote, settings, traffic } = await openHost(
        page,
        backend,
        {
          tabStyleA,
          toolbarLabel: "Host controls",
        },
        7,
      );
      const initial = { ...traffic };
      const canvas = await view.locator("canvas").elementHandle();
      const input = view.getByRole("textbox", { name: "Remote browser input" });
      const inputNode = await input.elementHandle();
      await expect(view.getByRole("tab")).toHaveCount(7);
      const allTabs = view.getByRole("combobox", { name: "All tabs" });
      await expect(allTabs).toHaveCount(0);
      const hostAction = view.getByRole("button", {
        name: "Host controls",
        exact: true,
      });

      // The slot's own state changes its width without changing viewer props.
      await hostAction.click();
      await expect(hostAction).toHaveAttribute("aria-pressed", "true");
      await expect(allTabs).toBeVisible();
      await allTabs.click();
      await expect(view.getByRole("option")).toHaveCount(7);
      await page.keyboard.press("Escape");
      await hostAction.click();
      await expect(allTabs).toHaveCount(0);
      await expect(view.getByRole("tab")).toHaveCount(7);

      await hostAction.click();
      await expect(allTabs).toBeVisible();
      const { toolbarLabel: _toolbarLabel, ...withoutToolbar } = settings;
      await page.evaluate(
        (value) => window.configureViewers!(value),
        withoutToolbar,
      );
      await expect(hostAction).toHaveCount(0);
      await expect(allTabs).toHaveCount(0);
      await expect(view.getByRole("tab")).toHaveCount(7);
      await page.evaluate((value) => window.configureViewers!(value), settings);
      await expect(hostAction).toBeVisible();
      await expect(view.getByRole("tab")).toHaveCount(7);

      await remote.locator("#plain").focus();
      await input.focus();
      await page.keyboard.insertText("host controls preserve remote input");
      await expect(remote.locator("#plain")).toHaveValue(
        "host controls preserve remote input",
      );
      const nextStyle = tabStyleA === "attached" ? "floating" : "attached";
      await page.evaluate((value) => window.configureViewers!(value), {
        ...settings,
        tabStyleA: nextStyle,
      } satisfies FixtureSettings);
      await expect(view).toHaveAttribute("data-tab-style", nextStyle);
      await expect(view.getByRole("tab")).toHaveCount(7);
      await expect(input).toBeFocused();
      await page.keyboard.insertText(" after presentation change");
      await expect(remote.locator("#plain")).toHaveValue(
        "host controls preserve remote input after presentation change",
      );
      expect(
        await view
          .locator("canvas")
          .evaluate((node, old) => node === old, canvas),
      ).toBe(true);
      expect(await input.evaluate((node, old) => node === old, inputNode)).toBe(
        true,
      );
      expect(traffic).toEqual(initial);
      await canvas?.dispose();
      await inputNode?.dispose();
    } finally {
      await backend.close();
    }
  });

  test(`${tabStyleA}: the tab picker stays above interactive host stage content`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    try {
      const { view, settings } = await openHost(
        page,
        backend,
        {
          tabStyleA,
          toolbarLabel: "Host controls",
          hostOverlay: true,
          styleA: { width: "500px", height: "440px" },
        },
        7,
      );
      await page.evaluate((value) => window.configureViewers!(value), {
        ...settings,
        styleA: { width: "300px", height: "440px" },
      } satisfies FixtureSettings);
      await view.getByRole("combobox", { name: "All tabs" }).click();
      await expect(view.getByRole("option")).toHaveCount(7);
      const overlap = await view.evaluate((root) => {
        const host = root.querySelector(".cdpv-stage-overlay button")!;
        const hostRect = host.getBoundingClientRect();
        for (const option of root.querySelectorAll("[role=option]")) {
          const rect = option.getBoundingClientRect();
          const left = Math.max(rect.left, hostRect.left);
          const right = Math.min(rect.right, hostRect.right);
          const top = Math.max(rect.top, hostRect.top);
          const bottom = Math.min(rect.bottom, hostRect.bottom);
          if (left >= right || top >= bottom) continue;
          const x = (left + right) / 2;
          const y = (top + bottom) / 2;
          return {
            x,
            y,
            targetId: option.getAttribute("data-tab-option"),
            popupOnTop: option.contains(document.elementFromPoint(x, y)),
          };
        }
        return null;
      });
      if (!overlap) throw new Error("Host control does not overlap the popup");
      expect(overlap.popupOnTop).toBe(true);
      await page.mouse.click(overlap.x, overlap.y);
      await expect(view.getByRole("tab", { selected: true })).toHaveAttribute(
        "data-target-id",
        overlap.targetId!,
      );
      await expect(view.getByRole("option")).toHaveCount(0);
      await expect(page.locator("#host-slot-actions")).toHaveText("0");
    } finally {
      await backend.close();
    }
  });
}

test("tab presentation preserves independent host shapes and live focus tokens", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { view, settings } = await openHost(page, backend, {
      tabStyleA: "floating",
      styleA: {
        width: "500px",
        "--cdpv-accent": "rgb(0, 90, 180)",
        "--cdpv-focus": "rgb(210, 30, 100)",
        "--cdpv-control-radius": "6px",
        "--cdpv-address-radius": "4px",
        "--cdpv-stage-focus-width": "1px",
      },
    });
    const address = view.getByRole("textbox", { name: "Remote page address" });
    const back = view.getByRole("button", { name: "Back remote page" });
    const stage = view.locator(".cdpv-stage");
    const input = view.getByRole("textbox", { name: "Remote browser input" });
    const navigation = await view.locator(".cdpv-navigation").boundingBox();
    await input.focus();
    await expect(stage).toHaveCSS("outline-width", "1px");
    await expect(stage).toHaveCSS("outline-color", "rgb(210, 30, 100)");
    await page.keyboard.press("Tab");
    await address.focus();
    await expect(stage).toHaveCSS("outline-style", "none");
    await expect(address).toHaveCSS("outline-color", "rgb(210, 30, 100)");
    await expect(address).toHaveCSS("outline-width", "2px");
    await expect(address).toHaveCSS("border-radius", "4px");
    await expect(back).toHaveCSS("border-radius", "6px");
    await page.evaluate((value) => window.configureViewers!(value), {
      ...settings,
      tabStyleA: "attached",
    } satisfies FixtureSettings);
    await expect(view).toHaveAttribute("data-tab-style", "attached");
    await expect(address).toBeFocused();
    await expect(address).toHaveCSS("border-radius", "4px");
    await expect(back).toHaveCSS("border-radius", "6px");
    expect((await view.locator(".cdpv-navigation").boundingBox())?.height).toBe(
      navigation?.height,
    );
    await page.evaluate((value) => window.configureViewers!(value), {
      ...settings,
      styleA: {
        ...settings.styleA,
        "--cdpv-focus": "rgb(0, 110, 70)",
        "--cdpv-address-radius": "12px",
      },
    });
    await expect(address).toBeFocused();
    await expect(address).toHaveCSS("outline-color", "rgb(0, 110, 70)");
    await expect(address).toHaveCSS("border-radius", "12px");
    await input.focus();
    await expect(stage).toHaveCSS("outline-width", "1px");
    await expect(stage).toHaveCSS("outline-color", "rgb(0, 110, 70)");
  } finally {
    await backend.close();
  }
});

test("blank-page and overlay slots keep host actions local and let remote input through", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { view, remote } = await openHost(
      page,
      backend,
      {
        tabStyleA: "floating",
        hostForm: true,
        hostBlankPage: true,
        hostOverlay: true,
        labelsA: {
          addressPlaceholder: "Host address",
          blankTabTitle: "Host start tab",
        },
      },
      1,
      true,
    );
    await expect(
      view.getByRole("tab", { name: "Host start tab" }),
    ).toBeVisible();
    const startInput = view.getByRole("textbox", { name: "Start page input" });
    await startInput.fill("local draft");
    await expect(startInput).toHaveValue("local draft");
    const stage = view.locator(".cdpv-stage");
    await expect(startInput).toBeFocused();
    await expect(stage).toHaveCSS("outline-style", "none");
    await view.getByText("Start page content", { exact: true }).click({
      clickCount: 3,
    });
    expect(await page.evaluate(() => getSelection()?.toString())).toContain(
      "Start page content",
    );
    await view.getByRole("button", { name: "Start page action" }).click();
    await expect(page.locator("#host-slot-actions")).toHaveText("1");
    await expect(page.locator("#host-submissions")).toHaveText("0");
    const address = view.getByRole("textbox", { name: "Remote page address" });
    await expect(address).toHaveAttribute("placeholder", "Host address");
    await address.fill(server.origin + "/fixture/editor");
    await address.press("Enter");
    await expect(remote.locator("#plain")).toBeVisible();
    await expect(startInput).toHaveCount(0);
    await expect(view).toHaveAttribute("data-status", "streaming");
    await clickRemoteField(page, view, remote);
    await page.keyboard.insertText("remote input through overlay");
    await expect(remote.locator("#plain")).toHaveValue(
      "remote input through overlay",
    );
    const overlayAction = view.getByRole("button", {
      name: "Host overlay action",
    });
    await overlayAction.click();
    await expect(page.locator("#host-slot-actions")).toHaveText("2");
    await expect(overlayAction).toBeFocused();
    await expect(stage).toHaveCSS("outline-style", "none");
    const overlayInput = view.getByRole("textbox", {
      name: "Host overlay input",
    });
    await overlayInput.click();
    await page.keyboard.type("local draft");
    await expect(overlayInput).toHaveValue("local draft");
    await expect(stage).toHaveCSS("outline-style", "none");
    await expect(remote.locator("#plain")).toHaveValue(
      "remote input through overlay",
    );
    await expect(page.locator("#host-submissions")).toHaveText("0");
    const pane = view.getByTestId("host-overlay-scroll");
    await view.getByText("Host scroll area", { exact: true }).click({
      clickCount: 3,
    });
    expect(await page.evaluate(() => getSelection()?.toString())).toContain(
      "Host scroll area",
    );
    const remoteScroll = await remote.evaluate(() => scrollY);
    await pane.hover();
    await page.mouse.wheel(0, 80);
    await expect
      .poll(() => pane.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await remote.evaluate(() => scrollY)).toBe(remoteScroll);
    await pane.evaluate((element) => {
      element.addEventListener("contextmenu", (event) => {
        queueMicrotask(() => {
          document.body.dataset.hostContextPrevented = String(
            event.defaultPrevented,
          );
        });
      });
    });
    await pane.click({ button: "right" });
    await expect(page.locator("body")).toHaveAttribute(
      "data-host-context-prevented",
      "false",
    );
    await page.keyboard.press("Escape");
    await pane.evaluate((element) => {
      element.scrollTop = 0;
      getSelection()?.removeAllRanges();
    });
    await expect
      .poll(() => pane.evaluate((element) => element.scrollTop))
      .toBe(0);
    const bounds = await pane.boundingBox();
    if (!bounds) throw new Error("Host scroll area has no bounds");
    const touch = await page.context().newCDPSession(page);
    try {
      await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      for (let step = 0; step <= 4; step++) {
        await touch.send("Input.dispatchTouchEvent", {
          type: step === 0 ? "touchStart" : "touchMove",
          touchPoints: [
            {
              id: 1,
              x: bounds.x + bounds.width / 2,
              y:
                bounds.y +
                bounds.height -
                8 -
                ((bounds.height - 16) * step) / 4,
            },
          ],
        });
        // Native touch scrolling consumes successive input samples on frames.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
      }
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect
        .poll(() => pane.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      expect(await remote.evaluate(() => scrollY)).toBe(remoteScroll);
    } finally {
      await touch.send("Emulation.setTouchEmulationEnabled", {
        enabled: false,
      });
      await touch.detach();
    }
  } finally {
    await backend.close();
  }
});
