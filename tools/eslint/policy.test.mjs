import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: process.cwd(), fix: false });
const model = "src/viewer/model.ts";
const view = "src/react/policy-probe.tsx";

async function lint(code, file = model) {
  const [result] = await eslint.lintText(code, { filePath: resolve(file) });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  return result.messages;
}

const rejected = [
  [
    "microtask in default function render",
    "export default function() { queueMicrotask(work); return null; }",
    "ccstate/no-side-effect-in-render",
    view,
  ],
  [
    "microtask in default arrow render",
    "export default () => { queueMicrotask(work); return null; };",
    "ccstate/no-side-effect-in-render",
    view,
  ],
  [
    "microtask in custom hook render",
    "function useAction() { queueMicrotask(work); }",
    "ccstate/no-side-effect-in-render",
    view,
  ],
  [
    "microtask in arrow hook render",
    "const useAction = () => { queueMicrotask(work); };",
    "ccstate/no-side-effect-in-render",
    view,
  ],
  [
    "microtask in default hook outside TSX",
    "export default function useAction() { queueMicrotask(work); }",
    "ccstate/no-side-effect-in-render",
    "src/viewer/helper.ts",
  ],
  [
    "microtask in render IIFE",
    "export function View() { (() => queueMicrotask(work))(); return null; }",
    "ccstate/no-side-effect-in-render",
    view,
  ],
  [
    "renamed cancellation unchecked await",
    "import { command } from 'ccstate'; const work$ = command(async (_, lifetime: AbortSignal) => { await perform(); update(); });",
    "ccstate/signal-check-await",
  ],
  [
    "view controller extension",
    "import { ViewerController } from '../viewer/controller.js';",
    "@typescript-eslint/no-restricted-imports",
    view,
  ],
  [
    "view nested input resource",
    "import { acquire } from '../input/internal/session';",
    "@typescript-eslint/no-restricted-imports",
    view,
  ],
  [
    "global IIFE instance",
    "import { createInstance } from '../state/instance'; const shared = (() => createInstance(() => ({})))();",
    "ccstate/instance-boundaries",
  ],
  [
    "global namespace factory alias",
    "import * as models from './model'; const make = models.createViewerModel; const shared = make();",
    "ccstate/instance-boundaries",
  ],
  [
    "default render command",
    "export default function({ scope, action$ }) { const go = scope.useCommand(action$); go(); return null; }",
    "ccstate/view-writes",
    view,
  ],
  [
    "render hook command",
    "function useAction(scope, action$) { const go = scope.useCommand(action$); go(); return null; }",
    "ccstate/view-writes",
    view,
  ],
  [
    "view state hook",
    "import { useState } from 'react';",
    "@typescript-eslint/no-restricted-imports",
    view,
  ],
  [
    "aliased view hook",
    "import { useEffect as effect } from 'react';",
    "@typescript-eslint/no-restricted-imports",
    view,
  ],
  [
    "namespace React import",
    "import * as React from 'react';",
    "@typescript-eslint/no-restricted-imports",
    view,
  ],
  [
    "helper cannot hide React state",
    "import { useState } from 'react';",
    "@typescript-eslint/no-restricted-imports",
    "src/viewer/helper.ts",
  ],
  [
    "host hooks cannot replace private context",
    "import { useGet } from 'ccstate-react';",
    "@typescript-eslint/no-restricted-imports",
    view,
  ],
  [
    "forwarded hook bypass",
    "export { useState } from 'react';",
    "ccstate/signal-imports",
    "src/viewer/helper.ts",
  ],
  [
    "forwarded signal bypass",
    "export * from 'ccstate';",
    "ccstate/signal-imports",
    "src/viewer/helper.ts",
  ],
  [
    "runtime cannot acquire UI state",
    "import { useState } from 'react';",
    "@typescript-eslint/no-restricted-imports",
    "src/react/runtime.tsx",
  ],
  [
    "entry cannot acquire UI state",
    "import { useState } from 'react';",
    "@typescript-eslint/no-restricted-imports",
    "demo/main.tsx",
  ],
  [
    "view signal constructor",
    "import { state } from 'ccstate';",
    "@typescript-eslint/no-restricted-imports",
    view,
  ],
  [
    "view transport",
    "import { ViewerController } from '../viewer/controller';",
    "@typescript-eslint/no-restricted-imports",
    view,
  ],
  [
    "view browser resource",
    "export function View() { return document.title; }",
    "no-restricted-globals",
    view,
  ],
  [
    "direct view controller call",
    "export function View({ controller }) { controller.select('page'); return null; }",
    "ccstate/view-writes",
    view,
  ],
  [
    "view ref state write",
    "export function View({ current }) { current.value = 2; return null; }",
    "ccstate/view-writes",
    view,
  ],
  [
    "render command dispatch",
    "export function View({ scope, action$ }) { const go = scope.useCommand(action$); go(); return null; }",
    "ccstate/view-writes",
    view,
  ],
  [
    "aliased render command dispatch",
    "export function View({ scope, action$ }) { const go = scope.useCommand(action$); const invoke = go; invoke(); return null; }",
    "ccstate/view-writes",
    view,
  ],
  [
    "render IIFE command dispatch",
    "export function View({ scope, action$ }) { const go = scope.useCommand(action$); (() => go())(); return null; }",
    "ccstate/view-writes",
    view,
  ],
  [
    "aliased Store construction",
    "import { createStore as make } from 'ccstate'; export function wrong() { return make(); }",
    "ccstate/no-create-store",
  ],
  [
    "namespace Store construction",
    "import * as cc from 'ccstate'; export function wrong() { return cc.createStore(); }",
    "ccstate/no-create-store",
  ],
  [
    "Store subpath bypass",
    "import { createStore } from 'ccstate/core'; export function wrong() { return createStore(); }",
    "ccstate/signal-imports",
  ],
  [
    "misplaced instance entry",
    "import { createInstance as make } from '../state/instance'; export function wrong() { return make(() => ({})); }",
    "ccstate/instance-boundaries",
    "src/viewer/helper.ts",
  ],
  [
    "lookalike nested definition path",
    "import { createInstance } from '../state/instance'; export function wrong() { return createInstance(() => ({})); }",
    "ccstate/instance-boundaries",
    "src/nested/src/viewer/model.ts",
  ],
  [
    "global instance",
    "import { createInstance } from '../state/instance'; const shared = createInstance(() => ({}));",
    "ccstate/instance-boundaries",
  ],
  [
    "global aliased instance",
    "import { createInstance } from '../state/instance'; const make = createInstance; const shared = make(() => ({}));",
    "ccstate/instance-boundaries",
  ],
  [
    "global namespace model",
    "import * as models from './model'; const shared = models.createViewerModel();",
    "ccstate/instance-boundaries",
  ],
  [
    "global browser resource",
    "const socket = new WebSocket('wss://fixture.invalid');",
    "ccstate/instance-boundaries",
  ],
  [
    "command creates graph",
    "import { command } from 'ccstate'; import { createInstance } from '../state/instance'; const work$ = command(() => createInstance(() => ({})));",
    "ccstate/instance-boundaries",
  ],
  [
    "signal alias bypass",
    "import { state as atom } from 'ccstate'; function createViewerSignals() { return atom(0); }",
    "ccstate/signal-imports",
  ],
  [
    "namespace signal bypass",
    "import * as cc from 'ccstate'; function createViewerSignals() { return cc.state(0); }",
    "ccstate/signal-imports",
  ],
  [
    "signal suffix",
    "import { state } from 'ccstate'; function createViewerSignals() { const count = state(0); }",
    "ccstate/signal-dollar-suffix",
  ],
  [
    "exported writable atom",
    "import { state } from 'ccstate'; export const count$ = state(0);",
    "ccstate/no-export-state",
  ],
  [
    "returned writable atom",
    "import { state } from 'ccstate'; function createViewerSignals() { const count$ = state(0); return { count$ }; }",
    "ccstate/private-state",
  ],
  [
    "writable public type",
    "import type { State } from 'ccstate'; export interface Bad { value$: State<number> }",
    "ccstate/no-export-state",
  ],
  [
    "accessor escape",
    "import { command } from 'ccstate'; const work$ = command(({get}) => helper(get));",
    "ccstate/no-accessor-escape",
  ],
  [
    "accessor parameter",
    "import type { Getter } from 'ccstate'; function helper(get: Getter) {}",
    "ccstate/no-getter-setter-params",
  ],
  [
    "Store parameter",
    "import type { Store } from 'ccstate'; function helper(store: Store) {}",
    "ccstate/no-store-in-params",
  ],
  [
    "async command without cancellation",
    "import { command } from 'ccstate'; const work$ = command(async () => { await perform(); });",
    "ccstate/command-async-signal",
  ],
  [
    "unchecked await",
    "import { command } from 'ccstate'; const work$ = command(async (_, signal: AbortSignal) => { await perform(); update(); });",
    "ccstate/signal-check-await",
  ],
  [
    "nested command",
    "import { command } from 'ccstate'; const work$ = command(() => command(() => 1));",
    "ccstate/no-command-in-command",
  ],
  [
    "computed captures cancellation",
    "import { computed } from 'ccstate'; const work$ = computed(() => (signal: AbortSignal) => signal.aborted);",
    "ccstate/no-computed-signal",
  ],
  [
    "module mutable cache",
    "const connections = new Map();",
    "ccstate/no-package-variable",
  ],
  [
    "unowned controller",
    "function helper() { return new AbortController(); }",
    "ccstate/no-new-abort-controller",
  ],
  [
    "imperative child controller",
    "import { createChildAbortController as child } from './utils'; function helper() { return child(); }",
    "ccstate/no-create-child-abort-controller",
  ],
  [
    "raw deferred",
    "function helper() { return new Promise(resolve => resolve(1)); }",
    "ccstate/no-new-promise",
  ],
  [
    "display synchronization cannot create a second deferred owner",
    "function helper() { return new Promise(resolve => resolve(1)); }",
    "ccstate/no-new-promise",
    "src/display/sync.ts",
  ],
  [
    "display geometry helpers cannot acquire cancellation lifetimes",
    "function helper() { return new AbortController(); }",
    "ccstate/no-new-abort-controller",
    "src/display/geometry.ts",
  ],
  [
    "discarded promise",
    "function helper() { void load(); }",
    "ccstate/no-void-statement",
  ],
  [
    "empty rejection",
    "function helper() { load().catch(() => {}); }",
    "ccstate/no-empty-promise-catch",
  ],
  [
    "abort swallower",
    "function helper() { load().catch(throwIfNotAbort); }",
    "ccstate/no-abort-swallower",
  ],
  [
    "cancel swallowed in command graph",
    "import { command } from 'ccstate'; const work$ = command(async (_, signal: AbortSignal) => { try { await load(signal); } catch (error) { report(error); } });",
    "ccstate/no-catch-abort",
  ],
  [
    "Oxlint suppression",
    "// oxlint-disable-next-line typescript/no-floating-promises\nfunction helper() { load(); }",
    "ccstate/no-suppression",
  ],
  [
    "type suppression",
    "// @ts-ignore\nconst value = missing;",
    "ccstate/no-suppression",
  ],
];

for (const [name, code, rule, file] of rejected) {
  await test(`rejects ${name}`, async () => {
    const messages = await lint(code, file);
    assert.ok(
      messages.some((message) => message.ruleId === rule),
      JSON.stringify(messages),
    );
  });
}

const accepted = [
  [
    "default component event microtask",
    "export default function() { return <button type='button' onClick={() => queueMicrotask(work)}>Go</button>; }",
    view,
  ],
  [
    "custom hook returns deferred microtask callback",
    "function useAction() { return () => queueMicrotask(work); }",
    view,
  ],
  [
    "IIFE inside deferred event handler",
    "export function View() { return <button type='button' onClick={() => (() => queueMicrotask(work))()}>Go</button>; }",
    view,
  ],
  [
    "named IIFE inside deferred event handler",
    "export function View() { return <button type='button' onClick={() => (function Run() { queueMicrotask(work); })()}>Go</button>; }",
    view,
  ],
  [
    "non-React default helper microtask",
    "export default function() { queueMicrotask(work); }",
    "src/viewer/helper.ts",
  ],
  [
    "renamed cancellation checked await",
    "import { command } from 'ccstate'; const work$ = command(async (_, lifetime: AbortSignal) => { await perform(); lifetime.throwIfAborted(); update(); });",
  ],
  [
    "type-only resource in view",
    "import type { ViewerController } from '../viewer/controller.js';",
    view,
  ],
  [
    "runtime resource definition",
    "import { ViewerController } from '../viewer/controller.js';",
    "src/react/runtime.tsx",
  ],
  [
    "one factory can construct independent instances",
    "import { createInstance } from '../state/instance'; export function createViewerModel() { return createInstance(() => ({})); }",
  ],
  [
    "several independent factory allocations",
    "import { createInstance } from '../state/instance'; export function createViewerModel() { return [createInstance(() => ({})), createInstance(() => ({}))]; }",
  ],
  [
    "private projection and command",
    "import { state, computed, command } from 'ccstate'; function createViewerSignals() { const count$ = state(0); const value$ = computed(get => get(count$)); const increment$ = command(({set}) => set(count$, x => x + 1)); return { value$, increment$ }; }",
  ],
  [
    "cancellation propagated",
    "import { command } from 'ccstate'; const work$ = command(async (_, signal: AbortSignal) => { await load(signal); });",
  ],
  [
    "caught cancellation rethrown",
    "import { command } from 'ccstate'; const work$ = command(async (_, signal: AbortSignal) => { try { await load(signal); } catch (error) { throw error; } });",
  ],
  [
    "checked await",
    "import { command } from 'ccstate'; const work$ = command(async (_, signal: AbortSignal) => { await load(); signal.throwIfAborted(); update(); });",
  ],
  [
    "event command dispatch",
    "export function View({ scope, action$ }) { const go = scope.useCommand(action$); return <button type='button' onClick={() => go()}>Go</button>; }",
    view,
  ],
  [
    "type-only React in views",
    "import type { ReactNode } from 'react'; export function View({ children }: {children: ReactNode}) { return <div>{children}</div>; }",
    view,
  ],
  [
    "private context metadata",
    "import { createScope } from '../state/react'; import { createViewerModel } from '../viewer/model'; export const scope = createScope(createViewerModel);",
    "src/react/context.ts",
  ],
  [
    "Store definition site",
    "import { createStore } from 'ccstate'; export function createInstance() { return createStore(); }",
    "src/state/instance.ts",
  ],
  [
    "wire deferred primitive",
    "export function deferred() { return new Promise(resolve => resolve(1)); }",
    "src/cdp/client.ts",
  ],
  [
    "wire cancellation primitive",
    "export function lifetime() { return new AbortController(); }",
    "src/cdp/client.ts",
  ],
  [
    "selected-session presentation settlement primitive",
    "export function deferred() { return new Promise(resolve => resolve(1)); }",
    "src/display/viewport.ts",
  ],
  [
    "selected-session presentation deadline primitive",
    "export function lifetime() { return new AbortController(); }",
    "src/display/viewport.ts",
  ],
  [
    "extension registration lifetime primitive",
    "export function lifetime() { return new AbortController(); }",
    "src/extensions/runtime.ts",
  ],
  [
    "queued read settlement primitive",
    "export function deferred() { return new Promise(resolve => resolve(1)); }",
    "src/input/queue.ts",
  ],
  [
    "clipboard representation primitive",
    "export function deferred() { return new Promise(resolve => resolve(1)); }",
    "src/input/clipboard.ts",
  ],
  [
    "narrow React bridge",
    "import { useState } from 'react'; export function Provider() { const [model] = useState(createModel); return null; }",
    "src/state/react.tsx",
  ],
  [
    "demo bootstrap StrictMode",
    "import { StrictMode } from 'react'; document.getElementById('root');",
    "demo/main.tsx",
  ],
];

for (const [name, code, file] of accepted) {
  await test(`permits ${name}`, async () =>
    assert.deepEqual(await lint(code, file), []));
}

await test("inline suppressions cannot turn the architecture gate off", async () => {
  const messages = await lint(
    "/* eslint-disable ccstate/no-void-statement */\nfunction helper() { void load(); }",
  );
  assert.ok(
    messages.some((message) => message.ruleId === "ccstate/no-void-statement"),
  );
  assert.ok(
    messages.some((message) => message.message.includes("noInlineConfig")),
  );
});

for (const [name, code] of [
  [
    "referenced signal binding",
    "import { computed } from 'ccstate'; const value = computed(() => 1); const result$ = computed(get => get(value));",
  ],
  [
    "signal binding with an existing suffixed name",
    "import { computed } from 'ccstate'; const value$ = computed(() => 2); const value = computed(() => 1); const result$ = computed(get => get(value) + get(value$));",
  ],
]) {
  await test(`autofix preserves ${name} and reports the required rename`, async () => {
    const fixingEslint = new ESLint({ cwd: process.cwd(), fix: true });
    const [result] = await fixingEslint.lintText(code, {
      filePath: resolve(model),
    });
    assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
    assert.equal(result.output, undefined);
    assert.ok(
      result.messages.some(
        (message) => message.ruleId === "ccstate/signal-dollar-suffix",
      ),
      JSON.stringify(result.messages),
    );
  });
}
