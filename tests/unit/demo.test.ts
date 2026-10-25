import { expect, it } from "vitest";
import { JsxEmit, transpileModule } from "typescript";
import { createDemoModel } from "../../demo/model";
import { callbackLimit, usageCode } from "../../demo/playground";
import { browserUse } from "../../src/extensions/browser-use";
import type { ViewerSnapshot } from "../../src/viewer/types";

const snapshot: ViewerSnapshot = {
  status: "streaming",
  targets: [{ id: "private-target", title: "Private page title" }],
  selectedTargetId: "private-target",
  error: null,
  navigation: {
    url: "https://private.invalid/?secret=private",
    canGoBack: true,
    canGoForward: false,
  },
};

function connectedModel() {
  const model = createDemoModel();
  model.run(model.edit$, 1, "endpoint", "wss://browser.invalid/?token=private");
  model.run(model.edit$, 1, "windowDraft", "0");
  model.run(model.setExtension$, 1, browserUse(), true);
  model.run(model.connect$, 1);
  return model;
}

it("reconnects transport changes independently and reflects the applied mode in Usage", () => {
  const model = connectedModel();
  model.run(model.add$);
  const [before, sibling] = model.read(model.panels$);
  model.run(model.configure$, 1, { transport: "split" });
  const current = model.read(model.panels$)[0]!;
  expect(current.generation).toBe(before!.generation + 1);
  expect(current.connection).not.toBe(before!.connection);
  expect(model.read(model.panels$)[1]).toBe(sibling);
  expect(usageCode(current.options, current.connection)).toContain(
    'useState<ViewerTransport>("split")',
  );
});

it("updates independent capture preferences without replacing a panel connection", () => {
  const model = connectedModel();
  model.run(model.add$);
  const [initial, sibling] = model.read(model.panels$);
  model.run(model.configure$, 1, {
    capture: { quality: 50, maxWidth: 1280, maxHeight: 720 },
  });
  const current = model.read(model.panels$)[0]!;
  expect(current.connection).toBe(initial!.connection);
  expect(current.generation).toBe(initial!.generation);
  expect(model.read(model.panels$)[1]).toBe(sibling);
  expect(usageCode(current.options, current.connection)).toContain(
    '({"quality":50,"maxWidth":1280,"maxHeight":720})',
  );
});

it("owns bounded resize gestures without replacing live connections or siblings", () => {
  const model = connectedModel();
  model.run(model.add$);
  const [before, sibling] = model.read(model.panels$);
  expect(
    model.run(model.beginResize$, 1, {
      pointerId: 1,
      x: 900,
      y: 500,
      width: 1000,
      height: 360,
    }),
  ).toBe(true);
  expect(
    model.run(model.beginResize$, 1, {
      pointerId: 2,
      x: 0,
      y: 0,
      width: 500,
      height: 360,
    }),
  ).toBe(false);
  expect(model.run(model.moveResize$, 1, 2, 700, 637, 1000)).toBe(false);
  expect(model.run(model.moveResize$, 1, 1, 700, 637, 1000)).toBe(true);
  let current = model.read(model.panels$)[0]!;
  expect(current.options).toMatchObject({ width: 80, height: 497 });
  expect(current.connection).toBe(before?.connection);
  expect(current.generation).toBe(before?.generation);
  expect(model.read(model.panels$)[1]).toBe(sibling);
  expect(model.run(model.endResize$, 1, 2)).toBeNull();
  model.run(model.moveResize$, 1, 1, -5000, 5000, 600);
  expect(model.read(model.panels$)[0]?.options).toMatchObject({
    width: 50,
    height: 800,
  });
  model.run(model.moveResize$, 1, 1, 5000, -5000, 600);
  expect(model.read(model.panels$)[0]?.options).toMatchObject({
    width: 100,
    height: 240,
  });
  expect(model.run(model.endResize$, 1, 1)).toBe(1);
  const finished = model.read(model.panels$);
  expect(model.run(model.moveResize$, 1, 1, 0, 0, 1000)).toBe(false);
  expect(model.read(model.panels$)).toBe(finished);
  model.run(model.nudgeResize$, 1, -1, 10);
  current = model.read(model.panels$)[0]!;
  expect(current.options).toMatchObject({ width: 99, height: 250 });
  expect(current.resize).toBeNull();
});

it("retires resizing on size-control takeover, cancellation and removal", () => {
  const model = createDemoModel();
  const start = { pointerId: 0, x: 200, y: 200, width: 600, height: 360 };
  model.run(model.beginResize$, 1, start);
  model.run(model.configure$, 1, { height: 520 });
  const configured = model.read(model.panels$);
  expect(configured[0]?.resize).toBeNull();
  expect(model.run(model.moveResize$, 1, 0, 300, 300, 600)).toBe(false);
  expect(model.read(model.panels$)).toBe(configured);
  model.run(model.beginResize$, 1, start);
  expect(model.run(model.endResize$, 1)).toBe(0);
  model.run(model.beginResize$, 1, start);
  expect(model.run(model.nudgeResize$, 1, -5, 40)).toBe(0);
  expect(model.read(model.panels$)[0]?.resize).toBeNull();
  model.run(model.beginResize$, 1, start);
  model.run(model.remove$, 1);
  const removed = model.read(model.panels$);
  expect(model.run(model.moveResize$, 1, 0, 400, 400, 600)).toBe(false);
  expect(model.run(model.endResize$, 1, 0)).toBeNull();
  expect(model.read(model.panels$)).toBe(removed);
});

it("keeps live presentation separate from drafts and uses applied settings for mode changes", () => {
  const model = connectedModel();
  model.run(model.add$);
  const [first, sibling] = model.read(model.panels$);
  model.run(model.edit$, 1, "endpoint", "invalid draft");
  model.run(model.edit$, 1, "windowDraft", "42");
  model.run(model.configure$, 1, {
    paused: true,
    showSettingsMenu: false,
    theme: "dark",
    height: 640,
    width: 75,
    framed: true,
  });
  let current = model.read(model.panels$)[0]!;
  expect(current.connection).toBe(first?.connection);
  expect(model.read(model.panels$)[1]).toBe(sibling);
  model.run(model.observeStatus$, 1, 1, snapshot);
  model.run(model.configure$, 1, { interactive: false });
  current = model.read(model.panels$)[0]!;
  expect(current.connection).toEqual({ ...first?.connection, generation: 2 });
  expect(current.options).toMatchObject({
    paused: true,
    showSettingsMenu: false,
    interactive: false,
    theme: "dark",
    framed: true,
  });
  expect(current.snapshot).toBeNull();
  const unchanged = model.read(model.panels$);
  model.run(model.observeStatus$, 1, 1, snapshot);
  expect(model.read(model.panels$)).toBe(unchanged);
  expect(model.read(model.panels$)[1]).toBe(sibling);
});

it("bounds semantic callback activity and rejects retired, disconnected and removed owners", () => {
  const model = connectedModel();
  for (let index = 0; index < callbackLimit + 5; index++)
    model.run(model.observeStatus$, 1, 1, snapshot);
  let current = model.read(model.panels$)[0]!;
  expect(current.activity).toHaveLength(callbackLimit);
  expect(current.snapshot).toMatchObject({
    status: "streaming",
    targetCount: 1,
    hasSelection: true,
    canGoBack: true,
  });
  expect(JSON.stringify([current.snapshot, current.activity])).not.toMatch(
    /private/i,
  );
  model.run(model.observeError$, 1, 1, {
    kind: "connection",
    message: "Fixed public diagnostic",
  });
  expect(model.read(model.panels$)[0]?.activity.at(-1)).toMatchObject({
    name: "onError",
    value: { kind: "connection", message: "Fixed public diagnostic" },
  });
  model.run(model.clearActivity$, 1);
  expect(model.read(model.panels$)[0]?.snapshot).toEqual(current.snapshot);
  expect(model.read(model.panels$)[0]?.activity).toEqual([]);
  model.run(model.reconnect$, 1);
  const replacement = model.read(model.panels$);
  model.run(model.observeError$, 1, 1, {
    kind: "connection",
    message: "Old owner",
  });
  expect(model.read(model.panels$)).toBe(replacement);
  model.run(model.observeStatus$, 1, 2, snapshot);
  model.run(model.disconnect$, 1);
  const disconnected = model.read(model.panels$);
  model.run(model.observeStatus$, 1, 2, snapshot);
  expect(model.read(model.panels$)).toBe(disconnected);
  model.run(model.remove$, 1);
  const removed = model.read(model.panels$);
  model.run(model.observeStatus$, 1, 2, snapshot);
  expect(model.read(model.panels$)).toBe(removed);
});

it("retains current request diagnostics after clearing or evicting safe callback details", () => {
  const model = connectedModel();
  model.run(model.add$);
  const sibling = model.read(model.panels$)[1];
  const error = {
    kind: "protocol" as const,
    message: "CDP request failed.",
    request: {
      method: "Page.startScreencast",
      code: -32000,
      params: { token: "private payload" },
    },
    raw: "private provider message",
  };
  const expected = {
    kind: "protocol",
    message: "CDP request failed.",
    request: { method: "Page.startScreencast", code: -32000 },
  };
  model.run(model.observeStatus$, 1, 1, { ...snapshot, error });
  model.run(model.observeError$, 1, 1, error);
  expect(model.read(model.panels$)[0]?.activity.at(-1)?.value).toEqual(
    expected,
  );
  model.run(model.clearActivity$, 1);
  expect(model.read(model.panels$)[0]?.snapshot?.error).toEqual(expected);
  for (let index = 0; index < callbackLimit + 1; index++)
    model.run(model.observeStatus$, 1, 1, { ...snapshot, error });
  const current = model.read(model.panels$)[0]!;
  expect(current.activity).toHaveLength(callbackLimit);
  expect(
    current.activity.every((event) => event.name === "onStatusChange"),
  ).toBe(true);
  expect(current.snapshot?.error).toEqual(expected);
  expect(JSON.stringify([current.snapshot, current.activity])).not.toMatch(
    /private|params|raw/,
  );
  expect(model.read(model.panels$)[1]).toBe(sibling);
  model.run(model.reconnect$, 1);
  const replacement = model.read(model.panels$);
  model.run(model.observeStatus$, 1, 1, { ...snapshot, error });
  model.run(model.observeError$, 1, 1, error);
  expect(model.read(model.panels$)).toBe(replacement);
});

it("clears only its owning console while preserving both current diagnostics and sibling history", () => {
  const model = connectedModel();
  model.run(model.add$);
  model.run(model.edit$, 2, "endpoint", "wss://sibling.invalid/");
  model.run(model.connect$, 2);
  const firstError = {
    kind: "protocol" as const,
    message: "CDP request failed.",
    request: { method: "Target.getTargets", code: -32000 },
  };
  const secondError = {
    kind: "tab" as const,
    message: "The tab operation failed.",
    request: { method: "Page.reload", code: -32001 },
  };
  model.run(model.observeStatus$, 1, 1, { ...snapshot, error: firstError });
  model.run(model.observeError$, 1, 1, firstError);
  model.run(model.observeStatus$, 2, 1, { ...snapshot, error: secondError });
  model.run(model.observeError$, 2, 1, secondError);
  const [first, sibling] = model.read(model.panels$);
  model.run(model.clearActivity$, 1);
  const [cleared, unchangedSibling] = model.read(model.panels$);
  expect(cleared?.activity).toEqual([]);
  expect(cleared?.snapshot).toBe(first?.snapshot);
  expect(cleared?.snapshot?.error).toEqual(firstError);
  expect(cleared?.connection).toBe(first?.connection);
  expect(unchangedSibling).toBe(sibling);
  expect(unchangedSibling?.activity.at(-1)?.value).toEqual(secondError);
  model.run(model.observeStatus$, 1, 1, { ...snapshot, error: firstError });
  expect(model.read(model.panels$)[0]?.activity).toMatchObject([
    { sequence: 3, name: "onStatusChange", value: { error: firstError } },
  ]);
  expect(model.read(model.panels$)[1]).toBe(sibling);
  const owner = model.read(model.panels$)[0];
  model.run(model.clearActivity$, 2);
  expect(model.read(model.panels$)[0]).toBe(owner);
  expect(model.read(model.panels$)[1]?.activity).toEqual([]);
  expect(model.read(model.panels$)[1]?.snapshot).toBe(sibling?.snapshot);
  expect(model.read(model.panels$)[1]?.snapshot?.error).toEqual(secondError);
});

it("shares a controlled sync mode without replacing live ownership or sibling options", () => {
  const model = connectedModel();
  model.run(model.add$);
  const [first, sibling] = model.read(model.panels$);
  expect(first?.options.windowSizeSync).toBe("off");
  expect(sibling?.options.windowSizeSync).toBe("off");
  model.run(model.configure$, 1, { windowSizeSync: "live" });
  model.run(model.observeStatus$, 1, 1, snapshot);
  const summary = model.read(model.panels$)[0]?.snapshot;
  for (let index = 0; index < callbackLimit + 5; index++)
    model.run(
      model.observeWindowSizeSync$,
      1,
      1,
      index % 2 === 0 ? "initial" : "off",
    );
  const current = model.read(model.panels$)[0]!;
  expect(current.options.windowSizeSync).toBe("initial");
  expect(current.connection).toBe(first?.connection);
  expect(current.generation).toBe(first?.generation);
  expect(current.snapshot).toBe(summary);
  expect(model.read(model.panels$)[1]).toBe(sibling);
  expect(current.activity).toHaveLength(callbackLimit);
  expect(current.activity.at(-1)).toEqual({
    sequence: callbackLimit + 6,
    name: "onWindowSizeSyncChange",
    value: "initial",
  });
  expect(JSON.stringify(current.activity)).not.toMatch(/private/i);
  model.run(model.clearActivity$, 1);
  model.run(model.configure$, 1, { theme: "dark", height: 500 });
  expect(model.read(model.panels$)[0]?.options.windowSizeSync).toBe("initial");
  expect(model.read(model.panels$)[0]?.activity).toEqual([]);
});

it("rejects retired sync requests after connection and interactive ownership changes", () => {
  const model = connectedModel();
  model.run(model.configure$, 1, { windowSizeSync: "live" });
  model.run(model.reconnect$, 1);
  let unchanged = model.read(model.panels$);
  model.run(model.observeWindowSizeSync$, 1, 1, "off");
  expect(model.read(model.panels$)).toBe(unchanged);
  model.run(model.observeWindowSizeSync$, 1, 2, "initial");
  expect(model.read(model.panels$)[0]?.options.windowSizeSync).toBe("initial");
  model.run(model.configure$, 1, { interactive: false });
  unchanged = model.read(model.panels$);
  model.run(model.observeWindowSizeSync$, 1, 2, "off");
  expect(model.read(model.panels$)).toBe(unchanged);
  expect(unchanged[0]?.options.windowSizeSync).toBe("initial");
  model.run(model.disconnect$, 1);
  unchanged = model.read(model.panels$);
  model.run(model.observeWindowSizeSync$, 1, 3, "off");
  expect(model.read(model.panels$)).toBe(unchanged);
  model.run(model.remove$, 1);
  unchanged = model.read(model.panels$);
  model.run(model.observeWindowSizeSync$, 1, 3, "off");
  expect(model.read(model.panels$)).toBe(unchanged);
});

it("generates valid JSX from applied options without endpoints or draft metadata", () => {
  const model = connectedModel();
  model.run(model.edit$, 1, "windowDraft", "42");
  model.run(model.setExtension$, 1, browserUse(), false);
  model.run(model.configure$, 1, {
    theme: "dark",
    customAccent: true,
    accent: "#123456",
    framed: true,
    windowSizeSync: "live",
    showSettingsMenu: false,
  });
  const panel = model.read(model.panels$)[0]!;
  const code = usageCode(panel.options, panel.connection);
  expect(code).toContain("windowId={0}");
  expect(code).toContain("showSettingsMenu={false}");
  expect(code).toContain("[browserUse()]");
  expect(code).toContain("demo-viewer-framed");
  expect(code).toContain('colorScheme="dark"');
  expect(code).toContain('"--cdpv-accent": "#123456"');
  expect(code).toContain('useState<WindowSizeSync>("live")');
  expect(code).toContain("windowSizeSync={windowSizeSync}");
  expect(code).toContain("onWindowSizeSyncChange={setWindowSizeSync}");
  expect(code).toContain("capture={capture}");
  expect(code).toContain("transport={transport}");
  expect(code).toContain("onTransportChange={setTransport}");
  expect(code).toContain("onCaptureChange={setCapture}");
  expect(code).not.toMatch(/private|token=|browser\.invalid|windowId=\{42\}/);
  expect(
    transpileModule(code, {
      reportDiagnostics: true,
      compilerOptions: { jsx: JsxEmit.ReactJSX },
    }).diagnostics,
  ).toEqual([]);
  expect(usageCode({ ...panel.options, theme: "inherit" }, null)).not.toContain(
    "colorScheme=",
  );
});
