import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { launchBackend } from "../browser/backend";
import { ProbeHost } from "./probe-host";
import {
  createNativeFixture,
  drained,
  localClipboard,
  observeClipboard,
  painted,
  position,
  resumed,
  seedClipboard,
} from "./native-fixture";
import type { Viewer } from "./native-fixture";

interface Sample {
  adjacent: boolean;
  viewers: number;
  simultaneous: boolean;
  viewer: number;
  trial: number;
  workload: string;
  oneWayMs: number;
  remoteDomMs: number | null;
  finalCanvasMs: number | null;
  localCompletionMs: number | null;
  observedThroughMs: number;
  nativeWrites: number;
  navigationWrites: number;
  freshLookups: number;
  peakUnconfirmedActions: number | null;
}

declare global {
  interface Window {
    fullInteractionTiming: { start: number; paint: number };
  }
}

test.use({ channel: "chromium" });
let fixture: Awaited<ReturnType<typeof createNativeFixture>>;
let colorVersion = 0;
test.beforeAll(async () => {
  fixture = await createNativeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

function proxy(value: Viewer) {
  return value.page.getByRole("textbox", {
    name: value.probe ? "Native executor input" : "Remote browser input",
  });
}

async function ready(value: Viewer) {
  if (value.probe) await resumed(value);
}

async function focus(value: Viewer, selector: string) {
  await ready(value);
  const before = await value.remote.evaluate(
    () =>
      (
        window as unknown as { nativeObserved: { events: string[] } }
      ).nativeObserved.events.filter((event) => event === "mouseup").length,
  );
  const at = await position(value, selector);
  await value.page.mouse.click(at.x, at.y);
  await expect
    .poll(() =>
      value.remote.evaluate(
        () =>
          (
            window as unknown as { nativeObserved: { events: string[] } }
          ).nativeObserved.events.filter((event) => event === "mouseup").length,
      ),
    )
    .toBeGreaterThan(before);
  await expect(value.remote.locator(selector)).toBeFocused();
  await drained(value);
}

async function arm(
  value: Viewer,
  control: Locator,
  event: string,
  pixels = true,
) {
  const version = ++colorVersion;
  const color = [
    32 + ((version * 37) % 160),
    64 + ((version * 53) % 160),
    48 + ((version * 71) % 160),
  ];
  if (pixels) {
    await value.remote.evaluate((color) => {
      const observed = (
        window as unknown as {
          nativeObserved: { effect: number; color: string };
        }
      ).nativeObserved;
      observed.effect = 0;
      observed.color = `rgb(${color.join(",")})`;
      document.querySelector<HTMLElement>("#native-marker")!.style.background =
        "rgb(232,32,48)";
    }, color);
    await painted(value, false);
  }
  if (value.probe)
    await value.page.evaluate(() => {
      window.nativeExperiment.stats.peakOutstanding = 0;
    });
  await control.evaluate(
    (element, { event, color, point, pixels }) => {
      const timing = { start: 0, paint: 0 };
      window.fullInteractionTiming = timing;
      element.addEventListener(event, () => (timing.start = Date.now()), {
        capture: true,
        once: true,
      });
      if (!pixels) return;
      const watch = () => {
        const canvas =
          document.querySelector<HTMLCanvasElement>("#viewer-a canvas")!;
        const pixel = canvas
          .getContext("2d")!
          .getImageData(
            Math.floor(point.x * canvas.width),
            Math.floor(point.y * canvas.height),
            1,
            1,
          ).data;
        if (color.every((n, i) => Math.abs(n - pixel[i]!) <= 4))
          timing.paint = Date.now();
        else requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    },
    { event, color, point: value.marker, pixels },
  );
  return {
    color,
    commandStart: value.probe?.trace.length ?? value.commands.length,
  };
}

async function observed(
  value: Viewer,
  start: Awaited<ReturnType<typeof arm>>,
  pixels = true,
) {
  if (pixels) {
    await painted(value, start.color);
    await value.page.waitForFunction(
      () => window.fullInteractionTiming.paint > 0,
    );
  }
  await drained(value);
  const timing = await value.page.evaluate(() => window.fullInteractionTiming);
  const effect = await value.remote.evaluate(
    () =>
      (window as unknown as { nativeObserved: { effect: number } })
        .nativeObserved.effect,
  );
  expect(timing.start).toBeGreaterThan(0);
  if (pixels) {
    expect(effect).toBeGreaterThanOrEqual(timing.start);
    expect(timing.paint).toBeGreaterThanOrEqual(effect);
  }
  const commands =
    value.probe?.trace.slice(start.commandStart) ??
    value.commands.slice(start.commandStart).map((method) => ({ method }));
  for (const capture of value.captures)
    expect(capture).toEqual({
      format: "jpeg",
      quality: 70,
      maxWidth: 1920,
      maxHeight: 1080,
    });
  expect(value.captures.length).toBeGreaterThan(0);
  const nativeWrites = commands.filter((c) =>
    c.method.startsWith("Input."),
  ).length;
  const navigationWrites = commands.filter(
    (c) => c.method === "Page.navigate",
  ).length;
  const freshLookups = commands.filter(
    (c) => c.method === "Browser.getWindowForTarget",
  ).length;
  expect(freshLookups).toBeGreaterThan(0);
  expect(nativeWrites + navigationWrites).toBeGreaterThan(0);
  return {
    remoteDomMs: pixels ? effect - timing.start : null,
    finalCanvasMs: pixels ? timing.paint - timing.start : null,
    localCompletionMs: null as number | null,
    observedThroughMs: Date.now() - timing.start,
    nativeWrites,
    navigationWrites,
    freshLookups,
    peakUnconfirmedActions: value.probe
      ? await value.page.evaluate(
          () => window.nativeExperiment.stats.peakOutstanding,
        )
      : null,
  };
}

for (const oneWayMs of [0, 50])
  test(`full interaction matched composition clipboard navigation at ${oneWayMs}ms each way`, async ({
    browser,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      fixture.server.origin,
    );
    const host = new ProbeHost(backend.endpoint);
    const rows: Sample[] = [];
    try {
      for (const count of [1, 2])
        for (const adjacent of [false, true]) {
          const viewers: Viewer[] = [];
          try {
            for (let index = 0; index < count; index++) {
              const value = await fixture.viewer(
                browser,
                backend,
                host,
                adjacent,
                oneWayMs,
                { composition: true },
              );
              viewers.push(value);
              await observeClipboard(value.page);
              await value.remote.evaluate(() => {
                addEventListener("hashchange", () => {
                  const observed = (
                    window as unknown as {
                      nativeObserved: { effect: number; color: string };
                    }
                  ).nativeObserved;
                  observed.effect = Date.now();
                  document.querySelector<HTMLElement>(
                    "#native-marker",
                  )!.style.background = observed.color;
                });
              });
            }
            for (let trial = 0; trial < 3; trial++) {
              const record = (
                index: number,
                workload: string,
                result: Awaited<ReturnType<typeof observed>>,
              ) =>
                rows.push({
                  adjacent,
                  viewers: count,
                  simultaneous: count === 2 && workload !== "copy",
                  viewer: index,
                  trial,
                  workload,
                  oneWayMs,
                  ...result,
                });
              await Promise.all(
                viewers.map(async (value, index) => {
                  await value.remote.locator("#plain").fill("");
                  await focus(value, "#plain");
                  const input = proxy(value);
                  let start = await arm(value, input, "compositionstart");
                  await input.evaluate((element: HTMLTextAreaElement) => {
                    element.dispatchEvent(
                      new CompositionEvent("compositionstart", {
                        bubbles: true,
                      }),
                    );
                    element.value = "ni";
                    element.setSelectionRange(2, 2);
                    element.dispatchEvent(
                      new InputEvent("input", {
                        bubbles: true,
                        isComposing: true,
                        inputType: "insertCompositionText",
                        data: "ni",
                      }),
                    );
                  });
                  await expect(value.remote.locator("#plain")).toHaveValue(
                    "ni",
                  );
                  record(index, "preedit", await observed(value, start));
                  start = await arm(value, input, "compositionend");
                  await input.evaluate((element: HTMLTextAreaElement) => {
                    element.value = "你";
                    element.dispatchEvent(
                      new CompositionEvent("compositionend", {
                        bubbles: true,
                        data: "你",
                      }),
                    );
                    element.dispatchEvent(
                      new InputEvent("input", {
                        bubbles: true,
                        inputType: "insertFromComposition",
                        data: "你",
                      }),
                    );
                  });
                  await expect(value.remote.locator("#plain")).toHaveValue(
                    "你",
                  );
                  record(index, "commit", await observed(value, start));
                }),
              );
              // One physical client clipboard is shared by these pages. Measure
              // trusted copy gestures serially, then paste concurrently.
              const text = `owned Unicode 你好 ${trial}`;
              for (const [index, value] of viewers.entries()) {
                await seedClipboard(value, "previous local clipboard");
                await ready(value);
                await value.remote.locator("#plain").fill(text);
                await value.remote.locator("#plain").selectText();
                await proxy(value).focus();
                const before = await value.page.evaluate(
                  () =>
                    (
                      window as unknown as {
                        nativeClipboardProbe: { settled: number };
                      }
                    ).nativeClipboardProbe.settled,
                );
                const start = await arm(value, proxy(value), "keydown", false);
                await proxy(value).press("ControlOrMeta+c");
                await value.page.waitForFunction(
                  (before) =>
                    (
                      window as unknown as {
                        nativeClipboardProbe: { settled: number };
                      }
                    ).nativeClipboardProbe.settled ===
                    before + 1,
                  before,
                );
                const completed = await value.page.evaluate(() => {
                  const observed = (
                    window as unknown as {
                      nativeClipboardProbe: {
                        completedAt: number;
                        gesture: boolean;
                      };
                    }
                  ).nativeClipboardProbe;
                  return {
                    start: window.fullInteractionTiming.start,
                    completedAt: observed.completedAt,
                    gesture: observed.gesture,
                  };
                });
                expect(completed.gesture).toBe(true);
                const result = await observed(value, start, false);
                result.localCompletionMs =
                  completed.completedAt - completed.start;
                expect(result.localCompletionMs).toBeGreaterThanOrEqual(0);
                expect(await localClipboard(value)).toBe(text);
                await ready(value);
                record(index, "copy", result);
              }
              await Promise.all(
                viewers.map(async (value, index) => {
                  await value.remote.locator("#multiline").fill("");
                  await focus(value, "#multiline");
                  const start = await arm(value, proxy(value), "keydown");
                  await proxy(value).press("ControlOrMeta+v");
                  await expect(value.remote.locator("#multiline")).toHaveValue(
                    text,
                  );
                  record(index, "paste", await observed(value, start));
                }),
              );
              await Promise.all(
                viewers.map(async (value, index) => {
                  const address = value.page.getByRole("textbox", {
                    name: adjacent ? "Executor address" : "Remote page address",
                  });
                  const destination =
                    value.remote.url().split("#")[0] + `#assessment-${trial}`;
                  await address.fill(destination);
                  await ready(value);
                  let start = await arm(value, address, "keydown");
                  await address.press("Enter");
                  await expect(value.remote).toHaveURL(destination);
                  await ready(value);
                  record(
                    index,
                    "same-document-navigation",
                    await observed(value, start),
                  );
                  await value.remote.locator("#plain").fill("");
                  await focus(value, "#plain");
                  start = await arm(value, proxy(value), "input");
                  await value.page.keyboard.insertText("after navigation");
                  await expect(value.remote.locator("#plain")).toHaveValue(
                    "after navigation",
                  );
                  record(
                    index,
                    "post-navigation-text",
                    await observed(value, start),
                  );
                }),
              );
            }
          } finally {
            for (const value of viewers.reverse()) await value.close();
          }
        }
      await writeFile(
        info.outputPath("full-interaction.json"),
        JSON.stringify(
          {
            source: process.env.CDP_VIEWER_SOURCE_SHA,
            checkout: execFileSync("git", ["rev-parse", "HEAD"], {
              encoding: "utf8",
            }).trim(),
            cleanCheckout:
              execFileSync("git", ["status", "--porcelain"], {
                encoding: "utf8",
              }).trim() === "",
            consumer: fixture.consumer.receipt,
            browser: browser.version(),
            capture: {
              format: "jpeg",
              quality: 70,
              maxWidth: 1920,
              maxHeight: 1080,
            },
            oneWayMs,
            rows,
            limits: [
              "Synthetic local composition, not physical OS IME",
              "Clipboard copy gestures serial on the shared client clipboard; other paired workloads simultaneous",
              "Representative same-document navigation timing; full/history/reload/204 correctness remains in recovery cases",
              "Private fixture topology, not deployed authentication/provider/host-restart/capacity/cost proof",
              "Observed-through includes verification and ACK joins, not exact direct acknowledgement drain",
            ],
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
