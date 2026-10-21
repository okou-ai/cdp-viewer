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
  await server?.close();
  await consumer?.cleanup();
});

async function embed(
  page: Page,
  backend: Awaited<ReturnType<typeof launchBackend>>,
) {
  const created = backend.context.waitForEvent("page");
  const target = await backend.session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    {
      targetId: target.targetId,
    },
  );
  const remote = await created;
  await remote.goto(server.origin + "/fixture/editor");
  await page.goto(server.origin);
  await page.waitForFunction(
    () => typeof window.configureViewers === "function",
  );
  await page.evaluate(async (settings) => window.configureViewers!(settings), {
    cdpUrl: backend.endpoint,
    interactive: true,
    second: false,
    windowA: windowId,
    hostForm: true,
  });
  const view = page.locator("#viewer-a .cdpv-root");
  await expect(view).toHaveAttribute("data-status", "streaming");
  await expect
    .poll(() =>
      view
        .locator("canvas")
        .evaluate((canvas: HTMLCanvasElement) => canvas.width),
    )
    .toBeGreaterThan(1);
  return { view, remote, targetId: target.targetId };
}

async function imagePosition(
  view: Locator,
  remote: Page,
  x: number,
  y: number,
) {
  const viewport = await remote.evaluate(() => ({
    width: visualViewport?.width ?? innerWidth,
    height: visualViewport?.height ?? innerHeight,
  }));
  return view.locator("canvas").evaluate(
    (canvas: HTMLCanvasElement, point) => {
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
          (width * point.x) / point.width,
        y:
          rect.top +
          (rect.height - height) / 2 +
          (height * point.y) / point.height,
      };
    },
    { x, y, ...viewport },
  );
}

test("host forms, normalization and overlays retain their ownership", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { view, remote, targetId } = await embed(page, backend);
    await expect(view).toHaveCSS("display", "flex");
    await expect(view).toHaveCSS("flex-direction", "column");
    const stage = await view.locator(".cdpv-stage").boundingBox();
    const navigation = await view.locator(".cdpv-navigation").boundingBox();
    expect(stage!.y).toBeGreaterThanOrEqual(navigation!.y + navigation!.height);
    expect(stage!.height).toBeGreaterThan(100);

    const create = view.getByRole("button", { name: "New tab", exact: true });
    const bounds = await create.boundingBox();
    if (!bounds) throw new Error("New-tab bounds missing.");
    await page.evaluate((rect) => {
      const overlay = document.createElement("button");
      overlay.id = "host-overlay";
      overlay.type = "button";
      overlay.textContent = "Overlay";
      Object.assign(overlay.style, {
        position: "fixed",
        zIndex: "0",
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      overlay.onclick = () => {
        overlay.dataset.clicked = "true";
      };
      document.body.append(overlay);
    }, bounds);
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await expect(page.locator("#host-overlay")).toHaveAttribute(
      "data-clicked",
      "true",
    );
    await page.locator("#host-overlay").evaluate((overlay) => overlay.remove());

    await page.getByRole("button", { name: "Host count: 0" }).click();
    const hostInput = page.getByRole("textbox", {
      name: "Host input",
      exact: true,
    });
    await hostInput.fill("retained host draft");
    const address = view.getByRole("textbox", { name: "Remote page address" });
    await address.fill(server.origin + "/fixture/blue");
    let hostNavigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) hostNavigations++;
    });
    await address.press("Enter");
    await expect(remote).toHaveURL(server.origin + "/fixture/blue");
    await expect(view).toHaveAttribute("data-status", "streaming");
    await expect(address).toBeFocused();
    await expect(hostInput).toHaveValue("retained host draft");
    await expect(
      page.getByRole("button", { name: "Host count: 1" }),
    ).toBeVisible();
    await expect(page.locator("#host-submissions")).toHaveText("0");
    expect(hostNavigations).toBe(0);
    await create.click();
    await expect(view.getByRole("tab")).toHaveCount(2);
    await expect(view.getByRole("tab", { selected: true })).not.toHaveAttribute(
      "data-target-id",
      targetId,
    );
    await expect(page.locator("#host-submissions")).toHaveText("0");
    await page
      .getByRole("button", { name: "Host submit", exact: true })
      .click();
    await expect(page.locator("#host-submissions")).toHaveText("1");
    await page.screenshot({ path: info.outputPath("host-integration.png") });
  } finally {
    await backend.close();
  }
});

test("handled remote keys and wheel do not trigger host bubbling shortcuts", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { view, remote } = await embed(page, backend);
    await page.evaluate(() => {
      for (const name of ["keydown", "keyup", "wheel"] as const) {
        document.body.dataset[name] = "0";
        document.addEventListener(name, (event) => {
          if (event instanceof KeyboardEvent && event.key !== "Escape") return;
          document.body.dataset[name] = String(
            Number(document.body.dataset[name]) + 1,
          );
        });
      }
    });
    await remote.evaluate(() => {
      for (const name of ["keydown", "keyup"] as const) {
        document.body.dataset[name] = "0";
        document.addEventListener(name, (event) => {
          if (event.key === "Escape")
            document.body.dataset[name] = String(
              Number(document.body.dataset[name]) + 1,
            );
        });
      }
    });
    const inputBounds = await remote.locator("#plain").boundingBox();
    if (!inputBounds) throw new Error("Remote input bounds missing.");
    const input = await imagePosition(
      view,
      remote,
      inputBounds.x + 20,
      inputBounds.y + inputBounds.height / 2,
    );
    await page.mouse.click(input.x, input.y);
    const proxy = view.getByRole("textbox", { name: "Remote browser input" });
    await expect(proxy).toBeFocused();
    await expect(remote.locator("#plain")).toBeFocused();
    await page.keyboard.type("remote");
    await expect(remote.locator("#plain")).toHaveValue("remote");
    await page.keyboard.press("Escape");
    await expect(remote.locator("body")).toHaveAttribute("data-keydown", "1");
    await expect(remote.locator("body")).toHaveAttribute("data-keyup", "1");
    await expect(page.locator("body")).toHaveAttribute("data-keydown", "0");
    await expect(page.locator("body")).toHaveAttribute("data-keyup", "0");

    const wheel = await imagePosition(view, remote, 600, 300);
    await page.mouse.move(wheel.x, wheel.y);
    const localScroll = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 350);
    await expect.poll(() => remote.evaluate(() => scrollY)).toBeGreaterThan(0);
    expect(await page.evaluate(() => scrollY)).toBe(localScroll);
    await expect(page.locator("body")).toHaveAttribute("data-wheel", "0");

    await page.keyboard.press("F8");
    await expect(view.getByRole("tab", { selected: true })).toBeFocused();
    const hostInput = page.getByRole("textbox", {
      name: "Host input",
      exact: true,
    });
    await hostInput.fill("local");
    await hostInput.press("Escape");
    await expect(hostInput).toHaveValue("local");
    await expect(page.locator("body")).toHaveAttribute("data-keydown", "1");
    await expect(page.locator("body")).toHaveAttribute("data-keyup", "1");
    await hostInput.hover();
    await page.mouse.wheel(0, 50);
    await expect(page.locator("body")).toHaveAttribute("data-wheel", "1");
    await expect(page.locator("#host-submissions")).toHaveText("0");
    await expect(remote.locator("#plain")).toHaveValue("remote");
  } finally {
    await backend.close();
  }
});
