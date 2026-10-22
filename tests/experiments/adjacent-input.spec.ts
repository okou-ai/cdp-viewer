import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { prepareConsumer } from "../../scripts/consumer.mjs";
import { launchBackend, serveConsumer } from "../browser/backend";
import type { GuardedProbe } from "./guarded-probe";
import { installProbeClient } from "./probe-client";
import { ProbeHost } from "./probe-host";
import { assertExperimentSource } from "./assert-source";
import type {} from "../consumer/api";

declare global {
  interface Window {
    inputProbe: {
      keys: number[];
      text: number[];
      intents: number[];
      paint: number | null;
      token: number;
    };
    probeStats: {
      sent: number[];
      acknowledged: number[];
      peakOutstanding: number;
      revoked: boolean;
    };
  }
}

interface Command {
  method: string;
  sent: number;
  response?: number;
  capture?: object;
}

interface Viewer {
  page: Page;
  context: BrowserContext;
  remote: Page;
  probe: GuardedProbe | undefined;
  commands: Command[];
  acknowledgements: number[];
  close: () => Promise<void>;
}

let consumer: Awaited<ReturnType<typeof prepareConsumer>>;
let server: Awaited<ReturnType<typeof serveConsumer>>;
test.beforeAll(async () => {
  // The prototype reuses this checkout's private coordinator; its runtime must
  // match the independently installed public control, including working changes.
  assertExperimentSource();
  consumer = await prepareConsumer();
  server = await serveConsumer(consumer.dist);
});
test.afterAll(async () => {
  try {
    await server?.close();
  } finally {
    await consumer?.cleanup();
  }
});

for (const oneWayMs of [0, 50]) {
  test(`guarded adjacent keys/text, ${oneWayMs}ms transit each direction`, async ({
    playwright,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      server.origin,
    );
    let client: Browser | undefined;
    const rows: object[] = [];
    const host = new ProbeHost(backend.endpoint);
    let heldIsolation = 0;
    try {
      client = await playwright.chromium.launch({
        headless: true,
        channel: "chromium",
      });
      for (const mode of [
        "direct-unscoped",
        "direct-scoped",
        "adjacent-scoped",
        "direct-concurrent",
        "adjacent-concurrent",
      ]) {
        const adjacent = mode.startsWith("adjacent");
        const viewers: Viewer[] = [];
        try {
          for (
            let index = 0;
            index < (mode.endsWith("concurrent") ? 2 : 1);
            index++
          ) {
            const created = backend.context.waitForEvent("page");
            const { targetId } = await backend.session.send(
              "Target.createTarget",
              {
                url: "about:blank",
                newWindow: true,
              },
            );
            const remote = await created;
            await remote.goto(server.origin + "/fixture/editor");
            const { windowId } = await backend.session.send(
              "Browser.getWindowForTarget",
              { targetId },
            );
            const context = await client.newContext({
              viewport: { width: 1440, height: 1000 },
            });
            const timers = new Set<ReturnType<typeof setTimeout>>();
            const commands: Command[] = [];
            const acknowledgements: number[] = [];
            const pending = new Map<number, Command>();
            let closed = false;
            const transit = (action: () => void) => {
              const timer = setTimeout(() => {
                timers.delete(timer);
                if (!closed) action();
              }, oneWayMs);
              timers.add(timer);
            };
            await context.routeWebSocket(backend.endpoint, (socket) => {
              const upstream = socket.connectToServer();
              socket.onMessage((message) => {
                const command = JSON.parse(String(message)) as {
                  id: number;
                  method: string;
                  params?: object;
                };
                const row: Command = {
                  method: command.method,
                  sent: Date.now(),
                };
                if (command.method === "Page.startScreencast" && command.params)
                  row.capture = command.params;
                commands.push(row);
                pending.set(command.id, row);
                transit(() => upstream.send(message));
              });
              upstream.onMessage((message) =>
                transit(() => {
                  const response = JSON.parse(String(message)) as {
                    id?: number;
                  };
                  const row =
                    response.id === undefined
                      ? undefined
                      : pending.get(response.id);
                  if (row) {
                    pending.delete(response.id!);
                    row.response = Date.now();
                    if (
                      ["Input.dispatchKeyEvent", "Input.insertText"].includes(
                        row.method,
                      )
                    )
                      acknowledgements.push(row.response);
                  }
                  socket.send(message);
                }),
              );
              socket.onClose((code, reason) =>
                transit(() => {
                  void upstream.close({
                    ...(code === undefined ? {} : { code }),
                    ...(reason === undefined ? {} : { reason }),
                  });
                }),
              );
              upstream.onClose((code, reason) =>
                transit(() => {
                  void socket.close({
                    ...(code === undefined ? {} : { code }),
                    ...(reason === undefined ? {} : { reason }),
                  });
                }),
              );
            });
            await context.addInitScript(() => {
              window.inputProbe = {
                keys: [],
                text: [],
                intents: [],
                paint: null,
                token: 0,
              };
              document.addEventListener(
                "keydown",
                (event) => {
                  if (event.key === "Backspace") {
                    window.inputProbe.keys.push(Date.now());
                    window.inputProbe.intents.push(Date.now());
                  }
                },
                true,
              );
              document.addEventListener(
                "keyup",
                (event) => {
                  if (event.key === "Backspace")
                    window.inputProbe.intents.push(Date.now());
                },
                true,
              );
              document.addEventListener(
                "input",
                (event) => {
                  const name = (event.target as HTMLElement).getAttribute(
                    "aria-label",
                  );
                  if (
                    [
                      "Remote browser input",
                      "Executor experiment input",
                    ].includes(name ?? "")
                  ) {
                    window.inputProbe.text.push(Date.now());
                    window.inputProbe.intents.push(Date.now());
                  }
                },
                true,
              );
            });
            const page = await context.newPage();
            let probe: GuardedProbe | undefined;
            if (adjacent) {
              const endpoint = `wss://executor.fixture.invalid/viewer-${index}`;
              let sendReply: ((message: string) => void) | undefined;
              probe = await host.admit({
                targetId,
                windowId,
                reply: (value) =>
                  transit(() => sendReply?.(JSON.stringify(value))),
              });
              await context.routeWebSocket(endpoint, (socket) => {
                sendReply = (message) => socket.send(message);
                socket.onMessage((message) =>
                  transit(() => {
                    probe!.receive(String(message));
                  }),
                );
                socket.onClose(() =>
                  transit(() => {
                    void host.retire(probe!);
                  }),
                );
              });
            }
            viewers.push({
              page,
              context,
              remote,
              probe,
              commands,
              acknowledgements,
              close: async () => {
                closed = true;
                for (const timer of timers) clearTimeout(timer);
                if (probe) await host.retire(probe);
                await context.close();
                await remote.close();
              },
            });
            await page.goto(server.origin);
            await page.waitForFunction(
              () => typeof window.configureViewers === "function",
            );
            await page.evaluate(
              (settings) => window.configureViewers!(settings),
              {
                cdpUrl: backend.endpoint,
                interactive: !adjacent,
                second: false,
                ...(mode === "direct-unscoped" ? {} : { windowA: windowId }),
              },
            );
            const view = page.locator("#viewer-a .cdpv-root");
            if (mode === "direct-unscoped")
              await view.locator(`[data-target-id="${targetId}"]`).click();
            await expect(view).toHaveAttribute("data-status", "streaming");
            await remote.locator("#plain").focus();
            if (probe)
              await page.evaluate(installProbeClient, {
                endpoint: `wss://executor.fixture.invalid/viewer-${index}`,
                owner: probe.owner,
              });
            else
              await view
                .getByRole("textbox", { name: "Remote browser input" })
                .focus();
          }

          // Actual short-link holds are correctness evidence, outside all timings.
          if (mode === "adjacent-concurrent") {
            const [a, b] = viewers as [Viewer, Viewer];
            for (const boundary of [
              "Browser.getWindowForTarget",
              "Input.dispatchKeyEvent",
            ] as const) {
              await a.remote.locator("#plain").fill("a");
              await b.remote.locator("#plain").fill("");
              const hold = a.probe!.holdNext(boundary);
              await a.page.keyboard.press("Backspace");
              await hold.held;
              await b.page.keyboard.insertText("b");
              await expect(b.remote.locator("#plain")).toHaveValue("b");
              hold.release();
              await expect(a.remote.locator("#plain")).toHaveValue("");
              await Promise.all(
                viewers.map((viewer) =>
                  viewer.page.waitForFunction(
                    () =>
                      !window.probeStats.revoked &&
                      window.probeStats.sent.length ===
                        window.probeStats.acknowledged.length,
                  ),
                ),
              );
              heldIsolation++;
            }
          }

          for (const workload of ["backspace", "text"] as const) {
            const count = workload === "backspace" ? 5 : 12;
            for (let trial = 0; trial < 3; trial++) {
              const marks = await Promise.all(
                viewers.map(async (viewer) => {
                  await viewer.remote.evaluate(
                    ({ workload, count }) => {
                      const input =
                        document.querySelector<HTMLInputElement>("#plain")!;
                      input.value = workload === "backspace" ? "12345" : "";
                      input.focus();
                      input.setSelectionRange(
                        input.value.length,
                        input.value.length,
                      );
                      const events: { at: number; length: number }[] = [];
                      Object.assign(window, { remoteProbeEvents: events });
                      input.oninput = () => {
                        events.push({
                          at: Date.now(),
                          length: input.value.length,
                        });
                        const color =
                          events.length === count
                            ? "rgb(24,224,80)"
                            : "rgb(24,80,224)";
                        document.documentElement.style.background =
                          document.body.style.background = color;
                      };
                      document.documentElement.style.background =
                        document.body.style.background = "rgb(232,32,48)";
                    },
                    { workload, count },
                  );
                  await expect
                    .poll(() =>
                      viewer.page
                        .locator("#viewer-a canvas")
                        .evaluate((canvas: HTMLCanvasElement) => {
                          const pixel = canvas
                            .getContext("2d")!
                            .getImageData(0, 0, 1, 1).data;
                          return [232, 32, 48].every(
                            (value, index) =>
                              Math.abs(value - pixel[index]!) <= 4,
                          );
                        }),
                    )
                    .toBe(true);
                  await viewer.page.evaluate(() => {
                    const token = ++window.inputProbe.token;
                    window.inputProbe.keys = [];
                    window.inputProbe.text = [];
                    window.inputProbe.intents = [];
                    window.inputProbe.paint = null;
                    const deadline = Date.now() + 10_000;
                    const watch = () => {
                      if (window.inputProbe.token !== token) return;
                      const canvas =
                        document.querySelector<HTMLCanvasElement>(
                          "#viewer-a canvas",
                        )!;
                      const pixel = canvas
                        .getContext("2d")!
                        .getImageData(0, 0, 1, 1).data;
                      if (
                        [24, 224, 80].every(
                          (value, index) =>
                            Math.abs(value - pixel[index]!) <= 4,
                        )
                      ) {
                        window.inputProbe.paint = Date.now();
                        return;
                      }
                      if (Date.now() < deadline) requestAnimationFrame(watch);
                    };
                    requestAnimationFrame(watch);
                  });
                  if (viewer.probe) viewer.probe.peakOutstanding = 0;
                  return {
                    commands:
                      viewer.probe?.trace.length ?? viewer.commands.length,
                    acknowledgements: adjacent
                      ? await viewer.page.evaluate(
                          () => window.probeStats.acknowledged.length,
                        )
                      : viewer.acknowledgements.length,
                  };
                }),
              );
              for (let stroke = 0; stroke < count; stroke++) {
                await Promise.all(
                  viewers.map((viewer) =>
                    workload === "backspace"
                      ? viewer.page.keyboard.press("Backspace")
                      : viewer.page.keyboard.insertText("x"),
                  ),
                );
                await Promise.all(
                  viewers.map((viewer) =>
                    viewer.page.evaluate(
                      () => new Promise(requestAnimationFrame),
                    ),
                  ),
                );
              }
              await Promise.all(
                viewers.map(async (viewer, index) => {
                  const mark = marks[index]!;
                  await expect(viewer.remote.locator("#plain")).toHaveValue(
                    workload === "backspace" ? "" : "x".repeat(count),
                  );
                  await viewer.page.waitForFunction(
                    () => window.inputProbe.paint !== null,
                  );
                  const expectedAcks =
                    workload === "backspace" ? count * 2 : count;
                  if (adjacent)
                    await viewer.page.waitForFunction(
                      ({ start, count }) =>
                        window.probeStats.acknowledged.length === start + count,
                      { start: mark.acknowledgements, count: expectedAcks },
                    );
                  else
                    await expect
                      .poll(
                        () =>
                          viewer.acknowledgements.length -
                          mark.acknowledgements,
                      )
                      .toBe(expectedAcks);
                  const local = await viewer.page.evaluate(
                    () => window.inputProbe,
                  );
                  const events = await viewer.remote.evaluate(
                    () =>
                      (
                        window as unknown as {
                          remoteProbeEvents: { at: number; length: number }[];
                        }
                      ).remoteProbeEvents,
                  );
                  const times =
                    workload === "backspace" ? local.keys : local.text;
                  expect(times).toHaveLength(count);
                  expect(events.map((event) => event.length)).toEqual(
                    Array.from({ length: count }, (_, i) =>
                      workload === "backspace" ? count - i - 1 : i + 1,
                    ),
                  );
                  const acks = adjacent
                    ? await viewer.page.evaluate(
                        (start) => window.probeStats.acknowledged.slice(start),
                        mark.acknowledgements,
                      )
                    : viewer.acknowledgements.slice(mark.acknowledgements);
                  const commands = (
                    viewer.probe?.trace ?? viewer.commands
                  ).slice(mark.commands);
                  const capture = viewer.commands.find(
                    (command) => command.capture,
                  )?.capture;
                  expect(capture).toEqual({
                    format: "jpeg",
                    quality: 70,
                    maxWidth: 1920,
                    maxHeight: 1080,
                  });
                  let outstanding = 0;
                  let peak = 0;
                  const timeline = [
                    ...local.intents.map((at) => ({ at, delta: 1 })),
                    ...acks.map((at) => ({ at, delta: -1 })),
                  ].sort((a, b) => a.at - b.at || b.delta - a.delta);
                  for (const event of timeline) {
                    outstanding += event.delta;
                    peak = Math.max(peak, outstanding);
                  }
                  expect(outstanding).toBe(0);
                  const row = {
                    mode,
                    oneWayMs,
                    workload,
                    trial,
                    viewer: index,
                    remoteDomMs: events.map((event, i) => event.at - times[i]!),
                    lastInputToCanvasMs: local.paint! - times.at(-1)!,
                    firstInputToAllAcksMs: Math.max(...acks) - times[0]!,
                    peakUnacknowledgedIntents: peak,
                    executorPeakOutstanding:
                      viewer.probe?.peakOutstanding ?? null,
                    membershipLookups: commands.filter(
                      (command) =>
                        command.method === "Browser.getWindowForTarget",
                    ).length,
                    inputDispatches: commands.filter((command) =>
                      ["Input.dispatchKeyEvent", "Input.insertText"].includes(
                        command.method,
                      ),
                    ).length,
                    capture,
                  };
                  rows.push(row);
                  console.log(JSON.stringify(row));
                }),
              );
            }
          }
        } finally {
          for (const viewer of viewers) await viewer.close();
        }
      }
      await writeFile(
        info.outputPath("measurements.json"),
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
            browser: client.version(),
            oneWayMs,
            heldBoundaryIsolationChecks: heldIsolation,
            scope:
              "Owned Chromium, three trials per mode/workload, shared host clock, default capture. Public direct NativeInput versus minimal fixture keys/text adapter and actual adjacent InputSession. Concurrent cases use separate client pages, one browser URL, different windows. No full interaction, handover, production/provider/OS or tail-latency claim. Direct membership counts include independent discovery lookups.",
            rows,
          },
          null,
          2,
        ),
      );
    } finally {
      host.close();
      try {
        await client?.close();
      } finally {
        await backend.close();
      }
    }
  });
}
