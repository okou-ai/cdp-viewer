import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { launchBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => {
  await server?.close();
});

async function editor(
  backend: Awaited<ReturnType<typeof launchBackend>>,
  suffix = "",
) {
  const pageCreated = backend.context.waitForEvent("page");
  const target = await backend.session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    { targetId: target.targetId },
  );
  const remote = await pageCreated;
  // Let Playwright install its frame worlds before the iframe fixture loads.
  await remote.goto(server.origin + "/fixture/editor" + suffix);
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

test("batches wheel tasks before a frame and admits them before a later key", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    await remote.evaluate(() => {
      document.body.dataset.wheel = "0";
      document.body.dataset.keys = "0";
      document.body.dataset.releases = "0";
      document.addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          document.body.dataset.wheel = String(
            Number(document.body.dataset.wheel) + event.deltaY,
          );
        },
        { passive: false },
      );
      document.addEventListener("keydown", (event) => {
        event.preventDefault();
        document.body.dataset.keys = String(
          Number(document.body.dataset.keys) + 1,
        );
      });
      document.addEventListener("keyup", () => {
        document.body.dataset.releases = String(
          Number(document.body.dataset.releases) + 1,
        );
      });
    });
    const commands: {
      method?: string;
      params?: { type?: string; deltaY?: number };
    }[] = [];
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const command = JSON.parse(
          String(message),
        ) as (typeof commands)[number];
        if (command.method?.startsWith("Input.")) commands.push(command);
        upstream.send(message);
      });
      upstream.onMessage((message) => socket.send(message));
    });
    const view = await host(page, backend, windowId);
    await view.getByRole("textbox", { name: "Remote browser input" }).focus();
    const position = await imagePosition(view, 500, 300, remote);
    const before = await view
      .locator("canvas")
      .evaluate(async (canvas, point) => {
        const request = window.requestAnimationFrame;
        const cancel = window.cancelAnimationFrame;
        const callbacks = new Map<number, FrameRequestCallback>();
        let next = 0;
        window.requestAnimationFrame = (callback) => {
          callbacks.set(++next, callback);
          return next;
        };
        window.cancelAnimationFrame = (id) => {
          callbacks.delete(id);
        };
        try {
          const task = () =>
            new Promise<void>((resolve) => {
              const channel = new MessageChannel();
              channel.port1.onmessage = () => {
                channel.port1.close();
                channel.port2.close();
                resolve();
              };
              channel.port2.postMessage(null);
            });
          for (let index = 0; index < 8; index++) {
            canvas.dispatchEvent(
              new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                clientX: point.x,
                clientY: point.y,
                deltaY: 12,
              }),
            );
            await task();
          }
          const pending = callbacks.size;
          const proxy = canvas.parentElement!.querySelector("textarea")!;
          proxy.dispatchEvent(
            new KeyboardEvent("keydown", {
              bubbles: true,
              cancelable: true,
              key: "ArrowLeft",
              code: "ArrowLeft",
            }),
          );
          proxy.dispatchEvent(
            new KeyboardEvent("keyup", {
              bubbles: true,
              cancelable: true,
              key: "ArrowLeft",
              code: "ArrowLeft",
            }),
          );
          return pending;
        } finally {
          window.requestAnimationFrame = request;
          window.cancelAnimationFrame = cancel;
          for (const callback of callbacks.values())
            callback(performance.now());
        }
      }, position);
    expect(before).toBeGreaterThanOrEqual(1);
    await expect(remote.locator("body")).toHaveAttribute("data-wheel", "96");
    await expect(remote.locator("body")).toHaveAttribute("data-keys", "1");
    await expect(remote.locator("body")).toHaveAttribute("data-releases", "1");
    // Chromium's wheel compositor barrier can deliver DOM callbacks after a
    // later key. Verify ordered CDP admission and remote effects independently.
    expect(
      commands.map((command) => [command.method, command.params?.type]),
    ).toEqual([
      ["Input.dispatchMouseEvent", "mouseWheel"],
      ["Input.dispatchKeyEvent", "rawKeyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
    ]);
    expect(commands[0]?.params?.deltaY).toBe(96);
    await expect(view).toHaveAttribute("data-status", "streaming");
  } finally {
    await backend.close();
  }
});

test("forwards new wheel distance while an earlier dispatch response is held", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    await remote.evaluate(() => {
      document.body.dataset.wheel = "0";
      document.addEventListener("wheel", (event) => {
        document.body.dataset.wheel = String(
          Number(document.body.dataset.wheel) + event.deltaY,
        );
      });
    });
    const wheels: number[] = [];
    let heldId: number | undefined;
    let release: (() => void) | undefined;
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as {
          id?: number;
          method?: string;
          params?: { type?: string; deltaY?: number };
        };
        if (
          command.method === "Input.dispatchMouseEvent" &&
          command.params?.type === "mouseWheel"
        ) {
          wheels.push(command.params.deltaY!);
          if (wheels.length === 1) heldId = command.id;
        }
        upstream.send(message);
      });
      upstream.onMessage((message) => {
        const response = JSON.parse(String(message)) as { id?: number };
        if (heldId !== undefined && response.id === heldId)
          release = () => socket.send(message);
        else socket.send(message);
      });
    });
    const view = await host(page, backend, windowId);
    const position = await imagePosition(view, 500, 300, remote);
    const wheel = (count: number) =>
      view.locator("canvas").evaluate(
        (canvas, value) => {
          for (let i = 0; i < value.count; i++)
            canvas.dispatchEvent(
              new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                clientX: value.x,
                clientY: value.y,
                deltaY: 12,
              }),
            );
        },
        { ...position, count },
      );
    await wheel(1);
    await expect.poll(() => typeof release).toBe("function");
    await wheel(20);
    await expect(remote.locator("body")).toHaveAttribute("data-wheel", "252");
    expect(wheels.reduce((total, delta) => total + delta, 0)).toBe(252);
    expect(wheels[0]).toBe(12);
    expect(wheels.length).toBeGreaterThan(1);
    release!();
  } finally {
    await backend.close();
  }
});

test("continuous wheel input survives delayed replies without dropping focus or scroll distance", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    await remote.evaluate(() => {
      document.body.dataset.wheel = "0";
      document.addEventListener("wheel", (event) => {
        document.body.dataset.wheel = String(
          Number(document.body.dataset.wheel) + event.deltaY,
        );
      });
    });
    const wheels: number[] = [];
    const ids = new Set<number>();
    const replies: (() => void)[] = [];
    let hold = true;
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as {
          id?: number;
          method?: string;
          params?: { type?: string; deltaY?: number };
        };
        if (
          command.id !== undefined &&
          command.method === "Input.dispatchMouseEvent" &&
          command.params?.type === "mouseWheel"
        ) {
          wheels.push(command.params.deltaY!);
          ids.add(command.id);
        }
        upstream.send(message);
      });
      upstream.onMessage((message) => {
        const response = JSON.parse(String(message)) as { id?: number };
        if (hold && response.id !== undefined && ids.delete(response.id))
          replies.push(() => socket.send(message));
        else socket.send(message);
      });
    });
    const view = await host(page, backend, windowId);
    await clickRemote(page, view, remote, "#plain");
    const position = await imagePosition(view, 500, 300, remote);
    // Each message is a client task, letting input sends drain between events
    // without driver round trips extending the hold past the request deadline.
    await view.locator("canvas").evaluate(async (canvas, point) => {
      await new Promise<void>((resolve) => {
        const tasks = new MessageChannel();
        let sent = 0;
        tasks.port1.onmessage = () => {
          canvas.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              clientX: point.x,
              clientY: point.y,
              deltaY: 12,
            }),
          );
          if (++sent === 160) {
            tasks.port1.close();
            tasks.port2.close();
            resolve();
          } else tasks.port2.postMessage(null);
        };
        tasks.port2.postMessage(null);
      });
    }, position);
    await expect.poll(() => replies.length).toBeGreaterThan(1);
    expect(wheels.length).toBeGreaterThan(1);
    expect(wheels.length).toBeLessThanOrEqual(64);
    await expect(view.getByRole("alert")).toHaveCount(0);
    await expect(
      view.getByRole("textbox", { name: "Remote browser input" }),
    ).toBeFocused();
    hold = false;
    for (const reply of replies) reply();
    await expect(remote.locator("body")).toHaveAttribute("data-wheel", "1920");
    expect(wheels.reduce((total, delta) => total + delta, 0)).toBe(1920);
    await page.keyboard.type("after pressure");
    await expect(remote.locator("#plain")).toHaveValue("after pressure");
    await expect(view.getByRole("alert")).toHaveCount(0);
  } finally {
    await backend.close();
  }
});

test("painted pointer geometry follows a viewport resize and page-scale change", async ({
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
    await page.keyboard.insertText("before");
    await expect(remote.locator("#plain")).toHaveValue("before");
    const cdp = await backend.context.newCDPSession(remote);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 900,
      height: 680,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.25 });
    await remote.evaluate(() => {
      document.documentElement.style.background = "rgb(24,80,224)";
    });
    await expect
      .poll(() =>
        view.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
          const value = canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data;
          return Math.max(
            Math.abs(value[0]! - 24),
            Math.abs(value[1]! - 80),
            Math.abs(value[2]! - 224),
          );
        }),
      )
      .toBeLessThanOrEqual(4);
    await clickRemote(page, view, remote, "#plain");
    await page.keyboard.press("End");
    await page.keyboard.insertText(" after");
    await expect(remote.locator("#plain")).toHaveValue("before after");
    await cdp.detach();
  } finally {
    await backend.close();
  }
});

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
    await expect(a.getByRole("tab", { selected: true })).toBeFocused();
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

test("same-tab search navigation and reload retain keyboard focus without another click", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const view = await host(page, backend, windowId);
    const proxy = view.getByRole("textbox", { name: "Remote browser input" });
    const destination = server.origin + "/fixture/editor?search";
    await remote.evaluate((url) => {
      document
        .querySelector("form")!
        .addEventListener("submit", () => location.assign(url), { once: true });
    }, destination);
    await clickRemote(page, view, remote, "#plain");
    await page.keyboard.type("search");
    await page.keyboard.press("Enter");
    await remote.waitForURL(destination);
    await expect(
      view.getByRole("textbox", { name: "Remote page address" }),
    ).toHaveValue(destination);
    await expect(proxy).toBeFocused();
    await expect(view.getByRole("tabpanel")).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Tab");
    await expect(remote.locator("#plain")).toBeFocused();
    await page.keyboard.insertText("after search");
    await expect(remote.locator("#plain")).toHaveValue("after search");

    await remote.reload();
    await expect(proxy).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(remote.locator("#plain")).toBeFocused();
    await page.keyboard.insertText("after reload");
    await expect(remote.locator("#plain")).toHaveValue("after reload");

    const local = page.getByRole("textbox", {
      name: "Host input",
      exact: true,
    });
    await local.fill("local");
    await remote.reload();
    await expect(local).toBeFocused();
    await page.keyboard.type(" only");
    await expect(local).toHaveValue("local only");
    await expect(remote.locator("#plain")).toHaveValue("");
  } finally {
    await backend.close();
  }
});

test("inactive input leaves local Tab navigation usable and resumes remote typing", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const view = await host(page, backend, windowId);
    const proxy = view.getByRole("textbox", { name: "Remote browser input" });
    const original = await proxy.elementHandle();
    await clickRemote(page, view, remote, "#plain");
    await page.keyboard.insertText("before pause");
    await expect(remote.locator("#plain")).toHaveValue("before pause");
    const settings = {
      cdpUrl: backend.endpoint,
      windowA: windowId,
      interactive: true,
      second: false,
    };
    await page.evaluate(
      async (value) => window.configureViewers!({ ...value, paused: true }),
      settings,
    );
    await expect(view).toHaveAttribute("data-status", "paused");
    const after = page.getByRole("textbox", { name: "After viewers" });
    await view.getByRole("textbox", { name: "Remote page address" }).focus();
    await page.keyboard.press("Tab");
    await expect(
      view.getByRole("button", { name: "Browser menu" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(after).toBeFocused();
    await after.fill("local while paused");
    await expect(remote.locator("#plain")).toHaveValue("before pause");

    await page.evaluate(
      async (value) => window.configureViewers!({ ...value, paused: false }),
      settings,
    );
    await expect(view).toHaveAttribute("data-status", "streaming");
    expect(
      await original?.evaluate(
        (element) =>
          element === document.querySelector("#viewer-a .cdpv-input-proxy"),
      ),
    ).toBe(true);
    await clickRemote(page, view, remote, "#plain");
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("resumed");
    await expect(remote.locator("#plain")).toHaveValue("resumed");

    await page.evaluate(async () =>
      window.configureViewers!({
        cdpUrl: "invalid",
        interactive: true,
        second: false,
      }),
    );
    await expect(view).toHaveAttribute("data-status", "error");
    await view.getByRole("textbox", { name: "Remote page address" }).focus();
    await page.keyboard.press("Tab");
    await expect(
      view.getByRole("button", { name: "Browser menu" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      view.getByRole("button", { name: "Reconnect viewer" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(after).toBeFocused();
    await after.fill("local after error");
    await expect(remote.locator("#plain")).toHaveValue("resumed");
    expect(remote.isClosed()).toBe(false);
    await original?.dispose();
  } finally {
    await backend.close();
  }
});

for (const scoped of [false, true]) {
  test(`native text proceeds while optional caret metadata is held (${scoped ? "window scoped" : "unscoped"})`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    let releaseMetadata: (() => void) | undefined;
    try {
      const { remote, windowId, targetId } = await editor(backend);
      const writes: string[] = [];
      let armed = false;
      let metadataId: number | undefined;
      let metadataHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        metadataHeld = resolve;
      });
      await page.routeWebSocket(backend.endpoint, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as {
            id: number;
            method: string;
            params?: { text?: string };
          };
          if (armed && command.method === "Runtime.evaluate") {
            armed = false;
            metadataId = command.id;
          }
          if (
            command.method === "Input.insertText" &&
            typeof command.params?.text === "string"
          )
            writes.push(command.params.text);
          upstream.send(message);
        });
        upstream.onMessage((message) => {
          const response = JSON.parse(String(message)) as { id?: number };
          if (metadataId !== undefined && response.id === metadataId) {
            releaseMetadata = () => socket.send(message);
            metadataId = undefined;
            metadataHeld();
          } else socket.send(message);
        });
      });
      const view = await host(page, backend, scoped ? windowId : undefined);
      if (!scoped) {
        await view.locator(`[data-target-id="${targetId}"]`).click();
        await expect(view).toHaveAttribute("data-status", "streaming");
      }
      armed = true;
      await clickRemote(page, view, remote, "#plain");
      await held;
      await page.keyboard.insertText("a");
      await page.keyboard.insertText("bc");
      await expect(remote.locator("#plain")).toHaveValue("abc");
      expect(writes.join("")).toBe("abc");
      releaseMetadata!();
      releaseMetadata = undefined;
      await page.keyboard.press("Backspace");
      await page.keyboard.type("Z");
      await expect(remote.locator("#plain")).toHaveValue("abZ");
    } finally {
      releaseMetadata?.();
      await backend.close();
    }
  });
}

test("native keyboard input follows automatic focus handoff and replaced controls", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    await remote.evaluate(() => {
      const first = document.querySelector<HTMLInputElement>("#plain")!;
      const second = document.createElement("input");
      second.id = "next-code";
      first.maxLength = 1;
      first.after(second);
      first.addEventListener("input", () => second.focus());
    });
    const view = await host(page, backend, windowId);
    await clickRemote(page, view, remote, "#plain");
    await page.keyboard.type("12");
    await expect(remote.locator("#plain")).toHaveValue("1");
    await expect(remote.locator("#next-code")).toHaveValue("2");
    await remote.evaluate(() => {
      const control = document.querySelector<HTMLInputElement>("#next-code")!;
      control.value = "";
      control.addEventListener(
        "input",
        () => {
          const replacement = control.cloneNode() as HTMLInputElement;
          replacement.value = control.value;
          control.replaceWith(replacement);
          replacement.focus();
          replacement.setSelectionRange(
            replacement.value.length,
            replacement.value.length,
          );
        },
        { once: true },
      );
    });
    await clickRemote(page, view, remote, "#next-code");
    await page.keyboard.type("ab");
    await expect(remote.locator("#next-code")).toHaveValue("ab");
    await expect(view.getByRole("alert")).toHaveCount(0);
  } finally {
    await backend.close();
  }
});

test("native text commits retain focus handoff while earlier input replies are held", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const releases: (() => void)[] = [];
  let armed = false;
  try {
    const { remote, windowId } = await editor(backend);
    await remote.evaluate(() => {
      const first = document.querySelector<HTMLInputElement>("#plain")!;
      const second = document.createElement("input");
      second.id = "next-code";
      first.maxLength = 1;
      first.after(second);
      first.addEventListener("input", () => second.focus());
    });
    const writes: string[] = [];
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      const inputs = new Set<number>();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as {
          id: number;
          method: string;
          params?: { text?: string };
        };
        if (armed && command.method === "Input.insertText")
          inputs.add(command.id);
        if (command.method === "Input.insertText")
          writes.push(command.params?.text ?? "");
        upstream.send(message);
      });
      upstream.onMessage((message) => {
        const response = JSON.parse(String(message)) as { id?: number };
        const inputReply =
          response.id !== undefined && inputs.delete(response.id);
        if (armed && inputReply) releases.push(() => socket.send(message));
        else socket.send(message);
      });
    });
    const view = await host(page, backend, windowId);
    await clickRemote(page, view, remote, "#plain");
    armed = true;
    await page.keyboard.insertText("1");
    await expect.poll(() => releases.length).toBeGreaterThan(0);
    await page.keyboard.insertText("2");
    await expect(remote.locator("#plain")).toHaveValue("1");
    await expect(remote.locator("#next-code")).toHaveValue("2");
    await expect.poll(() => releases.length).toBe(2);
    expect(writes).toEqual(["1", "2"]);
    armed = false;
    for (const release of releases.splice(0)) release();
  } finally {
    armed = false;
    for (const release of releases) release();
    await backend.close();
  }
});

test("scoped input isolates pending discovery and cancels queued commits after a real move", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  let sibling: Page | undefined;
  const scopeReplies: (() => void)[] = [];
  let holdDiscovery = false;
  let releasePreedit: (() => void) | undefined;
  const commits: string[] = [];
  let cleanupConfirmed = false;
  let detachConfirmed = false;
  const retirementReplies: { method: string; ok: boolean }[] = [];
  try {
    sibling = await page.context().newPage();
    const first = await editor(backend, "?move-a");
    const second = await editor(backend, "?move-b");
    await second.remote.evaluate(() => {
      const marker = document.createElement("div");
      marker.style.cssText =
        "position:fixed;left:0;top:0;width:32px;height:32px;background:blue";
      document.body.append(marker);
      document.querySelector("#plain")!.addEventListener("input", () => {
        marker.style.background = "rgb(24,224,80)";
      });
    });
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      const windows = new Set<number>();
      const cleanup = new Set<number>();
      const detaches = new Set<number>();
      let preeditId: number | undefined;
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as {
          id: number;
          method: string;
          params?: { text?: string; type?: string; code?: string };
        };
        if (holdDiscovery && command.method === "Browser.getWindowForTarget")
          windows.add(command.id);
        if (command.method === "Input.imeSetComposition") {
          if (command.params?.text === "n") preeditId = command.id;
        }
        if (
          command.method === "Input.dispatchKeyEvent" &&
          command.params?.type === "keyUp" &&
          command.params.code === "ShiftLeft"
        )
          cleanup.add(command.id);
        if (command.method === "Target.detachFromTarget")
          detaches.add(command.id);
        if (command.method === "Input.insertText")
          commits.push(command.params?.text ?? "");
        upstream.send(message);
      });
      upstream.onMessage((message) => {
        const response = JSON.parse(String(message)) as {
          id?: number;
          result?: object;
          error?: object;
        };
        if (response.id !== undefined && windows.delete(response.id)) {
          scopeReplies.push(() => socket.send(message));
        } else if (response.id !== undefined && response.id === preeditId) {
          releasePreedit = () => socket.send(message);
        } else {
          if (response.id !== undefined) {
            const ok = !!response.result && !response.error;
            if (cleanup.delete(response.id)) {
              retirementReplies.push({ method: "Input.dispatchKeyEvent", ok });
              cleanupConfirmed = ok;
            }
            if (detaches.delete(response.id)) {
              retirementReplies.push({ method: "Target.detachFromTarget", ok });
              detachConfirmed = ok;
            }
          }
          socket.send(message);
        }
      });
    });
    // Allow initial admission, then hold a real background discovery result.
    const a = await host(page, backend, first.windowId);
    const b = await host(sibling, backend, second.windowId);
    await clickRemote(sibling, b, second.remote, "#plain");
    holdDiscovery = true;
    await expect.poll(() => scopeReplies.length).toBeGreaterThan(0);
    await sibling.keyboard.insertText("sibling");
    await expect(second.remote.locator("#plain")).toHaveValue("sibling");
    await expect
      .poll(() =>
        b.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
          const pixel = canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data;
          return Math.max(
            ...[24, 224, 80].map((value, i) => Math.abs(pixel[i]! - value)),
          );
        }),
      )
      .toBeLessThanOrEqual(4);
    await expect(a).toHaveAttribute("data-status", "streaming");

    await clickRemote(page, a, first.remote, "#plain");
    await page.keyboard.down("Shift");
    const proxy = a.getByRole("textbox", { name: "Remote browser input" });
    await proxy.evaluate((element: HTMLTextAreaElement) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      element.value = "n";
      element.setSelectionRange(1, 1);
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          isComposing: true,
          inputType: "insertCompositionText",
          data: "n",
        }),
      );
    });
    await expect.poll(() => typeof releasePreedit).toBe("function");
    await expect(first.remote.locator("#plain")).toHaveValue("n");
    await proxy.evaluate((element: HTMLTextAreaElement) => {
      element.value = "discarded";
      element.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: "discarded",
        }),
      );
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromComposition",
          data: "discarded",
        }),
      );
    });
    expect(commits).toEqual([]);
    expect(cleanupConfirmed).toBe(false);
    holdDiscovery = false;
    for (const release of scopeReplies.splice(0)) release();
    const worker =
      backend.context.serviceWorkers()[0] ??
      (await backend.context.waitForEvent("serviceworker"));
    await worker.evaluate(
      async ({ fromUrl, toUrl }) => {
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
        const from = all.find((tab) => tab.url === fromUrl)!;
        const to = all.find((tab) => tab.url === toUrl)!;
        await tabs.move(from.id, { windowId: to.windowId, index: -1 });
      },
      { fromUrl: first.remote.url(), toUrl: second.remote.url() },
    );
    await expect(a).toHaveAttribute("data-status", "unavailable");
    releasePreedit!();
    releasePreedit = undefined;
    await expect
      .poll(() => ({ cleanupConfirmed, detachConfirmed, retirementReplies }))
      .toMatchObject({
        cleanupConfirmed: true,
        detachConfirmed: true,
      });
    // Chromium may commit the already accepted preedit while moving its native window.
    expect(["", "n"]).toContain(
      await first.remote.locator("#plain").inputValue(),
    );
    await page.keyboard.up("Shift");
    expect(commits).toEqual([]);
    await expect
      .poll(() =>
        a.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          return pixels.some((value, index) => index % 4 < 3 && value !== 0);
        }),
      )
      .toBe(false);
    await expect(b).toHaveAttribute("data-status", "streaming");
    await b.locator(`[data-target-id="${first.targetId}"]`).click();
    await expect(b).toHaveAttribute("data-status", "streaming");
    await clickRemote(sibling, b, first.remote, "#plain");
    await sibling.keyboard.press("Control+a");
    await sibling.keyboard.insertText("destination");
    await expect(first.remote.locator("#plain")).toHaveValue("destination");
    expect(commits).toEqual([]);
  } finally {
    holdDiscovery = false;
    await info.attach("scope-retirement", {
      body: JSON.stringify({ retirementReplies }),
      contentType: "application/json",
    });
    for (const release of scopeReplies) release();
    releasePreedit?.();
    await sibling?.close();
    await backend.close();
  }
});

for (const crossOrigin of [false, true]) {
  test(`native key and text input reach ${crossOrigin ? "cross-origin OOPIF" : "same-origin iframe"} controls`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    try {
      const { remote, windowId } = await editor(backend);
      const frameUrl = "http://frame.fixture.invalid/fields";
      const html = `<!doctype html><style>
        input, textarea, [contenteditable] {display:block; width:260px; margin:10px; font:20px monospace}
        input {height:30px} textarea {height:50px} [contenteditable] {min-height:40px}
        </style><input aria-label="Frame input"><textarea aria-label="Frame textarea"></textarea>
        <div role="textbox" aria-label="Frame rich editor" contenteditable="true" tabindex="0">Rich</div>`;
      if (crossOrigin)
        await backend.context.route(frameUrl, (route) =>
          route.fulfill({ contentType: "text/html", body: html }),
        );
      await remote.locator("iframe").evaluate(
        (frame: HTMLIFrameElement, settings) => {
          frame.style.cssText =
            "position:absolute;left:40px;top:150px;width:400px;height:300px";
          if (settings.crossOrigin) {
            frame.removeAttribute("srcdoc");
            frame.src = settings.url;
          } else frame.srcdoc = settings.html;
        },
        { crossOrigin, url: frameUrl, html },
      );
      const frame = remote.frameLocator("iframe");
      const field = frame.getByRole("textbox", {
        name: "Frame input",
        exact: true,
      });
      await expect(field).toBeVisible();
      if (crossOrigin)
        await expect
          .poll(async () =>
            (await backend.session.send("Target.getTargets")).targetInfos.some(
              (target) => target.type === "iframe" && target.url === frameUrl,
            ),
          )
          .toBe(true);
      const view = await host(page, backend, windowId);
      const box = await field.boundingBox();
      if (!box) throw new Error("Owned frame input bounds missing.");
      const position = await imagePosition(
        view,
        box.x + 20,
        box.y + 15,
        remote,
      );
      await page.mouse.click(position.x, position.y);
      await expect(field).toBeFocused();
      await page.keyboard.type("ab");
      await page.keyboard.insertText("中🙂");
      await expect(field).toHaveValue("ab中🙂");
      await page.keyboard.press("Tab");
      const multiline = frame.getByRole("textbox", {
        name: "Frame textarea",
        exact: true,
      });
      await expect(multiline).toBeFocused();
      await page.keyboard.type("line");
      await page.keyboard.press("Enter");
      await page.keyboard.type("two");
      await expect(multiline).toHaveValue("line\ntwo");
      await page.keyboard.press("Tab");
      const rich = frame.getByRole("textbox", {
        name: "Frame rich editor",
        exact: true,
      });
      await expect(rich).toBeFocused();
      await page.keyboard.press("Control+a");
      await page.keyboard.insertText("富文本🙂");
      await expect(rich).toHaveText("富文本🙂");
      await expect(view.getByRole("alert")).toHaveCount(0);
    } finally {
      await backend.close();
    }
  });
}

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
    ).toBeFocused();

    await clickRemote(page, a, remote, "#plain");
    // Remote focus is already on this input. Wait for both focus-click releases
    // before starting a held gesture; local focus alone does not acknowledge CDP.
    await expect(remote.locator("body")).toHaveAttribute(
      "data-mouse-releases",
      "2",
    );
    await page.mouse.down();
    await expect(remote.locator("body")).toHaveAttribute(
      "data-mouse-held",
      "true",
    );
    await remote.evaluate(() => history.replaceState(null, "", "#replacement"));
    await expect(remote.locator("body")).toHaveAttribute(
      "data-mouse-releases",
      "3",
    );
    await expect(remote.locator("body")).toHaveAttribute(
      "data-mouse-held",
      "false",
    );
    await page.mouse.up();
    await expect(
      a.getByRole("textbox", { name: "Remote browser input" }),
    ).toBeFocused();
    await page.keyboard.insertText("recovered");
    await expect(remote.locator("#plain")).toHaveValue("recovered");
  } finally {
    await backend.close();
  }
});

test("uncommitted navigation releases held input in the retained document", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const view = await host(page, backend, windowId);
    const observer = await backend.context.newCDPSession(remote);
    await observer.send("Page.enable");
    let starts = 0;
    let commits = 0;
    observer.on("Page.frameStartedNavigating", () => starts++);
    observer.on("Page.frameNavigated", () => commits++);
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
    await clickRemote(page, view, remote, "#plain");
    await page.keyboard.down("Shift");
    await expect(remote.locator("body")).toHaveAttribute(
      "data-key-held",
      "true",
    );
    await expect(remote.locator("body")).toHaveAttribute(
      "data-mouse-releases",
      "1",
    );
    await page.mouse.down();
    await expect(remote.locator("body")).toHaveAttribute(
      "data-mouse-held",
      "true",
    );
    const noContent = server.origin + "/fixture/no-content";
    const response = remote.waitForResponse(noContent);
    await remote.evaluate((url) => {
      location.href = url;
    }, noContent);
    expect((await response).status()).toBe(204);
    await expect.poll(() => starts).toBe(1);
    // A 204 keeps the current execution context. Read that context directly:
    // locator auto-wait can treat its uncommitted navigation as still pending.
    await expect
      .poll(() =>
        remote.evaluate(() => ({
          held: document.body.dataset.keyHeld,
          releases: document.body.dataset.keyReleases,
          mouseHeld: document.body.dataset.mouseHeld,
          mouseReleases: document.body.dataset.mouseReleases,
        })),
      )
      .toEqual({
        held: "false",
        releases: "1",
        mouseHeld: "false",
        mouseReleases: "2",
      });
    expect(commits).toBe(0);
    expect(remote.url()).toBe(server.origin + "/fixture/editor");
    await page.keyboard.up("Shift");
    await page.mouse.up();
    await expect(
      view.getByRole("textbox", { name: "Remote browser input" }),
    ).toBeFocused();
    await expect
      .poll(() => remote.evaluate(() => document.activeElement?.id))
      .toBe("plain");
    await page.keyboard.insertText("recovered after 204");
    await expect
      .poll(() =>
        remote.evaluate(
          () => document.querySelector<HTMLInputElement>("#plain")?.value,
        ),
      )
      .toBe("recovered after 204");
    await observer.detach();
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
      "find some text",
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
        "Enter a page address",
      );
      expect(remote.url()).toBe(server.origin + "/fixture/editor");
      await expect(remote.locator("#loads")).toHaveText(loadsBefore!);
    }
    const next = server.origin + "/fixture/editor?next#section";
    await address.fill(next.replace("http://", ""));
    expect(remote.url()).toBe(server.origin + "/fixture/editor");
    await address.press("Enter");
    await remote.waitForURL(next);
    await expect(address).toHaveValue(next);
    await expect(
      view.getByRole("button", { name: "Back remote page" }),
    ).toBeEnabled();
    await view.getByRole("button", { name: "Back remote page" }).click();
    await remote.waitForURL(server.origin + "/fixture/editor");
    await expect(
      view.getByRole("button", { name: "Forward remote page" }),
    ).toBeEnabled();
    await view.getByRole("button", { name: "Forward remote page" }).click();
    await remote.waitForURL(next);
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

test("address submission delegates non-HTTP destinations to remote Chromium", async ({
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
    const data =
      "data:text/html," +
      encodeURIComponent(
        "<title>Address fixture</title><p id='result'>Owned destination</p>",
      );
    for (const url of ["about:blank", data]) {
      const previous = remote.url();
      await address.fill(url);
      expect(remote.url()).toBe(previous);
      await address.press("Enter");
      await remote.waitForURL(url);
      // The address model intentionally displays about:blank as an empty bar.
      await expect(address).toHaveValue(url === "about:blank" ? "" : url);
      await expect(view.getByRole("alert")).toHaveCount(0);
    }
    await expect(remote.locator("#result")).toHaveText("Owned destination");
    await address.fill(
      "javascript:document.body.dataset.executions=String(Number(document.body.dataset.executions||0)+1);void 0",
    );
    await address.press("Enter");
    await expect(view.getByRole("alert")).toContainText(
      "The remote page could not be navigated.",
    );
    await expect(remote.locator("body")).toHaveAttribute(
      "data-executions",
      "1",
    );
  } finally {
    await backend.close();
  }
});

test("interaction mode changes discard an unfinished address and resume native input", async ({
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
    const currentUrl = server.origin + "/fixture/editor";
    await address.fill(currentUrl + "?unfinished");
    await expect(address).toBeFocused();
    for (const interactive of [false, true]) {
      await page.evaluate(
        async (settings) => window.configureViewers!(settings),
        {
          cdpUrl: backend.endpoint,
          windowA: windowId,
          second: false,
          interactive,
        },
      );
      await expect(view).toHaveAttribute("data-status", "streaming");
      if (!interactive) await expect(address).toHaveCount(0);
    }
    await expect(address).toHaveValue(currentUrl);
    expect(remote.url()).toBe(currentUrl);
    await clickRemote(page, view, remote, "#plain");
    await page.keyboard.type("after mode change");
    await expect(remote.locator("#plain")).toHaveValue("after mode change");
  } finally {
    await backend.close();
  }
});

test("blur and target replacement discard composition while frame input stays native", async ({
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
    await view.locator(`[data-target-id="${first.targetId}"]`).click();
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
    await view.locator(`[data-target-id="${second.targetId}"]`).click();
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
    await page.keyboard.type("frame input");
    await expect(view.getByRole("alert")).toHaveCount(0);
    await expect(frame).toHaveValue("frame input");
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

test("composition bursts skip obsolete previews after a delayed response", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const previews: string[] = [];
    const commits: string[] = [];
    let heldId: number | undefined;
    let release: (() => void) | undefined;
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as {
          id?: number;
          method?: string;
          params?: { text: string };
        };
        if (command.method === "Input.imeSetComposition") {
          previews.push(command.params!.text);
          if (previews.length === 1) heldId = command.id;
        } else if (command.method === "Input.insertText")
          commits.push(command.params!.text);
        upstream.send(message);
      });
      upstream.onMessage((message) => {
        const response = JSON.parse(String(message)) as { id?: number };
        if (heldId !== undefined && response.id === heldId)
          release = () => socket.send(message);
        else socket.send(message);
      });
    });
    const view = await host(page, backend, windowId);
    await clickRemote(page, view, remote, "#plain");
    const proxy = view.getByRole("textbox", { name: "Remote browser input" });
    await proxy.evaluate((element: HTMLTextAreaElement) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      element.value = "n";
      element.setSelectionRange(1, 1);
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          isComposing: true,
          inputType: "insertCompositionText",
          data: "n",
        }),
      );
    });
    await expect.poll(() => typeof release).toBe("function");
    await expect(remote.locator("#plain")).toHaveValue("n");
    await proxy.evaluate((element: HTMLTextAreaElement) => {
      for (let index = 0; index < 200; index++) {
        const text = `ni${index}`;
        element.dispatchEvent(
          new CompositionEvent("compositionupdate", {
            bubbles: true,
            data: text,
          }),
        );
        element.value = text;
        element.setSelectionRange(text.length, text.length);
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            isComposing: true,
            inputType: "insertCompositionText",
            data: text,
          }),
        );
      }
      element.value = "你";
      element.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "你" }),
      );
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromComposition",
          data: "你",
        }),
      );
    });
    expect(previews).toEqual(["n"]);
    expect(commits).toEqual([]);
    release!();
    await expect(remote.locator("#plain")).toHaveValue("你");
    expect(previews).toEqual(["n"]);
    expect(commits).toEqual(["你"]);
  } finally {
    await backend.close();
  }
});

for (const [kind, selector] of [
  ["input", "#plain"],
  ["textarea", "#multiline"],
  ["contenteditable", "#rich"],
] as const) {
  test(`shows preedit and replacing commits in ${kind}`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    try {
      const { remote, windowId } = await editor(backend);
      const view = await host(page, backend, windowId);
      const field = remote.locator(selector);
      await field.fill("saved OLD suffix");
      await clickRemote(page, view, remote, selector);
      await field.evaluate((element) => {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        )
          element.setSelectionRange(6, 9);
        else {
          const range = document.createRange();
          const text = document
            .createTreeWalker(element, NodeFilter.SHOW_TEXT)
            .nextNode()!;
          range.setStart(text, 6);
          range.setEnd(text, 9);
          document.getSelection()!.removeAllRanges();
          document.getSelection()!.addRange(range);
        }
      });
      const value = () =>
        field.evaluate((element) =>
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
            ? element.value
            : element.textContent,
        );
      const proxy = view.getByRole("textbox", { name: "Remote browser input" });
      const start = () =>
        proxy.evaluate((element) => {
          element.dispatchEvent(
            new CompositionEvent("compositionstart", { bubbles: true }),
          );
        });
      const update = (text: string) =>
        proxy.evaluate((element: HTMLTextAreaElement, text) => {
          element.dispatchEvent(
            new CompositionEvent("compositionupdate", {
              bubbles: true,
              data: text,
            }),
          );
          element.value = text;
          element.setSelectionRange(text.length, text.length);
          element.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              isComposing: true,
              inputType: "insertCompositionText",
              data: text,
            }),
          );
        }, text);
      const end = (text: string) =>
        proxy.evaluate((element: HTMLTextAreaElement, text) => {
          element.value = text;
          element.dispatchEvent(
            new KeyboardEvent("keydown", {
              bubbles: true,
              key: "Enter",
              code: "Enter",
              keyCode: 229,
              isComposing: true,
            }),
          );
          element.dispatchEvent(
            new CompositionEvent("compositionend", {
              bubbles: true,
              data: text,
            }),
          );
          element.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertFromComposition",
              data: text,
            }),
          );
        }, text);
      await start();
      await update("n");
      await expect.poll(value).toBe("saved n suffix");
      await update("nihao");
      await expect.poll(value).toBe("saved nihao suffix");
      await proxy.evaluate((element: HTMLTextAreaElement) => {
        element.setSelectionRange(1, 3);
        element.dispatchEvent(new Event("select", { bubbles: true }));
      });
      await expect
        .poll(() =>
          field.evaluate((element) =>
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement
              ? element.value.slice(
                  element.selectionStart ?? 0,
                  element.selectionEnd ?? 0,
                )
              : document.getSelection()?.toString(),
          ),
        )
        .toBe("ih");
      await end("你好");
      await expect.poll(value).toBe("saved 你好 suffix");
      await expect(remote.locator("#submits")).toHaveText("0");
      await start();
      await update("zhong");
      await expect.poll(value).toBe("saved 你好zhong suffix");
      await end("");
      await expect.poll(value).toBe("saved 你好 suffix");
      await start();
      await update("discard");
      await expect.poll(value).toBe("saved 你好discard suffix");
      await page.getByLabel("Host input", { exact: true }).fill("local only");
      await expect.poll(value).toBe("saved 你好 suffix");
      await end("must not arrive");
      await expect.poll(value).toBe("saved 你好 suffix");
      await expect(page.getByLabel("Host input", { exact: true })).toHaveValue(
        "local only",
      );
    } finally {
      await backend.close();
    }
  });
}

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
