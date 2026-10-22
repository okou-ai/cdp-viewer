import { expect, test } from "@playwright/test";
import type { TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { launchBackend } from "../browser/backend";
import { ProbeHost } from "./probe-host";
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
import type { Page } from "@playwright/test";

declare global {
  interface Window {
    recoveryReply: { armed: boolean; seen: boolean; release: () => void };
  }
}

test.use({ channel: "chromium" });
let fixture: Awaited<ReturnType<typeof createNativeFixture>>;
let markerVersion = 0;
test.beforeAll(async () => {
  fixture = await createNativeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function eventCount(value: Viewer, type: string) {
  return value.remote.evaluate(
    (type) =>
      (
        window as unknown as { nativeObserved: { events: string[] } }
      ).nativeObserved.events.filter((event) => event === type).length,
    type,
  );
}

async function editAndPaint(value: Viewer, text: string, click = true) {
  // HTTP 204 retains this execution context without a navigation commit.
  // Reset only the owned fixture directly, then observe actual native effects.
  await value.remote.evaluate(() => {
    document.querySelector<HTMLInputElement>("#plain")!.value = "";
  });
  // Each actual input effect gets a distinct color. Intermediate reset frames
  // may coalesce; an old painted frame cannot satisfy this new observation.
  const version = ++markerVersion;
  const color = [
    32 + ((version * 37) % 160),
    64 + ((version * 53) % 160),
    48 + ((version * 71) % 160),
  ];
  await value.remote.evaluate((color) => {
    (
      window as unknown as { nativeObserved: { color: string } }
    ).nativeObserved.color = `rgb(${color.join(",")})`;
  }, color);
  if (click) {
    const at = await position(value, "#plain");
    await value.page.mouse.click(at.x, at.y);
  } else
    await value.page
      .getByRole("textbox", { name: "Native executor input" })
      .focus();
  await value.page.keyboard.insertText(text);
  await expect
    .poll(() =>
      value.remote.evaluate(
        () => document.querySelector<HTMLInputElement>("#plain")!.value,
      ),
    )
    .toBe(text);
  await drained(value);
  await painted(value, color);
}

async function fullInteractions(value: Viewer) {
  await editAndPaint(value, "owned");
  await composing(value, "ni");
  await expect(value.remote.locator("#plain")).toHaveValue("ownedni");
  await committed(value, "你");
  await expect(value.remote.locator("#plain")).toHaveValue("owned你");
  await drained(value);
  const before = value.probe!.generation;
  await value.page
    .getByRole("textbox", { name: "Executor address" })
    .fill(value.remote.url() + "#recovery");
  await resumed(value);
  await value.page
    .getByRole("button", { name: "Executor navigate", exact: true })
    .click();
  await expect(value.remote).toHaveURL(/#recovery$/);
  await resumed(value);
  expect(value.probe!.generation).not.toBe(before);
  await seedClipboard(value, "previous local value");
  await resumed(value);
  await value.remote.locator("#plain").selectText();
  await copySelection(value);
  expect(await localClipboard(value)).toBe("owned你");
  await resumed(value);
  const at = await position(value, "#plain");
  await value.page.mouse.click(at.x, at.y);
  await drained(value);
}

async function acquire(value: Viewer) {
  // A held selection result may precede the copy chord's final key-up.
  // Observe its real completion before measuring the next acquisition.
  await drained(value);
  const baseline = {
    shift: await eventCount(value, "keyup:Shift"),
    control: await eventCount(value, "keyup:Control"),
    pointer: await eventCount(value, "mouseup"),
  };
  await value.page.keyboard.down("Shift");
  await value.page.keyboard.down("Control");
  const at = await position(value, "#plain");
  await value.page.mouse.move(at.x, at.y);
  await value.page.mouse.down();
  await drained(value);
  return baseline;
}

async function releases(
  value: Viewer,
  baseline: Awaited<ReturnType<typeof acquire>>,
  delta: number,
) {
  await expect
    .poll(() => eventCount(value, "keyup:Shift"))
    .toBe(baseline.shift + delta);
  await expect
    .poll(() => eventCount(value, "keyup:Control"))
    .toBe(baseline.control + delta);
  await expect
    .poll(() => eventCount(value, "mouseup"))
    .toBe(baseline.pointer + delta);
}

async function receipt(
  info: TestInfo,
  backend: Awaited<ReturnType<typeof launchBackend>>,
  viewers: Viewer[],
  proof: object,
) {
  const value = {
    case: info.title,
    checkout: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    source: process.env.CDP_VIEWER_SOURCE_SHA,
    cleanCheckout:
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim() === "",
    consumer: fixture.consumer.receipt,
    browser: await backend.session.send("Browser.getVersion"),
    capture: { format: "jpeg", quality: 70, maxWidth: 1920, maxHeight: 1080 },
    observedCaptures: viewers.flatMap((viewer) => viewer.captures),
    proof,
    limits: [
      "synthetic local composition; genuine OS IME unverified",
      "private fixture executor/transport; deployed service and provider recovery unverified",
      "membership check and native dispatch are not atomic against external moves",
    ],
  };
  expect(value.observedCaptures.length).toBeGreaterThan(0);
  for (const capture of value.observedCaptures)
    expect(capture).toMatchObject(value.capture);
  await writeFile(
    info.outputPath("recovery.json"),
    JSON.stringify(value, null, 2),
  );
}

async function clientReplyFault(
  page: Page,
  fault: "lost" | "rejected" | "partial",
) {
  await page.evaluate((fault) => {
    const state = { armed: false, seen: false, release: () => {} };
    window.recoveryReply = state;
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event: MessageEvent<string>) => {
          const reply = JSON.parse(event.data) as {
            type: string;
            ok?: boolean;
            sequence?: number;
          };
          if (!state.armed || reply.type !== "ack") return;
          state.armed = false;
          state.seen = true;
          event.stopImmediatePropagation();
          const original = event.data;
          state.release = () => {
            state.release = () => {};
            this.dispatchEvent(new MessageEvent("message", { data: original }));
          };
          if (fault === "lost") return;
          if (fault === "rejected") reply.ok = false;
          else delete reply.sequence;
          this.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify(reply) }),
          );
        });
      }
    };
  }, fault);
}

for (const fault of ["lost", "rejected", "partial"] as const) {
  test(`full native client ${fault} reply never replays a completed effect on reconnect`, async ({
    browser,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      fixture.server.origin,
    );
    const host = new ProbeHost(backend.endpoint);
    const viewers: Viewer[] = [];
    try {
      const a = await fixture.viewer(browser, backend, host, true, 0, {
        composition: true,
        beforeInput: async (page) => {
          await observeClipboard(page);
          await clientReplyFault(page, fault);
        },
      });
      viewers.push(a);
      const b = await fixture.viewer(browser, backend, host, true, 0, {
        composition: true,
      });
      viewers.push(b);
      await fullInteractions(a);
      await editAndPaint(b, "sibling before reply fault");
      const aKeys = await acquire(a);
      const bKeys = await acquire(b);
      await a.remote.evaluate(() => {
        document.querySelector<HTMLInputElement>("#plain")!.value = "";
      });
      const before = a.probe!.trace.filter(
        (row) => row.method === "Input.insertText",
      ).length;
      await a.page.evaluate(() => {
        window.recoveryReply.armed = true;
      });
      await a.page.keyboard.insertText("exactly once");
      await a.page.waitForFunction(() => window.recoveryReply.seen);
      await expect(a.remote.locator("#plain")).toHaveValue("exactly once");
      if (fault === "lost") {
        await a.page
          .getByRole("textbox", { name: "Native executor input" })
          .evaluate((element: HTMLTextAreaElement) => {
            element.value = "discarded unsent";
            element.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                inputType: "insertText",
                data: "discarded unsent",
              }),
            );
            window.nativeExperiment.close();
          });
      }
      await a.page.waitForFunction(() => window.nativeExperiment.stats.revoked);
      expect(await a.retired).toBe(true);
      expect(
        a.probe!.trace.filter((row) => row.method === "Input.insertText"),
      ).toHaveLength(before + 1);
      await releases(a, aKeys, 1);
      await editAndPaint(b, "sibling after reply fault", false);
      await releases(b, bKeys, 0);
      const replacement = await fixture.viewer(
        browser,
        backend,
        host,
        true,
        0,
        { composition: true, existing: a },
      );
      viewers.push(replacement);
      await expect(replacement.remote.locator("#plain")).toHaveValue(
        "exactly once",
      );
      expect(
        replacement.probe!.trace.filter(
          (row) => row.method === "Input.insertText",
        ),
      ).toHaveLength(0);
      await editAndPaint(replacement, "fresh after reconnect");
      const fresh = await acquire(replacement);
      await a.page.evaluate(() => window.recoveryReply.release());
      await releases(replacement, fresh, 0);
      await receipt(info, backend, viewers, {
        fault,
        nativeEffectOnce: true,
        unsentDiscarded: true,
        positiveRetirement: true,
        freshConnectionNoReplay: true,
      });
    } finally {
      try {
        for (const viewer of viewers.reverse()) await viewer.close();
      } finally {
        host.close();
        await backend.close();
      }
    }
  });
}

for (const loss of ["blur", "pause", "unmount", "viewer-channel"] as const) {
  test(`full native recovery keeps sibling acquisitions and pixels independent across A ${loss}`, async ({
    browser,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      fixture.server.origin,
    );
    const host = new ProbeHost(backend.endpoint);
    const viewers: Viewer[] = [];
    try {
      const a = await fixture.viewer(browser, backend, host, true, 0, {
        composition: true,
        beforeInput: observeClipboard,
      });
      viewers.push(a);
      const b = await fixture.viewer(browser, backend, host, true, 0, {
        composition: true,
      });
      viewers.push(b);
      expect(a.windowId).not.toBe(b.windowId);
      await fullInteractions(a);
      await editAndPaint(b, "before sibling hold");
      const aKeys = await acquire(a);
      const bKeys = await acquire(b);
      const old = a.probe!.generation;
      const held = a.probe!.holdNext("Input.imeSetComposition");
      await composing(a, "pending");
      await held.held;
      let retirement: Promise<boolean> | undefined;
      if (loss === "blur") {
        await a.page
          .getByRole("textbox", { name: "Native executor input" })
          .evaluate((element: HTMLTextAreaElement) => element.blur());
      } else if (loss === "pause") {
        await a.page.evaluate(
          (settings) => window.configureViewers!(settings),
          {
            cdpUrl: backend.endpoint,
            windowA: a.windowId,
            interactive: false,
            second: false,
            paused: true,
          },
        );
        await expect(a.page.locator(".cdpv-root")).toHaveAttribute(
          "data-status",
          "paused",
        );
        retirement = a.retire("paused");
        await a.page.evaluate(() => window.nativeExperiment.close());
      } else if (loss === "unmount") {
        await a.page.evaluate(() => {
          window.nativeExperiment.close();
          window.removeFirstViewer!();
        });
        retirement = a.retired;
      } else {
        a.disconnect();
        retirement = a.retired;
      }
      await releases(a, aKeys, 1);
      if (loss !== "blur")
        await expect(
          host.admit({
            targetId: a.targetId,
            windowId: a.windowId,
            mode: "composition",
            reply: () => {},
          }),
        ).rejects.toThrow("unsettled owner");
      expect(
        a.probe!.receive(
          JSON.stringify({
            kind: "batch",
            owner: a.probe!.owner,
            generation: old,
            sequence: 999,
            acknowledged: 0,
            actions: [{ kind: "text", text: "late old" }],
          }),
        ),
      ).toBe(false);
      await editAndPaint(b, "sibling while A is held", false);
      await releases(b, bKeys, 0);
      await a.page.keyboard.up("Control");
      await a.page.keyboard.up("Shift");
      await a.page.mouse.up();
      held.release();
      let replacement = a;
      if (retirement) {
        expect(await retirement).toBe(true);
        replacement = await fixture.viewer(browser, backend, host, true, 0, {
          composition: true,
          existing: a,
        });
        viewers.push(replacement);
        expect(replacement.probe!.owner).not.toBe(a.probe!.owner);
      } else {
        await resumed(a);
        expect(a.probe!.generation).not.toBe(old);
        await committed(a, "old trailing composition");
      }
      await editAndPaint(replacement, "fresh generation");
      const freshKeys = await acquire(replacement);
      held.release();
      if (replacement !== a) {
        a.probe!.close();
        expect(await host.retire(a.probe!)).toBe(false);
      }
      await releases(replacement, freshKeys, 0);
      await releases(b, bKeys, 0);
      await receipt(info, backend, viewers, {
        loss,
        bothModifiers: true,
        originalRelease: true,
        siblingPixels: true,
        positiveReadmissionOnly: true,
        staleGenerationRejected: true,
      });
    } finally {
      try {
        for (const viewer of viewers.reverse()) await viewer.close();
      } finally {
        host.close();
        await backend.close();
      }
    }
  });
}

async function moveTarget(
  backend: Awaited<ReturnType<typeof launchBackend>>,
  from: Viewer,
  to: Viewer,
) {
  const worker =
    backend.context.serviceWorkers()[0] ??
    (await backend.context.waitForEvent("serviceworker"));
  await worker.evaluate(
    async ({ fromUrl, destinationUrl }) => {
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
      const source = all.find((tab) => tab.url === fromUrl);
      const destination = all.find((tab) => tab.url === destinationUrl);
      if (!source || !destination)
        throw new Error("Owned move targets are missing");
      await tabs.move(source.id, { windowId: destination.windowId, index: -1 });
    },
    { fromUrl: from.remote.url(), destinationUrl: to.remote.url() },
  );
  await expect
    .poll(
      async () =>
        (
          await backend.session.send("Browser.getWindowForTarget", {
            targetId: from.targetId,
          })
        ).windowId,
    )
    .toBe(to.windowId);
}

for (const barrier of ["composition", "navigation"] as const) {
  test(`full native moved-target handover joins pending ${barrier} and discards old clipboard results`, async ({
    browser,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      fixture.server.origin,
    );
    const host = new ProbeHost(backend.endpoint);
    const viewers: Viewer[] = [];
    try {
      const a = await fixture.viewer(browser, backend, host, true, 0, {
        composition: true,
        beforeInput: observeClipboard,
      });
      viewers.push(a);
      const b = await fixture.viewer(browser, backend, host, true, 0, {
        composition: true,
      });
      viewers.push(b);
      await fullInteractions(a);

      await editAndPaint(b, "destination sibling");
      await seedClipboard(a, "retained local clipboard");
      await resumed(a);
      await a.remote.locator("#plain").selectText();
      const selection = a.holdMessage("reply", "selection");
      const proxy = a.page.getByRole("textbox", {
        name: "Native executor input",
      });
      await proxy.focus();
      await proxy.press("ControlOrMeta+c");
      await selection.held;

      const aKeys = await acquire(a);
      const bKeys = await acquire(b);

      const held = a.probe!.holdNext(
        barrier === "composition" ? "Input.imeSetComposition" : "Page.navigate",
      );
      let received = false;
      void held.held.then(() => {
        received = true;
      });
      if (barrier === "composition") {
        await composing(a, "pending moved preview");
      } else {
        await a.page
          .getByRole("textbox", { name: "Executor address" })
          .fill(fixture.server.origin + "/fixture/no-content");

        // Address focus has already released the remote acquisitions. Finish
        // the old physical gesture locally before starting a toolbar click.
        await a.page.mouse.up();
        await a.page.keyboard.up("Control");
        await a.page.keyboard.up("Shift");

        await expect
          .poll(() =>
            a.page.evaluate(() => ({
              ready: window.nativeExperiment.stats.ready,
              revoked: window.nativeExperiment.stats.revoked,
              error: window.nativeExperiment.stats.error,
            })),
          )
          .toMatchObject({ ready: true, revoked: false });

        await a.page
          .getByRole("button", { name: "Executor navigate", exact: true })
          .click();
        await expect
          .poll(
            () =>
              a.probe!.trace.filter((row) => row.method === "Page.navigate")
                .length,
          )
          .toBe(2);
      }
      await expect
        .poll(async () => ({
          received,
          stats: await a.page.evaluate(() => window.nativeExperiment.stats),
          trace: a.probe!.trace.slice(-8),
        }))
        .toMatchObject({ received: true });

      const oldGeneration = a.probe!.generation;
      await moveTarget(backend, a, b);

      const retirement = a.retire("target-replaced");
      await expect(
        host.admit({
          targetId: a.targetId,
          windowId: b.windowId,
          mode: "composition",
          reply: () => {},
        }),
      ).rejects.toThrow("unsettled owner");
      await releases(a, aKeys, 1);

      await editAndPaint(b, "sibling while moved cleanup is held", false);

      await releases(b, bKeys, 0);
      expect(
        a.probe!.receive(
          JSON.stringify({
            kind: "batch",
            owner: a.probe!.owner,
            generation: oldGeneration,
            sequence: 999,
            acknowledged: 0,
            actions: [{ kind: "commit", text: "late moved commit" }],
          }),
        ),
      ).toBe(false);
      held.release();
      expect(await retirement).toBe(true);

      const replacement = await fixture.viewer(
        browser,
        backend,
        host,
        true,
        0,
        {
          composition: true,
          existing: { ...a, windowId: b.windowId },
        },
      );
      viewers.push(replacement);

      expect(replacement.probe!.owner).not.toBe(a.probe!.owner);
      await editAndPaint(replacement, "destination owner");
      const fresh = await acquire(replacement);
      selection.release();
      held.release();
      a.probe!.close();
      expect(await host.retire(a.probe!)).toBe(false);
      await releases(replacement, fresh, 0);
      await releases(b, bKeys, 0);
      await a.page.mouse.up();
      await a.page.keyboard.up("Control");
      await a.page.keyboard.up("Shift");
      expect(await localClipboard(a)).toBe("retained local clipboard");

      await receipt(info, backend, viewers, {
        barrier,
        actualTabMove: true,
        originalCleanupAndDetach: true,
        destinationVerified: true,
        lateSelectionDiscarded: true,
        replacementAcquisitionsUnaffected: true,
      });
    } finally {
      try {
        for (const viewer of viewers.reverse()) await viewer.close();
      } finally {
        host.close();
        await backend.close();
      }
    }
  });
}

for (const loss of ["CDP", "executor"] as const) {
  test(`full native ${loss} loss retains unknown target denial while another window progresses`, async ({
    browser,
  }, info) => {
    const backend = await launchBackend(
      info.outputPath("backend"),
      fixture.server.origin,
    );
    const wires: WebSocket[] = [];
    const host = new ProbeHost(backend.endpoint, (endpoint) => {
      const wire = new WebSocket(endpoint);
      wires.push(wire);
      return wire;
    });
    const viewers: Viewer[] = [];
    try {
      const a = await fixture.viewer(browser, backend, host, true, 0, {
        composition: true,
        beforeInput: observeClipboard,
      });
      viewers.push(a);
      const b = await fixture.viewer(browser, backend, host, true, 0, {
        composition: true,
      });
      viewers.push(b);
      await fullInteractions(a);
      await editAndPaint(b, "live sibling");
      await acquire(a);
      const bKeys = await acquire(b);
      const held = a.probe!.holdNext("Input.imeSetComposition");
      await composing(a, "uncertain preview");
      await held.held;
      if (loss === "CDP") wires[0]!.close();
      else a.probe!.close();
      a.disconnect();
      expect(await a.retired).toBe(false);
      held.release();
      const connections = wires.length;
      await expect(
        host.admit({
          targetId: a.targetId,
          windowId: a.windowId,
          mode: "composition",
          reply: () => {},
        }),
      ).rejects.toThrow("unsettled owner");
      expect(wires).toHaveLength(connections);
      await editAndPaint(b, "sibling after loss", false);
      await releases(b, bKeys, 0);
      await receipt(info, backend, viewers, {
        loss,
        sameTargetDenied: true,
        noSecondCleanupConnection: true,
        noReplay: true,
        siblingPixels: true,
      });
    } finally {
      try {
        for (const viewer of viewers.reverse()) await viewer.close();
      } finally {
        host.close();
        await backend.close();
      }
    }
  });
}
