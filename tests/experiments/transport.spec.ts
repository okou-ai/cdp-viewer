import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { launchNativeBackend, serveBrowserConsumer } from "../browser/backend";
import { TransportLink } from "./transport-link";
import type {} from "../consumer/api";

interface Sample {
  transport: "shared" | "split";
  order: number;
  workload: "text" | "composition" | "burst";
  warmup: boolean;
  canvasMs: number;
  remoteMs: number;
}

function fixture(dashboard: boolean) {
  const rows = Array.from({ length: 22 }, (_, i) =>
    dashboard
      ? `<tr><td>Account ${i + 1}</td><td>Active</td><td>$${(i + 1) * 1250}</td><td>Review next Friday</td></tr>`
      : `${i + 1}. Account ${i + 1}: review onboarding, delivery milestones and next meeting.\n`,
  ).join("");
  return `<!doctype html><html><head><title>Owned transport fixture</title><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white;color:#182536;font:24px Arial}
  main{padding:64px 48px}h1{font-size:34px}pre{font:24px/1.5 monospace}input{font:24px Arial;width:1100px;height:44px;padding:8px}
  table{width:1600px;border-collapse:collapse}td{padding:8px;border:1px solid #ccc}
  #marker{position:fixed;left:0;top:0;width:48px;height:48px;background:rgb(16,32,64)}
  #pulse{position:fixed;right:0;top:0;width:40px;height:40px}</style></head><body><div id="marker"></div><div id="pulse"></div>
  <main><input id="edit" aria-label="Synthetic notes"><h1>${dashboard ? "Revenue overview" : "Quarterly operating plan"}</h1>
  <p>Owners, delivery dates and customer follow-up</p>${dashboard ? `<table>${rows}</table>` : `<pre>${rows}</pre>`}</main>
  <script>window.transportEffects={id:0,at:0};document.querySelector('#edit').addEventListener('input',e=>{
  const m=e.target.value.match(/#(\\d+)!$/);if(!m)return;const id=Number(m[1]);
  window.transportEffects={id,at:Date.now()};document.querySelector('#marker').style.background='rgb('+[20+id%6*40,20+Math.floor(id/6)%6*40,20+Math.floor(id/36)%6*40].join(',')+')';
  });let pulse=0;setInterval(()=>document.querySelector('#pulse').style.background=pulse++%2?'#f7f9fc':'#b8d6f2',200);document.querySelector('#edit').focus();</script></body></html>`;
}

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => server?.close());

for (const dashboard of [false, true])
  for (const shaped of [false, true]) {
    test(`${dashboard ? "dashboard" : "editor"}, ${shaped ? "aggregate shaped" : "natural"}`, async ({
      browser,
    }, info) => {
      const samples: Sample[] = [];
      const rows: object[] = [];
      const source = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const diffSha256 = createHash("sha256")
        .update(execFileSync("git", ["diff", "HEAD"]))
        .digest("hex");
      const consumer = JSON.parse(
        await readFile("test-results/package/receipt.json", "utf8"),
      ) as { source: string; specifier: string };
      if (consumer.source === "github") {
        expect(consumer.specifier.endsWith("#" + source)).toBe(true);
        execFileSync("git", ["diff", "--exit-code", "HEAD"]);
      }
      const backend = await launchNativeBackend(server.origin, true, 1);
      let id = 0;
      try {
        const created = backend.context.waitForEvent("page");
        const { targetId } = await backend.session.send("Target.createTarget", {
          url: "about:blank",
          newWindow: true,
        });
        const remote = await created;
        const { windowId } = await backend.session.send(
          "Browser.getWindowForTarget",
          { targetId },
        );
        await backend.session.send("Browser.setContentsSize", {
          windowId,
          width: 1920,
          height: 1080,
        });
        await remote.setContent(fixture(dashboard));
        for (const [order, modes] of [
          ["shared", "split"],
          ["split", "shared"],
        ].entries()) {
          for (const transport of modes as ("shared" | "split")[]) {
            const context = await browser.newContext({
              viewport: { width: 1440, height: 1000 },
              deviceScaleFactor: 1,
            });
            const link = new TransportLink(shaped);
            const lanes: {
              methods: string[];
              frames: number;
              bytes: number[];
            }[] = [];
            const captures: unknown[] = [];
            try {
              await context.routeWebSocket(backend.endpoint, (socket) => {
                const lane = {
                  methods: [] as string[],
                  frames: 0,
                  bytes: [] as number[],
                };
                lanes.push(lane);
                const upstream = socket.connectToServer();
                socket.onMessage((raw) => {
                  const command = JSON.parse(String(raw)) as {
                    method: string;
                    params?: unknown;
                  };
                  lane.methods.push(command.method);
                  if (command.method === "Page.startScreencast")
                    captures.push(command.params);
                  link.uplink(() => upstream.send(raw));
                });
                upstream.onMessage((raw) => {
                  const response = JSON.parse(String(raw)) as {
                    method?: string;
                    params?: { data?: string };
                  };
                  if (response.method === "Page.screencastFrame") {
                    lane.frames++;
                    lane.bytes.push(
                      Buffer.byteLength(response.params!.data!, "base64"),
                    );
                  }
                  link.downlink(socket, Buffer.byteLength(raw), () =>
                    socket.send(raw),
                  );
                });
              });
              const page = await context.newPage();
              await page.goto(server.origin);
              await page.waitForFunction(
                () => typeof window.configureViewers === "function",
              );
              await page.evaluate(
                (settings) => window.configureViewers!(settings),
                {
                  cdpUrl: backend.endpoint,
                  windowA: windowId,
                  second: false,
                  interactive: true,
                  transport,
                },
              );
              const view = page.locator("#viewer-a .cdpv-root");
              await expect(view).toHaveAttribute("data-status", "streaming");
              const geometry = await remote.evaluate(() => ({
                width: innerWidth,
                height: innerHeight,
                dpr: devicePixelRatio,
              }));
              expect(geometry).toEqual({ width: 1920, height: 1080, dpr: 1 });
              await expect
                .poll(() =>
                  view
                    .locator("canvas")
                    .evaluate((c: HTMLCanvasElement) => [c.width, c.height]),
                )
                .toEqual([1920, 1080]);
              const proxy = view.getByLabel("Remote browser input");
              await remote.locator("#edit").focus();
              await proxy.focus();
              for (const workload of [
                "text",
                "composition",
                "burst",
              ] as const) {
                const count = workload === "burst" ? 4 : 8;
                for (let trial = -1; trial < count; trial++) {
                  const sample = ++id;
                  const began = await proxy.evaluate(
                    async (element: HTMLTextAreaElement, value) => {
                      const started = Date.now();
                      const append = (text: string) => {
                        element.value += text;
                        element.dispatchEvent(
                          new InputEvent("input", {
                            bubbles: true,
                            inputType: "insertText",
                            data: text,
                          }),
                        );
                      };
                      if (value.workload === "composition") {
                        element.dispatchEvent(
                          new CompositionEvent("compositionstart", {
                            bubbles: true,
                          }),
                        );
                        element.dispatchEvent(
                          new CompositionEvent("compositionupdate", {
                            bubbles: true,
                            data: "ni",
                          }),
                        );
                        await new Promise<void>((resolve) =>
                          requestAnimationFrame(() => resolve()),
                        );
                        element.dispatchEvent(
                          new CompositionEvent("compositionend", {
                            bubbles: true,
                            data: `你#${value.sample}!`,
                          }),
                        );
                      } else {
                        if (value.workload === "burst")
                          for (let i = 0; i < 12; i++) {
                            append("x");
                            await new Promise<void>((resolve) =>
                              requestAnimationFrame(() => resolve()),
                            );
                          }
                        append(`#${value.sample}!`);
                      }
                      return started;
                    },
                    { workload, sample },
                  );
                  const painted = await view
                    .locator("canvas")
                    .evaluate(async (canvas: HTMLCanvasElement, value) => {
                      const wanted = [
                        20 + (value % 6) * 40,
                        20 + (Math.floor(value / 6) % 6) * 40,
                        20 + (Math.floor(value / 36) % 6) * 40,
                      ];
                      const deadline = performance.now() + 10_000;
                      while (performance.now() < deadline) {
                        const pixel = canvas
                          .getContext("2d")!
                          .getImageData(10, 10, 1, 1).data;
                        if (
                          wanted.every(
                            (channel, i) => Math.abs(channel - pixel[i]!) <= 8,
                          )
                        )
                          return Date.now();
                        await new Promise<void>((resolve) =>
                          requestAnimationFrame(() => resolve()),
                        );
                      }
                      throw new Error(
                        "Expected owned input pixel did not paint.",
                      );
                    }, sample);
                  const effect = await remote.evaluate(
                    () =>
                      (
                        window as unknown as {
                          transportEffects: { id: number; at: number };
                        }
                      ).transportEffects,
                  );
                  expect(effect.id).toBe(sample);
                  samples.push({
                    transport,
                    order,
                    workload,
                    warmup: trial < 0,
                    canvasMs: painted - began,
                    remoteMs: effect.at - began,
                  });
                }
              }
              expect(captures).toEqual([
                {
                  format: "jpeg",
                  quality: 70,
                  maxWidth: 1920,
                  maxHeight: 1080,
                },
              ]);
              const active = lanes.filter((lane) =>
                lane.methods.includes("Target.attachToTarget"),
              );
              expect(active).toHaveLength(transport === "split" ? 2 : 1);
              const control = active.find((lane) =>
                lane.methods.includes("Page.enable"),
              )!;
              if (transport === "split") expect(control.frames).toBe(0);
              expect(
                await remote.evaluate(() => ({
                  width: innerWidth,
                  height: innerHeight,
                  dpr: devicePixelRatio,
                })),
              ).toEqual(geometry);
              rows.push({
                transport,
                order,
                geometry,
                capture: captures[0],
                controlFrames: control.frames,
                frameBytes: lanes.flatMap((lane) => lane.bytes),
              });
            } finally {
              // Closing the client releases native sessions before the next matched row.
              link.close();
              await context.close();
            }
          }
        }
      } finally {
        await backend.close();
        await writeFile(
          info.outputPath("transport.json"),
          JSON.stringify(
            {
              source,
              diffSha256,
              consumer,
              dashboard,
              shaped,
              model:
                "One aggregate 1 MiB/s downstream budget, per-socket FIFO/fair 16 KiB chunks, 50ms extra each direction; natural has neither bandwidth limit nor added propagation. Browser-route shaping is a model, not provider/TCP fairness. Native DOM adapter to actual canvas, physical OS IME/display excluded.",
              rows,
              samples,
              cleanup:
                "owned backend closed; per-row contexts and link timers closed in finally",
            },
            null,
            2,
          ),
        );
      }
    });
  }
