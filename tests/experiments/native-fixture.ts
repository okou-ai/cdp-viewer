import { expect } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { prepareConsumer } from "../../scripts/consumer.mjs";
import { launchBackend, serveConsumer } from "../browser/backend";
import { ProbeHost } from "./probe-host";
import { assertExperimentSource } from "./assert-source";
import type { GuardedProbe } from "./guarded-probe";
import type { InputStop } from "../../src/input/lifecycle";
import type {} from "./native-client";
import type {} from "../consumer/api";

/** Actual DOM adapter and immutable consumer, owned by one experiment suite. */
export async function createNativeFixture() {
  assertExperimentSource();
  const consumer = await prepareConsumer();
  let server: Awaited<ReturnType<typeof serveConsumer>> | undefined;
  try {
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
    const entry = bundle.output.find((item) => item.type === "chunk");
    if (!entry) throw new Error("Native fixture entry is missing");
    server = await serveConsumer(consumer.dist);
    return {
      consumer,
      server,
      viewer: viewer.bind(null, {
        origin: server.origin,
        clientCode: entry.code,
      }),
      close: async () => {
        try {
          await server?.close();
        } finally {
          await consumer.cleanup();
        }
      },
    };
  } catch (error) {
    try {
      await server?.close();
    } finally {
      await consumer.cleanup();
    }
    throw error;
  }
}

type Backend = Awaited<ReturnType<typeof launchBackend>>;
export interface Viewer {
  page: Page;
  remote: Page;
  probe?: GuardedProbe;
  targetId: string;
  windowId: number;
  captures: object[];
  commands: string[];
  stream: {
    frames: { at: number; captured: number }[];
    acknowledgements: number;
  };
  latestFrame: () => string;
  marker: { x: number; y: number; scroll: number };
  holdMessage: (
    direction: "intent" | "reply",
    kind: "blur" | "ack" | "selection" | "clipboard-reset",
  ) => { held: Promise<void>; release: () => void };
  disconnect: () => void;
  retired: Promise<boolean>;
  retire: (reason?: Exclude<InputStop, "disconnected">) => Promise<boolean>;
  close: () => Promise<void>;
}

async function viewer(
  runtime: { origin: string; clientCode: string },
  browser: Browser,
  backend: Backend,
  host: ProbeHost,
  adjacent: boolean,
  oneWayMs = 0,
  options: {
    composition?: boolean;
    nativeFrames?: boolean;
    origin?: string;
    beforeInput?: (page: Page) => Promise<void>;
    existing?: Pick<Viewer, "remote" | "targetId" | "windowId" | "marker">;
  } = {},
): Promise<Viewer> {
  const {
    composition = false,
    nativeFrames = false,
    origin = runtime.origin,
  } = options;
  const existing = options.existing;
  const created = existing ? undefined : backend.context.waitForEvent("page");
  const targetId =
    existing?.targetId ??
    (
      await backend.session.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      })
    ).targetId;
  const remote = existing?.remote ?? (await created!);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const captures: object[] = [];
  const commands: string[] = [];
  const stream = {
    frames: [] as { at: number; captured: number }[],
    acknowledgements: 0,
  };
  let latestFrame = "";
  let closed = false;
  let probe: GuardedProbe | undefined;
  let disconnect: () => void = () => {
    throw new Error("Native channel is not connected");
  };
  let finished!: (confirmed: boolean) => void;
  const retired = new Promise<boolean>((resolve) => {
    finished = resolve;
  });
  let retirement: Promise<boolean> | undefined;
  const retire = (reason: Exclude<InputStop, "disconnected"> = "disposed") => {
    retirement ??= (
      probe ? host.retire(probe, reason) : Promise.resolve(true)
    ).then((confirmed) => {
      finished(confirmed);
      return confirmed;
    });
    return retirement;
  };
  const holds = new Map<string, { held: () => void; run?: () => void }>();
  const deliver = (
    direction: "intent" | "reply",
    kind: string,
    run: () => void,
  ) => {
    const key = direction + ":" + kind;
    const hold = holds.get(key);
    if (!hold) run();
    else {
      holds.delete(key);
      hold.run = run;
      hold.held();
    }
  };
  const transit = (run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closed) run();
    }, oneWayMs);
    timers.add(timer);
  };
  try {
    if (!existing) {
      await remote.goto(origin + "/fixture/editor?native=" + targetId);
      await remote.evaluate(() => {
        const marker = document.createElement("div");
        marker.id = "native-marker";
        marker.style.cssText =
          "position:absolute;left:900px;top:350px;width:48px;height:48px;background:rgb(232,32,48);pointer-events:none";
        document.body.append(marker);
        const observed = {
          effect: 0,
          color: "rgb(24,224,80)",
          events: [] as string[],
        };
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
                if (type === "input") marker.style.background = observed.color;
              }
            },
            true,
          );
      });
    }
    const marker =
      existing?.marker ??
      (await remote.evaluate(() => {
        const rect = document
          .querySelector("#native-marker")!
          .getBoundingClientRect();
        return {
          x: (rect.left + rect.width / 2) / innerWidth,
          y: (rect.top + rect.height / 2) / innerHeight,
          scroll: 300 / innerHeight,
        };
      }));
    const { windowId } = await backend.session.send(
      "Browser.getWindowForTarget",
      { targetId },
    );
    if (existing && windowId !== existing.windowId)
      throw new Error("Owned target destination changed before admission");
    if (!nativeFrames)
      await context.routeWebSocket(backend.endpoint, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const command = JSON.parse(String(message)) as {
            method: string;
            params?: object;
          };
          commands.push(command.method);
          if (command.method === "Page.screencastFrameAck")
            stream.acknowledgements++;
          if (command.method === "Page.startScreencast" && command.params)
            captures.push(command.params);
          transit(() => upstream.send(message));
        });
        upstream.onMessage((message) =>
          transit(() => {
            const event = JSON.parse(String(message)) as {
              method?: string;
              params?: { data?: string; metadata?: { timestamp?: number } };
            };
            if (event.method === "Page.screencastFrame") {
              latestFrame = event.params?.data ?? "";
              stream.frames.push({
                at: Date.now(),
                captured: (event.params?.metadata?.timestamp ?? 0) * 1000,
              });
              if (stream.frames.length > 128) stream.frames.shift();
            }
            socket.send(message);
          }),
        );
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
        mode: composition ? "composition" : "native",
        reply: (value) =>
          deliver("reply", value.type, () =>
            transit(() => reply?.(JSON.stringify(value))),
          ),
      });
      const admitted = probe;
      await context.routeWebSocket(endpoint, (socket) => {
        reply = (data) => socket.send(data);
        disconnect = () => {
          void socket.close();
        };
        socket.onMessage((data) => {
          const value = JSON.parse(String(data)) as { kind: string };
          deliver("intent", value.kind, () =>
            transit(() => {
              admitted.receive(String(data));
            }),
          );
        });
        socket.onClose(() => {
          reply = undefined;
          void retire();
        });
      });
    }
    const page = await context.newPage();
    await page.goto(origin);
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
    const selected = page.locator(
      `#viewer-a [role="tab"][data-target-id="${targetId}"]`,
    );
    if (existing) await selected.click();
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#viewer-a .cdpv-root")).toHaveAttribute(
      "data-status",
      "streaming",
    );
    if (probe) {
      if (composition)
        await expect.poll(() => probe!.navigation).not.toBeNull();
      await options.beforeInput?.(page);
      await page.addScriptTag({ content: runtime.clientCode });
      await page.evaluate(
        (settings) => window.installNativeExperiment(settings),
        {
          endpoint,
          owner: probe.owner,
          ...(composition ? { ownership: probe.ownership } : {}),
          navigation: probe.navigation,
        },
      );
    }
    return {
      page,
      remote,
      targetId,
      windowId,
      captures,
      commands,
      stream,
      latestFrame: () => latestFrame,
      marker,
      disconnect: () => disconnect(),
      retired,
      retire,
      holdMessage: (direction, kind) => {
        const key = direction + ":" + kind;
        if (holds.has(key)) throw new Error("Fixture message already held");
        let held!: () => void;
        const promise = new Promise<void>((resolve) => {
          held = resolve;
        });
        const hold: { held: () => void; run?: () => void } = { held };
        holds.set(key, hold);
        return {
          held: promise,
          release: () => {
            const run = hold.run;
            delete hold.run;
            if (!closed) run?.();
          },
        };
      },
      ...(probe ? { probe } : {}),
      close: async () => {
        closed = true;
        for (const timer of timers) clearTimeout(timer);
        try {
          if (probe) await retire();
        } finally {
          try {
            await context.close();
          } finally {
            if (!existing) await remote.close();
          }
        }
      },
    };
  } catch (error) {
    probe?.close();
    try {
      await context.close();
    } finally {
      if (!existing) await remote.close();
    }
    throw error;
  }
}

export async function position(
  value: Viewer,
  selector: string,
  fractionX = 0.5,
) {
  const box = await value.remote.evaluate((selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : null;
  }, selector);
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
    {
      x: box.x + box.width * fractionX,
      y: box.y + box.height / 2,
      ...viewport,
    },
  );
}

export async function painted(
  value: Viewer,
  expected: boolean | number[],
  point = value.marker,
) {
  const color = Array.isArray(expected)
    ? expected
    : expected
      ? [24, 224, 80]
      : [232, 32, 48];
  try {
    await expect
      .poll(() =>
        value.page.locator("#viewer-a canvas").evaluate(
          (canvas: HTMLCanvasElement, { color, point }) => {
            const pixel = canvas
              .getContext("2d")!
              .getImageData(
                Math.floor(point.x * canvas.width),
                Math.floor(point.y * canvas.height),
                1,
                1,
              ).data;
            return color.every((n, i) => Math.abs(n - pixel[i]!) <= 4);
          },
          { color, point },
        ),
      )
      .toBe(true);
  } catch (error) {
    // Fixed synthetic diagnostics distinguish a stale stream from a marker error.
    const remote = await value.remote.evaluate(() => ({
      color: getComputedStyle(document.querySelector("#native-marker")!)
        .backgroundColor,
      scroll: scrollY,
      observed: (
        window as unknown as {
          nativeObserved: { effect: number; events: string[] };
        }
      ).nativeObserved,
    }));
    const client = await value.page.locator("#viewer-a canvas").evaluate(
      (canvas: HTMLCanvasElement, point) => ({
        width: canvas.width,
        height: canvas.height,
        pixel: [
          ...canvas
            .getContext("2d")!
            .getImageData(
              Math.floor(point.x * canvas.width),
              Math.floor(point.y * canvas.height),
              1,
              1,
            ).data,
        ],
        status: canvas.closest(".cdpv-root")?.getAttribute("data-status"),
        visibility: document.visibilityState,
        timing:
          (window as unknown as { nativeTiming?: object }).nativeTiming ?? null,
      }),
      point,
    );
    const encodedPixel = await value.page.evaluate(
      async ({ data, point }) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(
          new Blob([bytes], { type: "image/jpeg" }),
        );
        try {
          const image = document.createElement("canvas");
          image.width = bitmap.width;
          image.height = bitmap.height;
          image.getContext("2d")!.drawImage(bitmap, 0, 0);
          return [
            ...image
              .getContext("2d")!
              .getImageData(
                Math.floor(point.x * image.width),
                Math.floor(point.y * image.height),
                1,
                1,
              ).data,
          ];
        } finally {
          bitmap.close();
        }
      },
      { data: value.latestFrame(), point },
    );
    console.log(
      JSON.stringify({
        markerFailure: true,
        expected: color,
        point,
        remote,
        client,
        encodedPixel,
        stream: { ...value.stream, frames: value.stream.frames.slice(-8) },
      }),
    );
    throw error;
  }
}

export async function drained(value: Viewer) {
  if (value.probe)
    await value.page.waitForFunction(
      () =>
        !window.nativeExperiment.stats.revoked &&
        window.nativeExperiment.stats.acknowledgements.length ===
          window.nativeExperiment.stats.batches,
    );
}

export async function composing(value: Viewer, text: string) {
  await value.page
    .getByRole("textbox", { name: "Native executor input" })
    .evaluate((element: HTMLTextAreaElement, text) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
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
}

export async function committed(value: Viewer, text: string) {
  await value.page
    .getByRole("textbox", { name: "Native executor input" })
    .evaluate((element: HTMLTextAreaElement, text) => {
      element.value = text;
      element.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: text }),
      );
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromComposition",
          data: text,
        }),
      );
    }, text);
}

export async function resumed(value: Viewer) {
  await value.page.waitForFunction(
    () =>
      window.nativeExperiment.stats.ready &&
      !window.nativeExperiment.stats.revoked,
  );
}

export async function observeClipboard(page: Page, gate = false) {
  await page.evaluate((gate) => {
    const field = document.createElement("textarea");
    field.setAttribute("aria-label", "Owned local clipboard field");
    document.body.append(field);
    const observed = {
      writes: 0,
      gesture: false,
      settled: 0,
      completedAt: 0,
      held: false,
      release: () => {},
    };
    Object.assign(window, { nativeClipboardProbe: observed });
    const write = Clipboard.prototype.write.bind(navigator.clipboard);
    Clipboard.prototype.write = (items) => {
      observed.writes++;
      observed.gesture = navigator.userActivation.isActive;
      const result = write(items);
      result.then(
        () => {
          observed.completedAt = Date.now();
          observed.settled++;
        },
        () => {
          observed.completedAt = Date.now();
          observed.settled++;
        },
      );
      return result;
    };
    if (!gate) return;
    // Only the external fixture socket is gated. Frames use native CDP so
    // Playwright's forwarding evaluations cannot keep activation alive.
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        let armed = true;
        this.addEventListener("message", (event: MessageEvent<string>) => {
          const value = JSON.parse(event.data) as { type?: string };
          if (!armed || value.type !== "selection") return;
          armed = false;
          event.stopImmediatePropagation();
          observed.held = true;
          const data = event.data;
          observed.release = () => {
            observed.release = () => {};
            this.dispatchEvent(new MessageEvent("message", { data }));
          };
        });
      }
    };
  }, gate);
}

export async function seedClipboard(value: Viewer, text: string) {
  const field = value.page.getByRole("textbox", {
    name: "Owned local clipboard field",
  });
  await field.fill(text);
  await field.press("ControlOrMeta+a");
  await field.press("ControlOrMeta+c");
}

export async function localClipboard(value: Viewer) {
  const field = value.page.getByRole("textbox", {
    name: "Owned local clipboard field",
  });
  await field.fill("");
  await field.press("ControlOrMeta+v");
  return field.inputValue();
}

export async function copySelection(value: Viewer) {
  const before = await value.page.evaluate(
    () =>
      (window as unknown as { nativeClipboardProbe: { settled: number } })
        .nativeClipboardProbe.settled,
  );
  const proxy = value.page.getByRole("textbox", {
    name: "Native executor input",
  });
  await proxy.focus();
  await proxy.press("ControlOrMeta+c");
  await value.page.waitForFunction(
    (before) =>
      (window as unknown as { nativeClipboardProbe: { settled: number } })
        .nativeClipboardProbe.settled ===
      before + 1,
    before,
  );
}
