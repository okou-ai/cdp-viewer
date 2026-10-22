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

it("keeps live presentation separate from drafts and uses applied settings for mode changes", () => {
  const model = connectedModel();
  model.run(model.add$);
  const [first, sibling] = model.read(model.panels$);
  model.run(model.edit$, 1, "endpoint", "invalid draft");
  model.run(model.edit$, 1, "windowDraft", "42");
  model.run(model.configure$, 1, {
    paused: true,
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

it("generates valid JSX from applied options without endpoints or draft metadata", () => {
  const model = connectedModel();
  model.run(model.edit$, 1, "windowDraft", "42");
  model.run(model.setExtension$, 1, browserUse(), false);
  model.run(model.configure$, 1, {
    theme: "dark",
    customAccent: true,
    accent: "#123456",
    framed: true,
  });
  const panel = model.read(model.panels$)[0]!;
  const code = usageCode(panel.options, panel.connection);
  expect(code).toContain("windowId={0}");
  expect(code).toContain("[browserUse()]");
  expect(code).toContain("demo-viewer-framed");
  expect(code).toContain('colorScheme="dark"');
  expect(code).toContain('"--cdpv-accent": "#123456"');
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
