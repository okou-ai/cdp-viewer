import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { prepareConsumer } from "../../scripts/consumer.mjs";
import { launchBackend, serveConsumer } from "../browser/backend";
import { ProbeHost } from "./probe-host";
import { assertExperimentSource } from "./assert-source";
import type { GuardedProbe } from "./guarded-probe";
import type {} from "./native-client";
import type {} from "../consumer/api";

test.use({ channel: "chromium" });
let consumer: Awaited<ReturnType<typeof prepareConsumer>>;
let server: Awaited<ReturnType<typeof serveConsumer>>;
let clientCode: string;
test.beforeAll(async () => {
  assertExperimentSource();
  consumer = await prepareConsumer();
  const output = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(new URL("./native-client.ts", import.meta.url)),
        formats: ["iife"],
        name: "NativeExperiment",
      },
    },
  });
  const bundle = Array.isArray(output) ? output[0] : output;
  if (!bundle || !("output" in bundle))
    throw new Error("Native fixture bundle is missing");
  const chunk = bundle.output.find((item) => item.type === "chunk");
  if (!chunk) throw new Error("Native fixture entry is missing");
  clientCode = chunk.code;
  server = await serveConsumer(consumer.dist);
});
test.afterAll(async () => {
  try {
    await server?.close();
  } finally {
    await consumer?.cleanup();
  }
});

type Backend = Awaited<ReturnType<typeof launchBackend>>;
interface Viewer {
  page: Page;
  remote: Page;
  probe?: GuardedProbe;
  targetId: string;
  windowId: number;
  captures: object[];
  close: () => Promise<void>;
}

async function viewer(
  browser: Browser,
  backend: Backend,
  host: ProbeHost,
  adjacent: boolean,
  oneWayMs = 0,
): Promise<Viewer> {
  const created = backend.context.waitForEvent("page");
  const { targetId } = await backend.session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const remote = await created;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const captures: object[] = [];
  let closed = false;
  let probe: GuardedProbe | undefined;
  const transit = (run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closed) run();
    }, oneWayMs);
    timers.add(timer);
  };
  try {
    await remote.goto(server.origin + "/fixture/editor?native=" + targetId);
    await remote.evaluate(() => {
      const marker = document.createElement("div");
      marker.id = "native-marker";
      marker.style.cssText =
        "position:fixed;inset:0 auto auto 0;width:28px;height:28px;background:rgb(232,32,48);z-index:1000";
      document.body.append(marker);
      const observed = { effect: 0, events: [] as string[] };
      Object.assign(window, { nativeObserved: observed });
      for (const type of [
        "mousedown",
        "mouseup",
        "mousemove",
        "keydown",
        "keyup",
        "input",
        "scroll",
      ])
        document.addEventListener(
          type,
          (event) => {
            observed.events.push(
              type + (event instanceof KeyboardEvent ? ":" + event.key : ""),
            );
            if (type === "input" || (type === "scroll" && scrollY >= 300)) {
              observed.effect ||= Date.now();
              marker.style.background = "rgb(24,224,80)";
            }
          },
          true,
        );
    });
    const { windowId } = await backend.session.send(
      "Browser.getWindowForTarget",
      { targetId },
    );
    await context.routeWebSocket(backend.endpoint, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const command = JSON.parse(String(message)) as {
          method: string;
          params?: object;
        };
        if (command.method === "Page.startScreencast" && command.params)
          captures.push(command.params);
        transit(() => upstream.send(message));
      });
      upstream.onMessage((message) => transit(() => socket.send(message)));
      socket.onClose(() => {
        void upstream.close();
      });
      upstream.onClose(() => {
        void socket.close();
      });
    });
    const endpoint = "wss://native.fixture.invalid/" + targetId;
    if (adjacent) {
      let reply: ((data: string) => void) | undefined;
      probe = await host.admit({
        targetId,
        windowId,
        mode: "native",
        reply: (value) => transit(() => reply?.(JSON.stringify(value))),
      });
      const admitted = probe;
      await context.routeWebSocket(endpoint, (socket) => {
        reply = (data) => socket.send(data);
        socket.onMessage((data) =>
          transit(() => {
            admitted.receive(String(data));
          }),
        );
        socket.onClose(() => {
          void host.retire(admitted);
        });
      });
    }
    const page = await context.newPage();
    await page.goto(server.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate((settings) => window.configureViewers!(settings), {
      cdpUrl: backend.endpoint,
      windowA: windowId,
      interactive: !adjacent,
      second: false,
    });
    await expect(page.locator("#viewer-a .cdpv-root")).toHaveAttribute(
      "data-status",
      "streaming",
    );
    if (probe) {
      await page.addScriptTag({ content: clientCode });
      await page.evaluate(
        (settings) => window.installNativeExperiment(settings),
        { endpoint, owner: probe.owner },
      );
    }
    return {
      page,
      remote,
      targetId,
      windowId,
      captures,
      ...(probe ? { probe } : {}),
      close: async () => {
        closed = true;
        for (const timer of timers) clearTimeout(timer);
        try {
          if (probe) await host.retire(probe);
        } finally {
          try {
            await context.close();
          } finally {
            await remote.close();
          }
        }
      },
    };
  } catch (error) {
    probe?.close();
    try {
      await context.close();
    } finally {
      await remote.close();
    }
    throw error;
  }
}

async function position(value: Viewer, selector: string) {
  const box = await value.remote.locator(selector).boundingBox();
  if (!box) throw new Error("Owned remote control has no geometry");
  const viewport = await value.remote.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  return value.page.locator("#viewer-a canvas").evaluate(
    (canvas: HTMLCanvasElement, data) => {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(
        rect.width / canvas.width,
        rect.height / canvas.height,
      );
      const width = canvas.width * scale,
        height = canvas.height * scale;
      return {
        x: rect.left + (rect.width - width) / 2 + (width * data.x) / data.width,
        y:
          rect.top +
          (rect.height - height) / 2 +
          (height * data.y) / data.height,
      };
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2, ...viewport },
  );
}

async function painted(value: Viewer, green: boolean) {
  await expect
    .poll(() =>
      value.page.locator("#viewer-a canvas").evaluate(
        (canvas: HTMLCanvasElement, color) => {
          const pixel = canvas.getContext("2d")!.getImageData(4, 4, 1, 1).data;
          return color.every((n, i) => Math.abs(n - pixel[i]!) <= 4);
        },
        green ? [24, 224, 80] : [232, 32, 48],
      ),
    )
    .toBe(true);
}

async function drained(value: Viewer) {
  if (value.probe)
    await value.page.waitForFunction(
      () =>
        !window.nativeExperiment.stats.revoked &&
        window.nativeExperiment.stats.acknowledgements.length ===
          window.nativeExperiment.stats.batches,
    );
}

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
    const drag = await position(b, "#plain");
    await b.page.mouse.move(drag.x - 25, drag.y);
    await b.page.mouse.down();
    await b.page.mouse.move(drag.x + 25, drag.y, { steps: 4 });
    await b.page.mouse.up();
    await drained(b);
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
                await Promise.all(
                  viewers.map(async (value) => {
                    await value.remote.evaluate(async () => {
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
                      document.querySelector<HTMLElement>(
                        "#native-marker",
                      )!.style.background = "rgb(232,32,48)";
                      (
                        window as unknown as {
                          nativeObserved: { effect: number };
                        }
                      ).nativeObserved.effect = 0;
                    });
                    await expect
                      .poll(() => value.remote.evaluate(() => scrollY))
                      .toBe(0);
                    // Observe the reset before installing the final-feedback watch.
                    await painted(value, false);
                    await drained(value);
                  }),
                );
                const observations = await Promise.all(
                  viewers.map(async (value, index) => {
                    const at = await position(value, "#plain");
                    if (workload === "scroll")
                      await value.page.mouse.move(at.x, at.y);
                    await value.page.evaluate(() => {
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
                        const pixel = document
                          .querySelector<HTMLCanvasElement>("#viewer-a canvas")!
                          .getContext("2d")!
                          .getImageData(4, 4, 1, 1).data;
                        if (
                          [24, 224, 80].every(
                            (n, i) => Math.abs(n - pixel[i]!) <= 4,
                          )
                        )
                          timing.paint = Date.now();
                        else requestAnimationFrame(watch);
                      };
                      requestAnimationFrame(watch);
                    });
                    const startCommands = value.probe?.trace.length ?? 0;
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
                        .toBeGreaterThanOrEqual(300);
                    }
                    await painted(value, true);
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
                      value.probe?.trace.slice(startCommands) ?? [];
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
              "Actual NativeInput on both paths, same host clock, matched default capture, public direct versus private bundled native batch fixture and actual adjacent InputSession. Terminal blur; no composition/clipboard/navigation parity, production/provider/OS/adoption or physical-display claim. Batch fences add real candidate overhead.",
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
