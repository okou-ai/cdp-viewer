import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { launchBackend, serveConsumer } from "../browser/backend";
import { ProbeHost } from "./probe-host";
import { compositionMessageLimit } from "./native-actions";
import {
  createNativeFixture,
  position,
  painted,
  drained,
  composing,
  committed,
  resumed,
  observeClipboard,
  seedClipboard,
  localClipboard,
  copySelection,
} from "./native-fixture";
import type { Viewer } from "./native-fixture";
import type {} from "./native-client";
import type {} from "../consumer/api";

test.use({ channel: "chromium" });
let fixture: Awaited<ReturnType<typeof createNativeFixture>>;
let consumer: Awaited<ReturnType<typeof createNativeFixture>>["consumer"];
let server: Awaited<ReturnType<typeof createNativeFixture>>["server"];
let viewer: Awaited<ReturnType<typeof createNativeFixture>>["viewer"];
test.beforeAll(async () => {
  fixture = await createNativeFixture();
  ({ consumer, server, viewer } = fixture);
});
test.afterAll(async () => {
  await fixture?.close();
});

test("actual NativeInput orders click/type, Tab and drag while an independent window survives retirement", async ({
  browser,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const host = new ProbeHost(backend.endpoint);
  const viewers: Viewer[] = [];
  try {
    const a = await viewer(browser, backend, host, true);
    viewers.push(a);
    const b = await viewer(browser, backend, host, true);
    viewers.push(b);
    const identity = await a.page
      .getByRole("textbox", { name: "Native executor input" })
      .elementHandle();
    const at = await position(a, "#plain");
    await a.page.mouse.click(at.x, at.y);
    await a.page.keyboard.type("first");
    await expect(a.remote.locator("#plain")).toHaveValue("first");
    await a.page.keyboard.press("Tab");
    await a.page.keyboard.type("next");
    await expect(a.remote.locator("#multiline")).toHaveValue("next");
    expect(
      await identity!.evaluate(
        (input) =>
          input ===
          document.querySelector('[aria-label="Native executor input"]'),
      ),
    ).toBe(true);
    await drained(a);
    const guard = a.probe!.holdNext("Browser.getWindowForTarget");
    await a.page.keyboard.press("ArrowLeft");
    await guard.held;
    const independent = await position(b, "#plain");
    await b.page.mouse.click(independent.x, independent.y);
    await b.page.keyboard.type("guard");
    await expect(b.remote.locator("#plain")).toHaveValue("guard");
    await painted(b, true);
    guard.release();
    await drained(a);
    await drained(b);
    await b.remote.evaluate(() => {
      document.querySelector<HTMLInputElement>("#plain")!.value = "";
      document.querySelector<HTMLElement>("#native-marker")!.style.background =
        "rgb(232,32,48)";
    });
    await painted(b, false);
    const held = a.probe!.holdNext("Input.dispatchKeyEvent");
    await a.page.keyboard.down("Shift");
    await held.held;
    const bp = await position(b, "#plain");
    await b.page.mouse.click(bp.x, bp.y);
    await b.page.keyboard.type("sibling");
    await expect(b.remote.locator("#plain")).toHaveValue("sibling");
    await painted(b, true);
    await b.page.keyboard.down("Shift");
    await drained(b);
    const retiring = host.retire(a.probe!, "paused");
    await expect(
      host.admit({
        targetId: a.targetId,
        windowId: a.windowId,
        mode: "native",
        reply: () => {},
      }),
    ).rejects.toThrow("unsettled owner");
    held.release();
    expect(await retiring).toBe(true);
    const events = await b.remote.evaluate(
      () =>
        (window as unknown as { nativeObserved: { events: string[] } })
          .nativeObserved.events,
    );
    expect(events.filter((v) => v === "keyup:Shift")).toEqual([]);
    expect(a.remote.isClosed()).toBe(false);
    await b.page.keyboard.up("Shift");
    const drag = await position(b, "#plain", 0.05);
    const end = await position(b, "#plain", 0.25);
    await b.page.mouse.move(drag.x, drag.y);
    await b.page.mouse.down();
    await b.page.mouse.move(end.x, end.y, { steps: 4 });
    await b.page.mouse.up();
    await drained(b);
    await expect
      .poll(() =>
        b.remote
          .locator("#plain")
          .evaluate(
            (input: HTMLInputElement) =>
              input.selectionEnd! - input.selectionStart!,
          ),
      )
      .toBeGreaterThan(0);
    const observed = await b.remote.evaluate(
      () =>
        (window as unknown as { nativeObserved: { events: string[] } })
          .nativeObserved.events,
    );
    expect(
      observed.filter((v) => v === "mousedown").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      observed.filter((v) => v === "mouseup").length,
    ).toBeGreaterThanOrEqual(2);
    expect(observed).toContain("mousemove");
  } finally {
    host.close();
    try {
      for (const value of viewers) await value.close();
    } finally {
      await backend.close();
    }
  }
});

test("composition mode commits once and resumes after blur on the same native proxy", async ({
  browser,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const host = new ProbeHost(backend.endpoint);
  let a: Viewer | undefined;
  try {
    a = await viewer(browser, backend, host, true, 0, { composition: true });
    const proxy = a.page.getByRole("textbox", {
      name: "Native executor input",
    });
    const identity = await proxy.elementHandle();
    const at = await position(a, "#plain");
    await a.page.mouse.click(at.x, at.y);
    await composing(a, "ni");
    await expect(a.remote.locator("#plain")).toHaveValue("ni");
    await committed(a, "你");
    await expect(a.remote.locator("#plain")).toHaveValue("你");
    await painted(a, true);
    await drained(a);
    const old = a.probe!.ownership;
    const acknowledgement = a.holdMessage("reply", "ack");
    const blur = a.holdMessage("intent", "blur");
    await composing(a, "hao");
    await expect(a.remote.locator("#plain")).toHaveValue("你hao");
    await acknowledgement.held;
    await proxy.evaluate((element: HTMLTextAreaElement) => element.blur());
    await blur.held;
    acknowledgement.release();
    await expect
      .poll(() =>
        a!.page.evaluate(() => window.nativeExperiment.stats.discardedReplies),
      )
      .toBe(1);
    expect(
      await a.page.evaluate(() => window.nativeExperiment.stats.revoked),
    ).toBe(false);
    blur.release();
    await resumed(a);
    await expect(a.remote.locator("#plain")).toHaveValue("你");
    expect(a.probe!.ownership.generation).not.toBe(old.generation);
    expect(a.probe!.ownership.focus).toBeGreaterThan(old.focus);
    expect(a.probe!.ownership.document).toBe(old.document);
    expect(
      await identity!.evaluate(
        (element) =>
          element ===
          document.querySelector('[aria-label="Native executor input"]'),
      ),
    ).toBe(true);
    await a.remote.evaluate(() => {
      document.querySelector<HTMLInputElement>("#plain")!.value = "";
    });
    await a.page.mouse.click(at.x, at.y);
    await a.page.keyboard.type("resumed");
    await expect(a.remote.locator("#plain")).toHaveValue("resumed");
    await drained(a);
    expect(
      await a.page.evaluate(() => window.nativeExperiment.stats.unsupported),
    ).toBe(false);
  } finally {
    try {
      await a?.close();
    } finally {
      host.close();
      await backend.close();
    }
  }
});

test("composition mode drops old trailing events after a real document replacement", async ({
  browser,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const host = new ProbeHost(backend.endpoint);
  let a: Viewer | undefined;
  try {
    a = await viewer(browser, backend, host, true, 0, { composition: true });
    const at = await position(a, "#plain");
    await a.page.mouse.click(at.x, at.y);
    await drained(a);
    const old = a.probe!.ownership;
    const held = a.probe!.holdNext("Input.imeSetComposition");
    await composing(a, "old");
    await held.held;
    await expect(a.remote.locator("#plain")).toHaveValue("old");
    await a.remote.goto(server.origin + "/fixture/editor?replacement");
    await expect(a.remote.locator("#plain")).toHaveValue("");
    await committed(a, "late-before-ready");
    const beforeRelease = a.probe!.trace.length;
    held.release();
    await resumed(a);
    expect(a.probe!.ownership.document).toBeGreaterThan(old.document);
    expect(a.probe!.ownership.generation).not.toBe(old.generation);
    await committed(a, "late-after-ready");
    await drained(a);
    await expect(a.remote.locator("#plain")).toHaveValue("");
    expect(
      a
        .probe!.trace.slice(beforeRelease)
        .filter((c) => c.method === "Input.imeSetComposition"),
    ).toHaveLength(0);
    expect(
      a.probe!.trace.filter((c) => c.method === "Input.insertText"),
    ).toHaveLength(0);
    await a.remote.evaluate(() => {
      const marker = document.createElement("div");
      marker.id = "native-marker";
      marker.style.cssText =
        "position:absolute;left:900px;top:350px;width:48px;height:48px;background:rgb(232,32,48);pointer-events:none";
      document.body.append(marker);
      document.addEventListener("input", () => {
        marker.style.background = "rgb(24,224,80)";
      });
    });
    await painted(a, false);
    const fresh = await position(a, "#plain");
    await a.page.mouse.click(fresh.x, fresh.y);
    await a.page.keyboard.type("fresh");
    await expect(a.remote.locator("#plain")).toHaveValue("fresh");
    await painted(a, true);
    await drained(a);
  } finally {
    try {
      await a?.close();
    } finally {
      host.close();
      await backend.close();
    }
  }
});

test("composition mode retires a held preview while an independent native window keeps editing and streaming", async ({
  browser,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const host = new ProbeHost(backend.endpoint);
  const viewers: Viewer[] = [];
  try {
    const a = await viewer(browser, backend, host, true, 0, {
      composition: true,
    });
    viewers.push(a);
    const b = await viewer(browser, backend, host, true, 0, {
      composition: true,
    });
    viewers.push(b);
    const at = await position(a, "#plain");
    await a.page.mouse.click(at.x, at.y);
    await drained(a);
    const held = a.probe!.holdNext("Input.imeSetComposition");
    await composing(a, "old");
    await held.held;
    const retiring = host.retire(a.probe!, "paused");
    await expect(
      host.admit({
        targetId: a.targetId,
        windowId: a.windowId,
        mode: "composition",
        reply: () => {},
      }),
    ).rejects.toThrow("unsettled owner");
    const independent = await position(b, "#plain");
    await b.page.mouse.click(independent.x, independent.y);
    await b.page.keyboard.type("sibling");
    await expect(b.remote.locator("#plain")).toHaveValue("sibling");
    await painted(b, true);
    await b.page.keyboard.down("Shift");
    await drained(b);
    held.release();
    expect(await retiring).toBe(true);
    await expect(a.remote.locator("#plain")).toHaveValue("");
    const events = await b.remote.evaluate(
      () =>
        (window as unknown as { nativeObserved: { events: string[] } })
          .nativeObserved.events,
    );
    expect(events.filter((event) => event === "keyup:Shift")).toHaveLength(0);
    expect(a.remote.isClosed()).toBe(false);
    await b.page.keyboard.up("Shift");
    await b.page.keyboard.type(" alive");
    await expect(b.remote.locator("#plain")).toHaveValue("sibling alive");
    await drained(b);
  } finally {
    try {
      for (const value of viewers) await value.close();
    } finally {
      host.close();
      await backend.close();
    }
  }
});

test("interaction mode keeps a real gesture-time clipboard write alive after activation expires", async ({
  browser,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const host = new ProbeHost(backend.endpoint);
  let a: Viewer | undefined;
  try {
    a = await viewer(browser, backend, host, true, 0, {
      composition: true,
      nativeFrames: true,
      beforeInput: (page) => observeClipboard(page, true),
    });
    await seedClipboard(a, "previous owned clipboard");
    await resumed(a);
    await a.remote.locator("#plain").fill("deferred owned selection");
    await a.remote.locator("#plain").selectText();
    const proxy = a.page.getByRole("textbox", {
      name: "Native executor input",
    });
    await proxy.focus();
    await proxy.press("ControlOrMeta+c");
    const cdp = await a.page.context().newCDPSession(a.page);
    try {
      await expect
        .poll(
          async () =>
            (
              await cdp.send("Runtime.evaluate", {
                expression: "window.nativeClipboardProbe.held",
                returnByValue: true,
                userGesture: false,
              })
            ).result.value,
        )
        .toBe(true);
      const expired = await cdp.send("Runtime.evaluate", {
        expression: `new Promise(resolve => {
          const start = performance.now();
          const timer = setInterval(() => {
            if (!navigator.userActivation.isActive) { clearInterval(timer); resolve(window.nativeClipboardProbe.gesture && window.nativeClipboardProbe.writes === 1 && window.nativeClipboardProbe.settled === 0); }
            else if (performance.now() - start > 8000) { clearInterval(timer); resolve(false); }
          }, 25);
        })`,
        returnByValue: true,
        awaitPromise: true,
        userGesture: false,
      });
      expect(expired.result.value).toBe(true);
      await cdp.send("Runtime.evaluate", {
        expression: "window.nativeClipboardProbe.release()",
        userGesture: false,
      });
      const completed = await cdp.send("Runtime.evaluate", {
        expression: `new Promise(resolve => {
          const start = performance.now();
          const timer = setInterval(() => {
            if (window.nativeClipboardProbe.settled === 1) { clearInterval(timer); resolve(!navigator.userActivation.isActive); }
            else if (performance.now() - start > 5000) { clearInterval(timer); resolve(false); }
          }, 25);
        })`,
        returnByValue: true,
        awaitPromise: true,
        userGesture: false,
      });
      expect(completed.result.value).toBe(true);
    } finally {
      await cdp.detach();
    }
    expect(await localClipboard(a)).toBe("deferred owned selection");
    expect(
      await a.page.evaluate(() => window.nativeExperiment.stats.revoked),
    ).toBe(false);
  } finally {
    try {
      await a?.close();
    } finally {
      host.close();
      await backend.close();
    }
  }
});

test("interaction mode transfers Unicode once and discards protected, empty and old-generation copy results", async ({
  browser,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const host = new ProbeHost(backend.endpoint);
  let a: Viewer | undefined;
  try {
    a = await viewer(browser, backend, host, true, 0, {
      composition: true,
      nativeFrames: true,
      beforeInput: observeClipboard,
    });
    await seedClipboard(a, "previous");
    await resumed(a);
    const oldReset = a.holdMessage("reply", "clipboard-reset");
    const at = await position(a, "#plain");
    await a.page.mouse.click(at.x, at.y);
    await a.page.keyboard.insertText("owned copy 🙂");
    await oldReset.held;
    await expect(a.remote.locator("#plain")).toHaveValue("owned copy 🙂");
    await a.remote.locator("#plain").selectText();
    const copied = a.holdMessage("reply", "selection");
    const copying = a.page.getByRole("textbox", {
      name: "Native executor input",
    });
    await copying.focus();
    await copying.press("ControlOrMeta+c");
    await copied.held;
    oldReset.release();
    copied.release();
    await a.page.waitForFunction(
      () =>
        (window as unknown as { nativeClipboardProbe: { settled: number } })
          .nativeClipboardProbe.settled === 1,
    );
    expect(await localClipboard(a)).toBe("owned copy 🙂");
    const unicode = "你好🙂\nsecond line";
    await seedClipboard(a, unicode);
    await resumed(a);
    await a.remote.evaluate(() => {
      document.querySelector<HTMLElement>("#native-marker")!.style.background =
        "rgb(232,32,48)";
    });
    await painted(a, false);
    await a.remote.locator("#multiline").focus();
    const before = a.probe!.trace.filter(
      (c) => c.method === "Input.insertText",
    ).length;
    const proxy = a.page.getByRole("textbox", {
      name: "Native executor input",
    });
    await proxy.focus();
    await proxy.press("ControlOrMeta+v");
    await expect(a.remote.locator("#multiline")).toHaveValue(unicode);
    await drained(a);
    await painted(a, true);
    expect(
      a.probe!.trace.filter((c) => c.method === "Input.insertText"),
    ).toHaveLength(before + 1);
    await a.remote.locator("#plain").fill("");
    await a.remote.locator("#plain").selectText();
    await copySelection(a);
    expect(await localClipboard(a)).toBe(unicode);
    await resumed(a);
    await a.remote.evaluate(() => {
      const protectedField = document.createElement("input");
      protectedField.type = "password";
      protectedField.value = "owned protected text";
      document.body.append(protectedField);
      protectedField.focus();
      protectedField.select();
    });
    await copySelection(a);
    expect(await localClipboard(a)).toBe(unicode);
    await resumed(a);
    await a.remote.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "opaque-frame";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = '<input value="owned opaque text">';
      document.body.append(frame);
      frame.focus();
    });
    await copySelection(a);
    expect(await localClipboard(a)).toBe(unicode);
    await resumed(a);
    await seedClipboard(a, "retained before stale reply");
    await resumed(a);
    await a.remote.locator("#plain").fill("must not reach clipboard");
    await a.remote.locator("#plain").selectText();
    const held = a.holdMessage("reply", "selection");
    await proxy.focus();
    await proxy.press("ControlOrMeta+c");
    await held.held;
    await proxy.evaluate((element: HTMLTextAreaElement) => element.blur());
    await resumed(a);
    held.release();
    expect(await localClipboard(a)).toBe("retained before stale reply");
    expect(
      await a.page.evaluate(() => window.nativeExperiment.stats.revoked),
    ).toBe(false);
  } finally {
    try {
      await a?.close();
    } finally {
      host.close();
      await backend.close();
    }
  }
});

test("interaction mode accepts maximum escaped clipboard text and bounds a large ordered burst", async ({
  browser,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const host = new ProbeHost(backend.endpoint);
  let a: Viewer | undefined;
  try {
    a = await viewer(browser, backend, host, true, 0, {
      composition: true,
      nativeFrames: true,
      beforeInput: async (page) => {
        await observeClipboard(page);
        await page.evaluate(() => {
          const sizes: number[] = [];
          Object.assign(window, { nativeBatchSizes: sizes });
          const NativeSocket = WebSocket;
          window.WebSocket = class extends NativeSocket {
            override send(data: Parameters<WebSocket["send"]>[0]) {
              if (typeof data === "string") sizes.push(data.length);
              super.send(data);
            }
          };
        });
      },
    });
    const text = "\\".repeat(64 * 1024);
    await seedClipboard(a, text);
    await resumed(a);
    await a.remote.locator("#multiline").focus();
    const proxy = a.page.getByRole("textbox", {
      name: "Native executor input",
    });
    await proxy.focus();
    await proxy.press("ControlOrMeta+v");
    await expect
      .poll(() =>
        a!.remote.evaluate(
          () =>
            document.querySelector<HTMLTextAreaElement>("#multiline")!.value
              .length,
        ),
      )
      .toBe(text.length);
    expect(
      await a.remote.evaluate(
        (text) =>
          document.querySelector<HTMLTextAreaElement>("#multiline")!.value ===
          text,
        text,
      ),
    ).toBe(true);
    await drained(a);
    await a.remote.evaluate(() => {
      document.querySelector<HTMLTextAreaElement>("#multiline")!.value = "";
    });
    // Actual native adapter events in one task force multi-action JSON packing.
    await proxy.evaluate((element: HTMLTextAreaElement, text) => {
      for (let i = 0; i < 4; i++) {
        element.value = text;
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: text,
          }),
        );
      }
    }, text);
    await expect
      .poll(() =>
        a!.remote.evaluate(
          () =>
            document.querySelector<HTMLTextAreaElement>("#multiline")!.value
              .length,
        ),
      )
      .toBe(text.length * 4);
    await drained(a);
    const sizes = await a.page.evaluate(
      () =>
        (window as unknown as { nativeBatchSizes: number[] }).nativeBatchSizes,
    );
    expect(sizes.every((n) => n <= compositionMessageLimit)).toBe(true);
    expect(sizes.some((n) => n > 128 * 1024)).toBe(true);
    expect(
      a.probe!.trace.filter((c) => c.method === "Input.insertText"),
    ).toHaveLength(5);
  } finally {
    try {
      await a?.close();
    } finally {
      host.close();
      await backend.close();
    }
  }
});

test("interaction mode retains native local-copy recovery under real clipboard policy denial", async ({
  browser,
}, info) => {
  const denied = await serveConsumer(consumer.dist, "/", {
    "Permissions-Policy": "clipboard-write=()",
  });
  const backend = await launchBackend(
    info.outputPath("backend"),
    denied.origin,
  );
  const host = new ProbeHost(backend.endpoint);
  let a: Viewer | undefined;
  try {
    a = await viewer(browser, backend, host, true, 0, {
      composition: true,
      nativeFrames: true,
      origin: denied.origin,
      beforeInput: observeClipboard,
    });
    await seedClipboard(a, "previous");
    await resumed(a);
    await a.remote.locator("#plain").fill("owned recovery text");
    await a.remote.locator("#plain").selectText();
    await copySelection(a);
    const recovery = a.page.getByRole("textbox", { name: "Text to copy" });
    await expect(recovery).toHaveValue("owned recovery text");
    await recovery.focus();
    await recovery.press("ControlOrMeta+c");
    expect(await localClipboard(a)).toBe("owned recovery text");
    await a.page
      .getByRole("button", { name: "Copy text", exact: true })
      .click();
    await expect(recovery).toHaveValue("owned recovery text");
    await a.page
      .getByRole("button", { name: "Dismiss copy", exact: true })
      .click();
    await expect(recovery).toHaveCount(0);
    await resumed(a);
    await a.remote.locator("#plain").fill("");
    const at = await position(a, "#plain");
    const canvas = a.page.locator("#viewer-a canvas");
    const geometry = await canvas.boundingBox();
    expect(
      await a.page.evaluate(() => window.nativeExperiment.stats.error),
    ).not.toBeNull();
    await a.page.mouse.move(at.x, at.y);
    await expect
      .poll(() => a!.page.evaluate(() => window.nativeExperiment.stats.error))
      .toBeNull();
    expect(await canvas.boundingBox()).toEqual(geometry);
    await a.page.mouse.click(at.x, at.y);
    await a.page.keyboard.type("still usable");
    await expect(a.remote.locator("#plain")).toHaveValue("still usable");
    await drained(a);
  } finally {
    try {
      await a?.close();
    } finally {
      host.close();
      await backend.close();
      await denied.close();
    }
  }
});

test("interaction mode keeps toolbar navigation admitted until a native click leaves remote focus", async ({
  browser,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const host = new ProbeHost(backend.endpoint);
  let a: Viewer | undefined;
  try {
    a = await viewer(browser, backend, host, true, 0, { composition: true });
    const proxy = a.page.getByRole("textbox", {
      name: "Native executor input",
    });
    const identity = await proxy.elementHandle();
    const at = await position(a, "#plain");
    await a.page.mouse.click(at.x, at.y);
    await a.page.keyboard.insertText("before toolbar navigation");
    await expect(a.remote.locator("#plain")).toHaveValue(
      "before toolbar navigation",
    );
    await drained(a);
    await expect(proxy).toBeFocused();
    const before = a.probe!.ownership;
    const reload = a.page.getByRole("button", {
      name: "Executor reload",
      exact: true,
    });
    const button = await reload.boundingBox();
    if (!button) throw new Error("Owned navigation control has no geometry");
    // A fast blur round trip must not hide admission loss inside this gesture.
    const blur = a.holdMessage("intent", "blur");
    try {
      await a.page.mouse.move(
        button.x + button.width / 2,
        button.y + button.height / 2,
      );
      await a.page.mouse.down();
      expect(await reload.isEnabled()).toBe(true);
      await expect(proxy).toBeFocused();
      await a.page.mouse.up();
    } finally {
      blur.release();
    }
    await resumed(a);
    await expect
      .poll(() => a!.probe!.ownership.document)
      .toBeGreaterThan(before.document);
    await expect(
      a.page.locator('[aria-label="Executor controls"]'),
    ).toBeFocused();
    await expect(a.remote.locator("#plain")).toHaveValue("");
    expect(
      await identity!.evaluate(
        (element) =>
          element ===
          document.querySelector('[aria-label="Native executor input"]'),
      ),
    ).toBe(true);
    const next = await position(a, "#plain");
    await a.page.mouse.click(next.x, next.y);
    await a.page.keyboard.insertText("after toolbar navigation");
    await expect(a.remote.locator("#plain")).toHaveValue(
      "after toolbar navigation",
    );
    await drained(a);
    expect(
      await a.page.evaluate(() => window.nativeExperiment.stats.revoked),
    ).toBe(false);
  } finally {
    try {
      await a?.close();
    } finally {
      host.close();
      await backend.close();
    }
  }
});

test("interaction mode orders toolbar navigation across same, full and retained 204 documents", async ({
  browser,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  const host = new ProbeHost(backend.endpoint);
  let a: Viewer | undefined;
  try {
    a = await viewer(browser, backend, host, true, 0, {
      composition: true,
      beforeInput: observeClipboard,
    });
    const proxy = a.page.getByRole("textbox", {
      name: "Native executor input",
    });
    const identity = await proxy.elementHandle();
    const address = a.page.getByRole("textbox", { name: "Executor address" });
    const initial = a.probe!.ownership;
    const held = a.probe!.holdNext("Page.navigate");
    await address.fill(a.remote.url() + "#owned");
    await a.page
      .getByRole("button", { name: "Executor navigate", exact: true })
      .click();
    await held.held;
    expect(
      await a.page.evaluate(() => window.nativeExperiment.stats.ready),
    ).toBe(false);
    expect(await a.remote.evaluate(() => location.hash)).toBe("#owned");
    held.release();
    await resumed(a);
    expect(a.probe!.ownership.document).toBe(initial.document);
    expect(a.probe!.ownership.focus).toBeGreaterThan(initial.focus);
    await expect
      .poll(() =>
        a!.page.evaluate(() => window.nativeExperiment.stats.navigation?.url),
      )
      .toContain("#owned");
    const full = server.origin + "/fixture/editor?full";
    const beforeFull = a.probe!.ownership;
    await address.fill(full);
    await a.page
      .getByRole("button", { name: "Executor navigate", exact: true })
      .click();
    await expect(a.remote).toHaveURL(full);
    await resumed(a);
    expect(a.probe!.ownership.document).toBeGreaterThan(beforeFull.document);
    await expect
      .poll(() =>
        a!.page.evaluate(() => window.nativeExperiment.stats.navigation?.url),
      )
      .toBe(full);
    await a.page
      .getByRole("button", { name: "Executor back", exact: true })
      .click();
    await expect(a.remote).toHaveURL(/#owned$/);
    await resumed(a);
    await a.page
      .getByRole("button", { name: "Executor forward", exact: true })
      .click();
    await expect(a.remote).toHaveURL(full);
    await resumed(a);
    const reloaded = a.remote.waitForEvent("load");
    await a.page
      .getByRole("button", { name: "Executor reload", exact: true })
      .click();
    await reloaded;
    await resumed(a);
    await a.remote.evaluate(() => {
      const marker = document.createElement("div");
      marker.id = "native-marker";
      marker.style.cssText =
        "position:absolute;left:900px;top:350px;width:48px;height:48px;background:rgb(232,32,48);pointer-events:none";
      document.body.append(marker);
      document.addEventListener("input", () => {
        marker.style.background = "rgb(24,224,80)";
      });
      Object.assign(window, { retainedSentinel: "owned-context" });
    });
    await painted(a, false);
    const at = await position(a, "#plain");
    await a.page.mouse.click(at.x, at.y);
    await composing(a, "preview");
    await expect(a.remote.locator("#plain")).toHaveValue("preview");
    const before204 = a.probe!.ownership;
    const response = a.remote.waitForResponse(
      server.origin + "/fixture/no-content",
    );
    await address.fill(server.origin + "/fixture/no-content");
    await a.page
      .getByRole("button", { name: "Executor navigate", exact: true })
      .click();
    expect((await response).status()).toBe(204);
    await resumed(a);
    expect(a.probe!.ownership.document).toBe(before204.document);
    expect(a.remote.url()).toBe(full);
    expect(
      await a.remote.evaluate(
        () =>
          (window as unknown as { retainedSentinel: string }).retainedSentinel,
      ),
    ).toBe("owned-context");
    expect(
      await a.remote.evaluate(
        () => document.querySelector<HTMLInputElement>("#plain")!.value,
      ),
    ).toBe("");
    await a.remote.evaluate(() => {
      document.querySelector<HTMLElement>("#native-marker")!.style.background =
        "rgb(232,32,48)";
    });
    await painted(a, false);
    await a.page.mouse.click(at.x, at.y);
    await a.page.keyboard.type("after 204");
    await expect
      .poll(() =>
        a!.remote.evaluate(
          () => document.querySelector<HTMLInputElement>("#plain")!.value,
        ),
      )
      .toBe("after 204");
    await painted(a, true);
    await drained(a);
    await a.page.keyboard.press("F8");
    await expect(address).toBeFocused();
    await resumed(a);
    expect(
      await identity!.evaluate(
        (element) =>
          element ===
          document.querySelector('[aria-label="Native executor input"]'),
      ),
    ).toBe(true);
    const local = a.page.getByRole("textbox", {
      name: "Owned local clipboard field",
    });
    await local.fill("local host draft");
    await expect(local).toHaveValue("local host draft");
    expect(
      await a.remote.evaluate(
        () => document.querySelector<HTMLInputElement>("#plain")!.value,
      ),
    ).toBe("after 204");
  } finally {
    try {
      await a?.close();
    } finally {
      host.close();
      await backend.close();
    }
  }
});

for (const oneWayMs of [0, 50])
  test(`actual NativeInput matched pointer/key feedback, ${oneWayMs}ms one way`, async ({
    browser,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    const host = new ProbeHost(backend.endpoint);
    const rows: object[] = [];
    try {
      for (const concurrent of [false, true])
        for (const adjacent of [false, true]) {
          const viewers: Viewer[] = [];
          try {
            for (let n = 0; n < (concurrent ? 2 : 1); n++)
              viewers.push(
                await viewer(browser, backend, host, adjacent, oneWayMs),
              );
            for (const workload of ["click-type", "scroll"] as const)
              for (let trial = 0; trial < 3; trial++) {
                // A distinct marker per trial cannot accept an earlier green frame.
                const markerIndex = trial + (workload === "scroll" ? 3 : 0);
                const color = [
                  24 + markerIndex * 12,
                  224 - markerIndex * 8,
                  80 + markerIndex * 16,
                ];
                await Promise.all(
                  viewers.map(async (value) => {
                    await value.remote.evaluate(
                      async ({ marker, scroll }) => {
                        if (scrollY !== 0)
                          await new Promise<void>((resolve) => {
                            window.addEventListener("scroll", () => resolve(), {
                              once: true,
                            });
                            scrollTo(0, 0);
                          });
                        document.querySelector<HTMLInputElement>(
                          "#plain",
                        )!.value = "";
                        const observed = (
                          window as unknown as {
                            nativeObserved: {
                              effect: number;
                              color: string;
                            };
                          }
                        ).nativeObserved;
                        observed.effect = 0;
                        observed.color = `rgb(${marker.join(",")})`;
                        document.querySelector<HTMLElement>(
                          "#native-marker",
                        )!.style.background = scroll
                          ? observed.color
                          : "rgb(232,32,48)";
                      },
                      { marker: color, scroll: workload === "scroll" },
                    );
                    await expect
                      .poll(() => value.remote.evaluate(() => scrollY))
                      .toBe(0);
                    // Observe the reset before installing the final-feedback watch.
                    await painted(value, workload === "scroll" ? color : false);
                    await drained(value);
                    if (value.probe)
                      await value.page.evaluate(() => {
                        window.nativeExperiment.stats.peakOutstanding = 0;
                      });
                  }),
                );
                const observations = await Promise.all(
                  viewers.map(async (value, index) => {
                    const point = {
                      ...value.marker,
                      y:
                        value.marker.y -
                        (workload === "scroll" ? value.marker.scroll : 0),
                    };
                    const at = await position(value, "#plain");
                    if (workload === "scroll")
                      await value.page.mouse.move(at.x, at.y);
                    await value.page.evaluate(
                      ({ marker, point }) => {
                        Object.assign(window, {
                          nativeTiming: { start: 0, paint: 0 },
                        });
                        const timing = (
                          window as unknown as {
                            nativeTiming: { start: number; paint: number };
                          }
                        ).nativeTiming;
                        const start = (event: Event) => {
                          if (
                            event.type === "mousedown" ||
                            event.type === "wheel"
                          ) {
                            timing.start ||= Date.now();
                            document.removeEventListener(
                              "mousedown",
                              start,
                              true,
                            );
                            document.removeEventListener("wheel", start, true);
                          }
                        };
                        document.addEventListener("mousedown", start, true);
                        document.addEventListener("wheel", start, true);
                        const watch = () => {
                          const canvas =
                            document.querySelector<HTMLCanvasElement>(
                              "#viewer-a canvas",
                            )!;
                          const pixel = canvas
                            .getContext("2d")!
                            .getImageData(
                              Math.floor(point.x * canvas.width),
                              Math.floor(point.y * canvas.height),
                              1,
                              1,
                            ).data;
                          if (
                            marker.every((n, i) => Math.abs(n - pixel[i]!) <= 4)
                          )
                            timing.paint = Date.now();
                          else requestAnimationFrame(watch);
                        };
                        requestAnimationFrame(watch);
                      },
                      { marker: color, point },
                    );
                    const startCommands =
                      value.probe?.trace.length ?? value.commands.length;
                    if (workload === "click-type") {
                      await value.page.mouse.click(at.x, at.y);
                      await value.page.keyboard.type("x");
                      await expect(value.remote.locator("#plain")).toHaveValue(
                        "x",
                      );
                    } else {
                      await value.page.mouse.wheel(0, 300);
                      await expect
                        .poll(() => value.remote.evaluate(() => scrollY))
                        .toBe(300);
                    }
                    await painted(value, color, point);
                    if (workload === "scroll")
                      await expect
                        .poll(() =>
                          value.page
                            .locator("#viewer-a canvas")
                            .evaluate((canvas: HTMLCanvasElement, original) => {
                              const pixel = canvas
                                .getContext("2d")!
                                .getImageData(
                                  Math.floor(original.x * canvas.width),
                                  Math.floor(original.y * canvas.height),
                                  1,
                                  1,
                                ).data;
                              return [255, 255, 255].every(
                                (n, i) => Math.abs(n - pixel[i]!) <= 4,
                              );
                            }, value.marker),
                        )
                        .toBe(true);
                    await drained(value);
                    await value.page.waitForFunction(
                      () =>
                        (
                          window as unknown as {
                            nativeTiming: { paint: number };
                          }
                        ).nativeTiming.paint > 0,
                    );
                    const effect = await value.remote.evaluate(
                      () =>
                        (
                          window as unknown as {
                            nativeObserved: { effect: number };
                          }
                        ).nativeObserved.effect,
                    );
                    const timing = await value.page.evaluate(
                      () =>
                        (
                          window as unknown as {
                            nativeTiming: { start: number; paint: number };
                          }
                        ).nativeTiming,
                    );
                    expect(timing.start).toBeGreaterThan(0);
                    expect(effect).toBeGreaterThanOrEqual(timing.start);
                    expect(timing.paint).toBeGreaterThanOrEqual(timing.start);
                    if (workload === "click-type")
                      expect(timing.paint).toBeGreaterThanOrEqual(effect);
                    for (const capture of value.captures)
                      expect(capture).toEqual({
                        format: "jpeg",
                        quality: 70,
                        maxWidth: 1920,
                        maxHeight: 1080,
                      });
                    expect(value.captures.length).toBeGreaterThan(0);
                    const commands =
                      value.probe?.trace.slice(startCommands) ??
                      value.commands
                        .slice(startCommands)
                        .map((method) => ({ method }));
                    expect(
                      commands.filter((c) => c.method.startsWith("Input."))
                        .length,
                    ).toBeGreaterThan(0);
                    if (value.probe)
                      expect(
                        commands.filter(
                          (c) => c.method === "Browser.getWindowForTarget",
                        ).length,
                      ).toBeGreaterThanOrEqual(
                        commands.filter((c) => c.method.startsWith("Input."))
                          .length,
                      );
                    const row = {
                      adjacent,
                      concurrent,
                      viewer: index,
                      workload,
                      trial,
                      oneWayMs,
                      remoteDomMs: effect - timing.start,
                      finalCanvasMs: timing.paint - timing.start,
                      nativeWrites: commands.filter((c) =>
                        c.method.startsWith("Input."),
                      ).length,
                      freshLookups: commands.filter(
                        (c) => c.method === "Browser.getWindowForTarget",
                      ).length,
                      peakUnconfirmedActions: value.probe
                        ? await value.page.evaluate(
                            () => window.nativeExperiment.stats.peakOutstanding,
                          )
                        : null,
                      markerColor: color,
                      markerPoint: { x: point.x, y: point.y },
                    };
                    rows.push(row);
                    return row;
                  }),
                );
                console.log(JSON.stringify(observations));
              }
          } finally {
            for (const value of viewers) await value.close();
          }
        }
      await writeFile(
        info.outputPath("native-measurements.json"),
        JSON.stringify(
          {
            source: process.env.CDP_VIEWER_SOURCE_SHA,
            checkout: execFileSync("git", ["rev-parse", "HEAD"], {
              encoding: "utf8",
            }).trim(),
            worktreeClean:
              execFileSync("git", ["status", "--porcelain"], {
                encoding: "utf8",
              }).trim().length === 0,
            consumer: consumer.receipt,
            browser: browser.version(),
            oneWayMs,
            rows,
            scope:
              "Actual NativeInput on both paths, common host clock, matched default capture, public direct versus private bundled native batch fixture and actual adjacent InputSession. Click/type changes a unique document marker color; scroll observes its actual 300px translation, independently of DOM scroll-event ordering and post-scroll application repaints. Terminal blur; no composition/clipboard/navigation parity, production/provider/OS/adoption or physical-display claim. Batch fences add real candidate overhead.",
          },
          null,
          2,
        ),
      );
    } finally {
      host.close();
      await backend.close();
    }
  });
