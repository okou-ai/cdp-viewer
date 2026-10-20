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

async function editor(
  backend: Awaited<ReturnType<typeof launchBackend>>,
  suffix = "",
) {
  const pageCreated = backend.context.waitForEvent("page");
  const target = await backend.session.send("Target.createTarget", {
    url: server.origin + "/fixture/editor" + suffix,
    newWindow: true,
  });
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    { targetId: target.targetId },
  );
  const remote = await pageCreated;
  await remote.waitForURL(server.origin + "/fixture/editor" + suffix);
  await expect(remote.locator("#plain")).toBeVisible();
  return { remote, windowId, targetId: target.targetId };
}

async function host(
  page: Page,
  backend: Awaited<ReturnType<typeof launchBackend>>,
  windowA?: number,
  windowB?: number,
) {
  await page.goto(server.origin);
  await page.waitForFunction(
    () => typeof window.configureViewers === "function",
  );
  await page.evaluate(async (settings) => window.configureViewers!(settings), {
    cdpUrl: backend.endpoint,
    interactive: true,
    ...(windowA === undefined ? {} : { windowA }),
    ...(windowB === undefined ? { second: false } : { windowB }),
  });
  const a = page.locator("#viewer-a .cdpv-root");
  await expect(a).toHaveAttribute("data-status", "streaming");
  return a;
}

async function imagePosition(
  view: Locator,
  x: number,
  y: number,
  remote: Page,
) {
  const viewport = await remote.evaluate(() => ({
    width: visualViewport?.width ?? innerWidth,
    height: visualViewport?.height ?? innerHeight,
  }));
  return view.locator("canvas").evaluate(
    (canvas: HTMLCanvasElement, value) => {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(
        rect.width / canvas.width,
        rect.height / canvas.height,
      );
      const width = canvas.width * scale,
        height = canvas.height * scale;
      return {
        x:
          rect.left +
          (rect.width - width) / 2 +
          (width * value.x) / value.width,
        y:
          rect.top +
          (rect.height - height) / 2 +
          (height * value.y) / value.height,
      };
    },
    { x, y, ...viewport },
  );
}

async function clickRemote(
  page: Page,
  view: Locator,
  remote: Page,
  selector: string,
) {
  const rect = await remote.locator(selector).boundingBox();
  if (!rect) throw new Error("The owned control has no bounds.");
  const position = await imagePosition(
    view,
    rect.x + 20,
    rect.y + rect.height / 2,
    remote,
  );
  await page.mouse.click(position.x, position.y);
  await expect(
    view.getByRole("textbox", { name: "Remote browser input" }),
    JSON.stringify({
      rect,
      position,
      viewport: await remote.evaluate(() => ({
        width: visualViewport?.width,
        height: visualViewport?.height,
        offsetX: visualViewport?.offsetLeft,
        offsetY: visualViewport?.offsetTop,
        pageY: visualViewport?.pageTop,
        scroll: scrollY,
      })),
    }),
  ).toBeFocused();
  await expect(remote.locator(selector)).toBeFocused();
}

test("interactive public viewers route native text, editing shortcuts and local focus independently", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const first = await editor(backend);
    const secondEditor = await editor(backend, "?second");
    const second = secondEditor.remote;
    const a = await host(page, backend, first.windowId, secondEditor.windowId);
    const b = page.locator("#viewer-b .cdpv-root");
    await expect(b).toHaveAttribute("data-status", "streaming");
    await page.screenshot({
      path: info.outputPath("interactive-viewers.png"),
      fullPage: true,
    });
    await clickRemote(page, a, first.remote, "#plain");
    await page.keyboard.insertText("undo");
    await expect(first.remote.locator("#plain")).toHaveValue("undo");
    await page.keyboard.press("Control+z");
    await expect(first.remote.locator("#plain")).toHaveValue("");
    await page.keyboard.press("Control+Shift+z");
    await expect(first.remote.locator("#plain")).toHaveValue("undo");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await expect(first.remote.locator("#plain")).toHaveValue("");
    await page.keyboard.type("hello");
    await page.keyboard.insertText("🙂");
    await expect(first.remote.locator("#plain")).toHaveValue("hello🙂");
    await expect(second.locator("#plain")).toHaveValue("");
    const plainBox = await first.remote.locator("#plain").boundingBox();
    if (!plainBox) throw new Error("Owned input bounds missing.");
    const word = await imagePosition(
      a,
      plainBox.x + 25,
      plainBox.y + plainBox.height / 2,
      first.remote,
    );
    await page.mouse.dblclick(word.x, word.y);
    await expect
      .poll(() =>
        first.remote
          .locator("#plain")
          .evaluate((e: HTMLInputElement) =>
            e.value.slice(e.selectionStart ?? 0, e.selectionEnd ?? 0),
          ),
      )
      .toBe("hello");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await expect(first.remote.locator("#plain")).toHaveValue("");
    await page.keyboard.press("F8");
    await expect(a.getByRole("combobox")).toBeFocused();
    await page
      .getByRole("textbox", { name: "Host input", exact: true })
      .fill("local only");
    await a
      .getByRole("textbox", { name: "Remote page address" })
      .fill("https://draft.invalid/");
    await expect(first.remote.locator("#plain")).toHaveValue("");
    await clickRemote(page, b, second, "#multiline");
    await page.keyboard.insertText("line one");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("line two");
    await expect(second.locator("#multiline")).toHaveValue(
      "line one\nline two",
    );
    await clickRemote(page, a, first.remote, "button[type=submit]");
    await expect(first.remote.locator("#submits")).toHaveText("1");
    await page.keyboard.press("Space");
    await expect(first.remote.locator("#submits")).toHaveText("2");
    await clickRemote(page, a, first.remote, "#rich");
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("Rich 中文🙂");
    await expect(first.remote.locator("#rich")).toHaveText("Rich 中文🙂");
    await clickRemote(page, a, first.remote, "#shadow input");
    await page.keyboard.insertText("shadow text");
    await expect(first.remote.locator("#shadow input")).toHaveValue(
      "shadow text",
    );
    await page.evaluate(() => window.removeFirstViewer!());
    await clickRemote(page, b, second, "#plain");
    await page.keyboard.type("survives");
    await expect(second.locator("#plain")).toHaveValue("survives");
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");
    await expect(second.locator("#plain")).toHaveValue("");
    await page.keyboard.press("Tab");
    await expect(second.locator("#multiline")).toBeFocused();
    expect(first.remote.isClosed()).toBe(false);
  } finally {
    await backend.close();
  }
});

test("same-document navigation releases owned keys and mouse buttons", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const a = await host(page, backend, windowId);
    await remote.evaluate(() => {
      document.body.dataset.keyReleases = "0";
      document.body.dataset.mouseReleases = "0";
      document.addEventListener("keydown", (event) => {
        if (event.key === "Shift") document.body.dataset.keyHeld = "true";
      });
      document.addEventListener("keyup", (event) => {
        if (event.key === "Shift") {
          document.body.dataset.keyHeld = "false";
          document.body.dataset.keyReleases = String(
            Number(document.body.dataset.keyReleases) + 1,
          );
        }
      });
      document.addEventListener("mousedown", () => {
        document.body.dataset.mouseHeld = "true";
      });
      document.addEventListener("mouseup", () => {
        document.body.dataset.mouseHeld = "false";
        document.body.dataset.mouseReleases = String(
          Number(document.body.dataset.mouseReleases) + 1,
        );
      });
    });
    await clickRemote(page, a, remote, "#plain");
    await page.keyboard.down("Shift");
    await expect(remote.locator("body")).toHaveAttribute(
      "data-key-held",
      "true",
    );
    await remote.evaluate(() => {
      location.hash = "section";
    });
    await expect(remote.locator("body")).toHaveAttribute(
      "data-key-releases",
      "1",
    );
    await expect(remote.locator("body")).toHaveAttribute(
      "data-key-held",
      "false",
    );
    await page.keyboard.up("Shift");
    await expect(
      a.getByRole("textbox", { name: "Remote browser input" }),
    ).not.toBeFocused();

    await clickRemote(page, a, remote, "#plain");
    await remote.evaluate(() => {
      document.body.dataset.mouseReleases = "0";
    });
    await page.mouse.down();
    await expect(remote.locator("body")).toHaveAttribute(
      "data-mouse-held",
      "true",
    );
    await remote.evaluate(() => history.replaceState(null, "", "#replacement"));
    await expect(remote.locator("body")).toHaveAttribute(
      "data-mouse-releases",
      "1",
    );
    await expect(remote.locator("body")).toHaveAttribute(
      "data-mouse-held",
      "false",
    );
    await page.mouse.up();
    await clickRemote(page, a, remote, "#plain");
    await page.keyboard.insertText("recovered");
    await expect(remote.locator("#plain")).toHaveValue("recovered");
  } finally {
    await backend.close();
  }
});

test("pointer input respects contain fitting, remote DPR, page scale, drag and wheel", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const remoteCdp = await backend.context.newCDPSession(remote);
    await remoteCdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1000,
      height: 700,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await remoteCdp.send("Emulation.setPageScaleFactor", {
      pageScaleFactor: 1.5,
    });
    const view = await host(page, backend, windowId);
    expect(await remote.evaluate(() => devicePixelRatio)).toBe(2);
    expect(await remote.evaluate(() => visualViewport!.scale)).toBe(1.5);
    await clickRemote(page, view, remote, "#plain");
    await page.keyboard.insertText("drag selection");
    await expect(remote.locator("#plain")).toHaveValue("drag selection");
    const bounds = await remote.locator("#plain").boundingBox();
    if (!bounds) throw new Error("Owned input bounds missing.");
    const from = await imagePosition(view, bounds.x + 8, bounds.y + 20, remote);
    const to = await imagePosition(view, bounds.x + 100, bounds.y + 20, remote);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(() =>
        remote
          .locator("#plain")
          .evaluate(
            (e: HTMLInputElement) =>
              (e.selectionEnd ?? 0) - (e.selectionStart ?? 0),
          ),
      )
      .toBeGreaterThan(0);
    const canvasBox = await view.locator("canvas").boundingBox();
    if (!canvasBox) throw new Error("Owned canvas bounds missing.");
    // Collapse the existing selection: dragging selected text starts native
    // HTML drag-and-drop, whose dragend legitimately replaces mouseup.
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() =>
        remote
          .locator("#plain")
          .evaluate(
            (e: HTMLInputElement) => e.selectionStart === e.selectionEnd,
          ),
      )
      .toBe(true);
    await remote.evaluate(() => {
      document.body.dataset.releases = "0";
      document.body.dataset.drags = "0";
      document.addEventListener("dragstart", () => {
        document.body.dataset.drags = String(
          Number(document.body.dataset.drags) + 1,
        );
      });
      document.addEventListener("contextmenu", (event) =>
        event.preventDefault(),
      );
      document.addEventListener("mouseup", (event) => {
        document.body.dataset.releases = String(
          Number(document.body.dataset.releases) + 1,
        );
        document.body.dataset.buttons = String(event.buttons);
      });
    });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width + 20, from.y);
    await page.mouse.up();
    await expect(remote.locator("body")).toHaveAttribute("data-releases", "1");
    await expect(remote.locator("body")).toHaveAttribute("data-drags", "0");
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() =>
        remote
          .locator("#plain")
          .evaluate(
            (e: HTMLInputElement) => e.selectionStart === e.selectionEnd,
          ),
      )
      .toBe(true);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button: "left" });
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "left" });
    await page.mouse.up({ button: "right" });
    await expect(remote.locator("body")).toHaveAttribute("data-releases", "3");
    await expect(remote.locator("body")).toHaveAttribute("data-buttons", "0");
    // The contained image leaves side letterboxes in this wide stage.
    const previousFocus = await remote
      .locator("#plain")
      .evaluate((e) => e === document.activeElement);
    await page.mouse.click(canvasBox.x + 1, canvasBox.y + 1);
    expect(
      await remote
        .locator("#plain")
        .evaluate((e) => e === document.activeElement),
    ).toBe(previousFocus);
    const position = await imagePosition(view, 600, 300, remote);
    await page.mouse.move(position.x, position.y);
    const localScroll = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 350);
    await expect
      .poll(() => remote.evaluate(() => visualViewport?.pageTop ?? scrollY))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => scrollY)).toBe(localScroll);
    await clickRemote(page, view, remote, "#rich");
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("after pan");
    await expect(remote.locator("#rich")).toHaveText("after pan");
    await remoteCdp.detach();
  } finally {
    await backend.close();
  }
});

test("navigation is explicit, validates addresses and preserves local toolbar ownership", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const view = await host(page, backend, windowId);
    const address = view.getByRole("textbox", { name: "Remote page address" });
    await expect(address).toHaveValue(server.origin + "/fixture/editor");
    for (const invalid of [
      "javascript:document.body.textContent='unexpected'",
      "reload",
      "back",
      "forward",
      "/relative",
    ]) {
      await clickRemote(page, view, remote, "#plain");
      await expect(view.getByRole("alert")).toHaveCount(0);
      const loadsBefore = await remote.locator("#loads").textContent();
      await address.fill(invalid);
      await address.press("Enter");
      await expect(view.getByRole("alert")).toContainText(
        "absolute http:// or https://",
      );
      expect(remote.url()).toBe(server.origin + "/fixture/editor");
      await expect(remote.locator("#loads")).toHaveText(loadsBefore!);
    }
    await address.fill(server.origin + "/fixture/editor?next");
    expect(remote.url()).toBe(server.origin + "/fixture/editor");
    await address.press("Enter");
    await remote.waitForURL(server.origin + "/fixture/editor?next");
    await expect(address).toHaveValue(server.origin + "/fixture/editor?next");
    await expect(
      view.getByRole("button", { name: "Back remote page" }),
    ).toBeEnabled();
    await view.getByRole("button", { name: "Back remote page" }).click();
    await remote.waitForURL(server.origin + "/fixture/editor");
    await expect(
      view.getByRole("button", { name: "Forward remote page" }),
    ).toBeEnabled();
    await view.getByRole("button", { name: "Forward remote page" }).click();
    await remote.waitForURL(server.origin + "/fixture/editor?next");
    const loads = Number(await remote.locator("#loads").textContent());
    await view.getByRole("button", { name: "Reload remote page" }).click();
    await expect(remote.locator("#loads")).toHaveText(String(loads + 1));
    await clickRemote(page, view, remote, "#plain");
    await page.keyboard.type("after navigation");
    await expect(remote.locator("#plain")).toHaveValue("after navigation");
    await expect(
      page.getByRole("textbox", { name: "Host input", exact: true }),
    ).toHaveValue("");
  } finally {
    await backend.close();
  }
});

test("blur, target replacement and unsupported frame focus discard local composition", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const first = await editor(backend);
    const second = await editor(backend, "?replacement");
    const view = await host(page, backend);
    await view.getByRole("combobox").selectOption(first.targetId);
    await expect(view).toHaveAttribute("data-status", "streaming");
    await clickRemote(page, view, first.remote, "#plain");
    const proxy = view.getByRole("textbox", { name: "Remote browser input" });
    const start = (e: HTMLTextAreaElement) => {
      e.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      e.value = "unfinished";
    };
    const end = (e: HTMLTextAreaElement) => {
      e.value = "must not arrive";
      e.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: "must not arrive",
        }),
      );
      e.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "must not arrive",
        }),
      );
    };
    await proxy.evaluate(start);
    await page
      .getByRole("textbox", { name: "Host input", exact: true })
      .focus();
    await proxy.evaluate(end);
    await expect(first.remote.locator("#plain")).toHaveValue("");
    await clickRemote(page, view, first.remote, "#plain");
    await page.keyboard.type("after blur");
    await expect(first.remote.locator("#plain")).toHaveValue("after blur");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await expect(first.remote.locator("#plain")).toHaveValue("");
    await proxy.evaluate(start);
    await view.getByRole("combobox").selectOption(second.targetId);
    await expect(view).toHaveAttribute("data-status", "streaming");
    await clickRemote(page, view, second.remote, "#plain");
    await proxy.evaluate(end);
    await proxy.evaluate((e: HTMLTextAreaElement) => {
      e.value = "orphan preedit";
      e.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          isComposing: true,
          inputType: "insertCompositionText",
        }),
      );
      e.value = "orphan commit";
      e.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
        }),
      );
    });
    await page.keyboard.type("new owner");
    await expect(second.remote.locator("#plain")).toHaveValue("new owner");
    const frame = second.remote
      .frameLocator("iframe")
      .getByRole("textbox", { name: "Frame input" });
    const frameBox = await frame.boundingBox();
    if (!frameBox) throw new Error("Owned iframe input bounds missing.");
    const point = await imagePosition(
      view,
      frameBox.x + 20,
      frameBox.y + 10,
      second.remote,
    );
    await page.mouse.click(point.x, point.y);
    await page.keyboard.type("blocked");
    await expect(view.getByRole("alert")).toContainText(
      "focused frame is unsupported",
    );
    await expect(frame).toHaveValue("");
    await expect(second.remote.locator("#plain")).toHaveValue("new owner");
    await clickRemote(page, view, second.remote, "button[type=submit]");
    await expect(view.getByRole("alert")).toHaveCount(0);
    await expect(second.remote.locator("#submits")).toHaveText("1");
    await page.keyboard.press("Space");
    await expect(second.remote.locator("#submits")).toHaveText("2");
  } finally {
    await backend.close();
  }
});

test("composition commits once, cancels locally and keeps candidate Enter separate", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const view = await host(page, backend, windowId);
    await clickRemote(page, view, remote, "#plain");
    const proxy = view.getByRole("textbox", { name: "Remote browser input" });
    for (const ordering of ["before", "after", "none"]) {
      await proxy.evaluate((element: HTMLTextAreaElement, order) => {
        element.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true }),
        );
        element.value = "zhong";
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            isComposing: true,
            inputType: "insertCompositionText",
            data: "zhong",
          }),
        );
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            key: "Enter",
            code: "Enter",
            keyCode: 229,
            isComposing: true,
          }),
        );
        element.value = "中";
        if (order === "before")
          element.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              isComposing: true,
              data: "中",
            }),
          );
        element.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "中" }),
        );
        if (order !== "none")
          element.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertFromComposition",
              data: "中",
            }),
          );
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            key: "Enter",
            code: "Enter",
            keyCode: 229,
          }),
        );
        element.dispatchEvent(
          new KeyboardEvent("keyup", {
            bubbles: true,
            key: "Enter",
            code: "Enter",
            keyCode: 13,
          }),
        );
      }, ordering);
    }
    await expect(remote.locator("#plain")).toHaveValue("中中中");
    await expect(remote.locator("#submits")).toHaveText("0");
    await clickRemote(page, view, remote, "#multiline");
    await proxy.evaluate((element: HTMLTextAreaElement) => {
      element.value = "中";
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromComposition",
          data: "中",
        }),
      );
    });
    await expect(remote.locator("#multiline")).toHaveValue("");
    await page.keyboard.insertText("new owner");
    await expect(remote.locator("#multiline")).toHaveValue("new owner");
    await clickRemote(page, view, remote, "#plain");
    await page.keyboard.insertText("中");
    await expect(remote.locator("#plain")).toHaveValue("中中中中");
    await proxy.evaluate((element: HTMLTextAreaElement) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      element.value = "cancel";
      element.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "" }),
      );
      element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await page.keyboard.press("Enter");
    await expect(remote.locator("#submits")).toHaveText("1");
    await expect(remote.locator("#plain")).toHaveValue("中中中中");
  } finally {
    await backend.close();
  }
});
