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
}

test("floating address focus uses the live host focus token", async ({
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
      },
    });
    const address = view.getByRole("textbox", { name: "Remote page address" });
    await address.focus();
    await expect(address).toHaveCSS("border-color", "rgb(210, 30, 100)");
    await page.evaluate((value) => window.configureViewers!(value), {
      ...settings,
      styleA: { ...settings.styleA, "--cdpv-focus": "rgb(0, 110, 70)" },
    });
    await expect(address).toBeFocused();
    await expect(address).toHaveCSS("border-color", "rgb(0, 110, 70)");
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
    const overlayInput = view.getByRole("textbox", {
      name: "Host overlay input",
    });
    await overlayInput.click();
    await page.keyboard.type("local draft");
    await expect(overlayInput).toHaveValue("local draft");
    await expect(remote.locator("#plain")).toHaveValue(
      "remote input through overlay",
    );
    await expect(page.locator("#host-submissions")).toHaveText("0");
    const pane = view.getByTestId("host-overlay-scroll");
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
  } finally {
    await backend.close();
  }
});
