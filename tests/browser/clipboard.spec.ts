import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { prepareConsumer } from "../../scripts/consumer.mjs";
import { launchBackend, serveConsumer } from "./backend";
import type {} from "../consumer/api";

// Clipboard activation must be tested in full Chromium, not headless shell.
test.use({ channel: "chromium" });
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

async function editor(backend: Awaited<ReturnType<typeof launchBackend>>) {
  const created = backend.context.waitForEvent("page");
  const target = await backend.session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    { targetId: target.targetId },
  );
  const remote = await created;
  await remote.goto(server.origin + "/fixture/editor");
  await expect(remote.locator("#plain")).toBeVisible();
  return { remote, windowId };
}

async function host(
  page: Page,
  endpoint: string,
  windowA: number,
  windowB?: number,
  origin = server.origin,
) {
  // Observe settlement of the real browser API; no permission grants, mocks,
  // substituted results or clipboard contents are used by this instrumentation.
  await page.addInitScript(() => {
    const write = Clipboard.prototype.write.bind(navigator.clipboard);
    Clipboard.prototype.write = function (items) {
      const result = write(items);
      result.then(
        () => {
          document.body.dataset.clipboardSettled = String(
            Number(document.body.dataset.clipboardSettled ?? "0") + 1,
          );
        },
        () => {
          document.body.dataset.clipboardSettled = String(
            Number(document.body.dataset.clipboardSettled ?? "0") + 1,
          );
        },
      );
      return result;
    };
  });
  await page.goto(origin);
  await page.waitForFunction(
    () => typeof window.configureViewers === "function",
  );
  await page.evaluate(async (settings) => window.configureViewers!(settings), {
    cdpUrl: endpoint,
    interactive: true,
    windowA,
    ...(windowB === undefined ? { second: false } : { windowB }),
  });
  await page.evaluate(() => {
    const field = document.createElement("textarea");
    field.id = "clipboard-fixture";
    field.setAttribute("aria-label", "Owned local clipboard field");
    document.body.append(field);
  });
  const view = page.locator("#viewer-a .cdpv-root");
  await expect(view).toHaveAttribute("data-status", "streaming");
  await page.bringToFront();
  return view;
}

async function seed(page: Page, text: string) {
  const field = page.locator("#clipboard-fixture");
  await field.fill(text);
  await field.press("ControlOrMeta+a");
  await field.press("ControlOrMeta+c");
}
async function localText(page: Page) {
  const field = page.locator("#clipboard-fixture");
  await field.fill("");
  await field.press("ControlOrMeta+v");
  return field.inputValue();
}
async function copy(page: Page, view: Locator) {
  const before = await page
    .locator("body")
    .getAttribute("data-clipboard-settled");
  const proxy = view.getByRole("textbox", { name: "Remote browser input" });
  await proxy.focus();
  await proxy.press("ControlOrMeta+c");
  await expect(page.locator("body")).toHaveAttribute(
    "data-clipboard-settled",
    String(Number(before ?? "0") + 1),
  );
}

function gateSelection(page: Page, endpoint: string) {
  const gate = {
    release: null as (() => void) | null,
    releases: 0,
  };
  const ready = page.routeWebSocket(endpoint, (socket) => {
    const upstream = socket.connectToServer();
    let heldId: number | undefined;
    let armed = true;
    let frozen = false;
    const delayed: (string | Buffer)[] = [];
    socket.onMessage((message) => {
      const command = JSON.parse(String(message)) as {
        id?: number;
        method?: string;
        params?: { expression?: string };
      };
      if (command.method === "Runtime.releaseObject") gate.releases++;
      if (
        armed &&
        command.method === "Runtime.evaluate" &&
        command.params?.expression?.startsWith("/* cdp-viewer selection */")
      ) {
        heldId = command.id;
        armed = false;
      }
      upstream.send(message);
    });
    upstream.onMessage((message) => {
      const response = JSON.parse(String(message)) as { id?: number };
      if (frozen) delayed.push(message);
      else if (heldId !== undefined && response.id === heldId) {
        frozen = true;
        delayed.push(message);
        gate.release = () => {
          heldId = undefined;
          frozen = false;
          for (const item of delayed.splice(0)) socket.send(item);
        };
      } else socket.send(message);
    });
  });
  return { gate, ready };
}

test("pastes multiline Unicode once without Enter submission or host interception", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const commands: string[] = [];
    await page.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as { method?: string };
        if (command.method === "Input.insertText")
          commands.push(command.method);
        upstream.send(message);
      });
    });
    const view = await host(page, backend.endpoint, windowId);
    const text = "你好🙂\nsecond line";
    await seed(page, text);
    for (const selector of ["#plain", "#multiline", "#rich"]) {
      await remote.locator(selector).focus();
      await view.getByRole("textbox", { name: "Remote browser input" }).focus();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("ControlOrMeta+v");
      if (selector === "#rich")
        await expect(remote.locator(selector)).toHaveText(text, {
          useInnerText: true,
        });
      else
        await expect(remote.locator(selector)).toHaveValue(
          selector === "#plain" ? text.replaceAll("\n", " ") : text,
        );
    }
    expect(commands).toHaveLength(3);
    await expect(remote.locator("#submits")).toHaveText("0");
    expect(await localText(page)).toBe(text);
    expect(commands).toHaveLength(3);
  } finally {
    await backend.close();
  }
});

test("copies native, readonly, DOM, open-shadow and same-origin frame selections", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const view = await host(page, backend.endpoint, windowId);
    await seed(page, "owned previous clipboard");
    for (const kind of [
      "input",
      "readonly",
      "textarea",
      "dom",
      "page",
      "shadow",
      "frame",
    ] as const) {
      const expected = "selected " + kind + " 中文🙂";
      await remote.evaluate(
        ({ kind, expected }) => {
          let element: HTMLInputElement | HTMLTextAreaElement | null = null;
          if (kind === "shadow")
            element = document
              .querySelector("#shadow")!
              .shadowRoot!.querySelector("input");
          else if (kind === "frame")
            element = document
              .querySelector("iframe")!
              .contentDocument!.querySelector("input");
          else if (kind !== "dom" && kind !== "page")
            element = document.querySelector(
              kind === "textarea" ? "#multiline" : "#plain",
            );
          if (element) {
            element.readOnly = kind === "readonly";
            element.value = expected;
            element.focus();
            element.select();
          } else {
            const rich = document.querySelector<HTMLElement>("#rich")!;
            rich.contentEditable = String(kind === "dom");
            rich.textContent = expected;
            if (kind === "dom") rich.focus();
            else (document.activeElement as HTMLElement).blur();
            const range = document.createRange();
            range.selectNodeContents(rich);
            const selection = getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
          }
        },
        { kind, expected },
      );
      await copy(page, view);
      expect(await localText(page)).toBe(expected);
    }
  } finally {
    await backend.close();
  }
});

test("keeps a gesture-time write alive after activation expires during a remote read", async ({
  page,
}, info) => {
  // routeWebSocket delivers messages through Playwright evaluations with
  // userGesture:true. Gate real native-socket responses in the page instead,
  // then release them through CDP with userGesture:false. No clipboard mock.
  await page.addInitScript(() => {
    const NativeSocket = WebSocket;
    const gate = { held: false, release: () => {} };
    Object.assign(window, { clipboardGate: gate });
    window.WebSocket = class extends NativeSocket {
      private heldId: number | null = null;
      private frozen = false;
      private readonly delayed: string[] = [];
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event: MessageEvent<string>) => {
          const response = JSON.parse(event.data) as { id?: number };
          if (this.frozen || response.id === this.heldId) {
            event.stopImmediatePropagation();
            this.frozen = true;
            this.delayed.push(event.data);
            gate.held = true;
            gate.release = () => {
              this.heldId = null;
              this.frozen = false;
              for (const data of this.delayed.splice(0))
                this.dispatchEvent(new MessageEvent("message", { data }));
            };
          }
        });
      }
      override send(data: Parameters<WebSocket["send"]>[0]): void {
        if (typeof data === "string") {
          const command = JSON.parse(data) as {
            id: number;
            method: string;
            params?: { expression?: string };
          };
          if (
            command.method === "Runtime.evaluate" &&
            command.params?.expression?.startsWith("/* cdp-viewer selection */")
          )
            this.heldId = command.id;
        }
        super.send(data);
      }
    };
  });
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const view = await host(page, backend.endpoint, windowId);
    await seed(page, "previous");
    await remote.locator("#plain").fill("delayed owned selection");
    await remote.locator("#plain").selectText();
    await view.getByRole("textbox", { name: "Remote browser input" }).focus();
    await page.keyboard.press("ControlOrMeta+c");
    const cdp = await page.context().newCDPSession(page);
    await expect
      .poll(
        async () =>
          (
            await cdp.send("Runtime.evaluate", {
              expression: "window.clipboardGate.held",
              returnByValue: true,
              userGesture: false,
            })
          ).result.value,
      )
      .toBe(true);
    const expired = await cdp.send("Runtime.evaluate", {
      // Observe the actual activation state inside one non-gesture evaluation.
      expression: `new Promise(resolve => {
        const start = performance.now();
        const timer = setInterval(() => {
          if (!navigator.userActivation.isActive) { clearInterval(timer); resolve(true); }
          else if (performance.now() - start > 8000) { clearInterval(timer); resolve(false); }
        }, 25);
      })`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    });
    expect(expired.result.value).toBe(true);
    await cdp.send("Runtime.evaluate", {
      expression: "window.clipboardGate.release()",
      userGesture: false,
    });
    const completed = await cdp.send("Runtime.evaluate", {
      expression: `new Promise(resolve => {
        const start = performance.now();
        const timer = setInterval(() => {
          if (document.body.dataset.clipboardSettled === '1') {
            clearInterval(timer); resolve(!navigator.userActivation.isActive);
          } else if (performance.now() - start > 5000) { clearInterval(timer); resolve(false); }
        }, 25);
      })`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    });
    expect(completed.result.value).toBe(true);
    expect(await localText(page)).toBe("delayed owned selection");
    await cdp.detach();
  } finally {
    await backend.close();
  }
});

test("preserves prior clipboard on empty/protected/unsupported-frame copy", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const view = await host(page, backend.endpoint, windowId);
    await seed(page, "owned retained clipboard");
    await remote.locator("#plain").focus();
    await copy(page, view);
    await expect(
      view.getByRole("region", { name: "Clipboard recovery" }),
    ).toHaveCount(0);
    expect(await localText(page)).toBe("owned retained clipboard");
    await remote.locator("#plain").evaluate((field: HTMLInputElement) => {
      field.type = "password";
      field.value = "protected owned fixture";
      field.focus();
      field.select();
    });
    await copy(page, view);
    await expect(
      view.getByRole("region", { name: "Clipboard recovery" }),
    ).toBeVisible();
    await expect(
      view.getByRole("textbox", { name: "Text to copy" }),
    ).toHaveCount(0);
    expect(await localText(page)).toBe("owned retained clipboard");
    await remote.locator("iframe").evaluate(
      (frame: HTMLIFrameElement, url) => {
        frame.removeAttribute("srcdoc");
        frame.src = url;
      },
      server.origin.replace("127.0.0.1", "localhost") + "/fixture/editor",
    );
    await remote.frameLocator("iframe").locator("#plain").waitFor();
    await remote.locator("#rich").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await remote.frameLocator("iframe").locator("#plain").focus();
    await copy(page, view);
    await expect(
      view.getByRole("textbox", { name: "Text to copy" }),
    ).toHaveCount(0);
    expect(await localText(page)).toBe("owned retained clipboard");
    await remote.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = '<input value="owned opaque selection">';
      document.body.append(host);
      const field = root.querySelector("input")!;
      field.focus();
      field.select();
    });
    await copy(page, view);
    await expect(
      view.getByRole("textbox", { name: "Text to copy" }),
    ).toHaveCount(0);
    expect(await localText(page)).toBe("owned retained clipboard");
  } finally {
    await backend.close();
  }
});

test("provides native local-copy recovery under real clipboard-write policy denial", async ({
  page,
}, info) => {
  const denied = await serveConsumer(consumer.dist, "/", {
    "Permissions-Policy": "clipboard-write=()",
  });
  const backend = await launchBackend(
    info.outputPath("backend"),
    denied.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const view = await host(
      page,
      backend.endpoint,
      windowId,
      undefined,
      denied.origin,
    );
    await seed(page, "previous");
    await remote.locator("#plain").fill("owned recovery text");
    await remote.locator("#plain").selectText();
    await copy(page, view);
    const recovery = view.getByRole("textbox", { name: "Text to copy" });
    await expect(recovery).toHaveValue("owned recovery text");
    await recovery.focus();
    await page.keyboard.press("ControlOrMeta+c");
    expect(await localText(page)).toBe("owned recovery text");
    // A fresh-click retry may fail under policy; the native fallback stays usable.
    await view.getByRole("button", { name: "Copy text", exact: true }).click();
    await expect(recovery).toHaveValue("owned recovery text");
    await view.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(recovery).toHaveCount(0);
    await remote.locator("#plain").focus();
    await view.getByRole("textbox", { name: "Remote browser input" }).focus();
    await page.keyboard.insertText("still works");
    await expect(remote.locator("#plain")).toHaveValue("still works");
  } finally {
    await backend.close();
    await denied.close();
  }
});

test("cancels a late copy on viewer focus loss and releases its original snapshot", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const first = await editor(backend);
    const second = await editor(backend);
    const { gate, ready } = gateSelection(page, backend.endpoint);
    await ready;
    const view = await host(
      page,
      backend.endpoint,
      first.windowId,
      second.windowId,
    );
    await seed(page, "owned clipboard stays");
    await first.remote.locator("#plain").fill("old selected text");
    await first.remote.locator("#plain").selectText();
    await view.getByRole("textbox", { name: "Remote browser input" }).focus();
    await page.keyboard.press("ControlOrMeta+c");
    await expect.poll(() => typeof gate.release).toBe("function");
    const sibling = page.locator("#viewer-b .cdpv-root");
    await expect(sibling).toHaveAttribute("data-status", "streaming");
    await second.remote.locator("#plain").focus();
    await sibling
      .getByRole("textbox", { name: "Remote browser input" })
      .focus();
    gate.release!();
    await expect.poll(() => gate.releases).toBeGreaterThan(0);
    await expect(page.locator("body")).toHaveAttribute(
      "data-clipboard-settled",
      "1",
    );
    expect(await localText(page)).toBe("owned clipboard stays");
    await expect(
      page.getByRole("textbox", { name: "Text to copy" }),
    ).toHaveCount(0);
  } finally {
    await backend.close();
  }
});

for (const change of [
  "remote focus",
  "child document",
  "protected input",
] as const) {
  test(`rejects a captured selection after ${change} changes`, async ({
    page,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    try {
      const { remote, windowId } = await editor(backend);
      const { gate, ready } = gateSelection(page, backend.endpoint);
      await ready;
      const view = await host(page, backend.endpoint, windowId);
      await seed(page, "owned unchanged clipboard");
      const source =
        change === "child document"
          ? remote.frameLocator("iframe").locator("input")
          : remote.locator("#plain");
      await source.fill("old captured selection");
      await source.selectText();
      await view.getByRole("textbox", { name: "Remote browser input" }).focus();
      await page.keyboard.press("ControlOrMeta+c");
      await expect.poll(() => typeof gate.release).toBe("function");
      if (change === "remote focus") await remote.locator("#multiline").focus();
      else if (change === "protected input")
        await remote.locator("#plain").evaluate((field: HTMLInputElement) => {
          field.type = "password";
        });
      else {
        await remote.locator("iframe").evaluate((frame: HTMLIFrameElement) => {
          frame.srcdoc = '<input value="replacement owned document">';
        });
        await expect(
          remote.frameLocator("iframe").locator("input"),
        ).toHaveValue("replacement owned document");
      }
      gate.release!();
      await expect(page.locator("body")).toHaveAttribute(
        "data-clipboard-settled",
        "1",
      );
      await expect.poll(() => gate.releases).toBeGreaterThan(0);
      expect(await localText(page)).toBe("owned unchanged clipboard");
      await expect(
        view.getByRole("textbox", { name: "Text to copy" }),
      ).toHaveCount(0);
    } finally {
      await backend.close();
    }
  });
}

test("bounds paste and refuses unresolved synthetic composition without duplicate commits", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const view = await host(page, backend.endpoint, windowId);
    const proxy = view.getByRole("textbox", { name: "Remote browser input" });
    await seed(page, "x".repeat(64 * 1024 + 1));
    await remote.locator("#plain").focus();
    await proxy.focus();
    await page.keyboard.press("ControlOrMeta+v");
    await expect(view.getByRole("alert")).toContainText(
      "exceeds the supported size",
    );
    await expect(remote.locator("#plain")).toHaveValue("");
    await seed(page, "owned paste");
    await proxy.focus();
    await proxy.dispatchEvent("compositionstart", { data: "" });
    await page.keyboard.press("ControlOrMeta+v");
    await expect(view.getByRole("alert").last()).toContainText(
      "Finish composing text before pasting",
    );
    await expect(remote.locator("#plain")).toHaveValue("");
    await proxy.dispatchEvent("compositionend", { data: "" });
    await page.keyboard.press("ControlOrMeta+v");
    await expect(remote.locator("#plain")).toHaveValue("owned paste");
  } finally {
    await backend.close();
  }
});

test("a newer copy supersedes a delayed copy and writes only the latest selection", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const { remote, windowId } = await editor(backend);
    const { gate, ready } = gateSelection(page, backend.endpoint);
    await ready;
    const view = await host(page, backend.endpoint, windowId);
    await seed(page, "owned baseline");
    await remote.locator("#plain").fill("obsolete owned selection");
    await remote.locator("#plain").selectText();
    await view.getByRole("textbox", { name: "Remote browser input" }).focus();
    await page.keyboard.press("ControlOrMeta+c");
    await expect.poll(() => typeof gate.release).toBe("function");
    await remote.locator("#plain").fill("latest owned selection");
    await remote.locator("#plain").selectText();
    await page.keyboard.press("ControlOrMeta+c");
    gate.release!();
    await expect(page.locator("body")).toHaveAttribute(
      "data-clipboard-settled",
      "2",
    );
    expect(await localText(page)).toBe("latest owned selection");
    await expect(
      view.getByRole("textbox", { name: "Text to copy" }),
    ).toHaveCount(0);
  } finally {
    await backend.close();
  }
});
