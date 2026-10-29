# Agent Guide

## Project

`cdp-viewer` is a generic browser-side React library for existing Chrome DevTools
Protocol browsers. Read `README.md`, `API.md`, `CONTRIBUTING.md` and `docs/README.md`
before changing behavior or making compatibility claims.

The current component supports view-only streaming, target selection, optional
window filtering and multiple independent instances. Optional `interactive` mode
adds native text input, mouse/keyboard and navigation; physical macOS/Windows IME
validation is still pending. Plain-text clipboard transfer is available in
interactive mode; see demo/interaction.md for its supported selection/permission
boundary. Optional extensions provide a typed, connection-owned event/selection
contract and a Browser Use adapter through its own package entry point.
Keep vendor-specific behavior optional when
adding extensions; ordinary CDP must remain usable independently.

## Repository Map

- `src/index.ts`: public component and type exports.
- `src/cdp/`: native WebSocket transport, protocol diagnostics and window lookup.
- `src/display/`: shared selected-session geometry, input projection and connection-owned synchronization policy/execution. See [display architecture](docs/display-architecture.md).
- `src/extensions/`: public adapter types, owned registration lifecycle and optional vendors.
- `src/viewer/`: controller/session lifecycle, ccstate model and public types.
- `src/react/`: React component and private context/subscription bridge.
- `src/state/`: per-instance Store entry and private React subscription bridge.
- `src/render/`: Canvas decoding, frame queue and painting.
- `src/input/`: DOM adapter, native composition model, lifecycle transition/pressed
  input state, owner-bound CDP queue and image/CSS geometry. Read
  `docs/input-lifecycle.md` before changing input ownership or cleanup.
- `src/styles.css`: source styles; `styles/viewer.css`: committed compiled CSS.
- `scripts/`: CSS generation/checks and independent consumer verification.
- `tools/eslint/`: local strict React/ccstate rules and real-config regressions.
- `tests/unit/`: Vitest, Testing Library and a fake external CDP wire.
- `tests/browser/`: Playwright fixtures with test-owned Chromium windows.
- `tests/consumer/`: separately installed React/Vite host and SSR fixtures.
- `demo/`: connection forms and interactive panels using public exports.
- `vite.demo.config.ts`: production demo build with the `/cdp-viewer/` Pages base.

## Toolchain and Checks

Use the pnpm version and Node range pinned in `package.json`; CI configuration
defines its Node version. TypeScript is strict, with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled. Follow the
existing ESM, Prettier, Oxlint and ESLint configuration.

Follow [the developer checklist](CONTRIBUTING.md#checks) and
[validation methods](docs/validation.md). Keep command lists in CONTRIBUTING and
mutable version values in executable configuration.

Choose local checks appropriate to the change. **Do not run the full local Vitest
suite or start a development server unless the user explicitly requests it.**
The PR pipeline runs broad unit and browser checks. Browser fixtures own bounded
servers and Chromium profiles. Do not weaken assertions, increase timeouts or
add arbitrary sleeps to hide a failure.

## Distribution and Styles

- Distribute TS/TSX source and public types through a full 40-character GitHub
  commit SHA and the consumer's committed lockfile. No npm publication is planned;
  keep `private: true` and the Apache-2.0 license consistent with `LICENSE`.
- React and React DOM remain host-provided peers. Include all referenced source,
  type dependencies, standalone CSS and LICENSE in package files.
- Consumers must not need this repository's build toolchain or install-time
  builds. Do not require host ccstate providers or Tailwind configuration, and
  do not add prepare/install hooks.
- `pnpm build` produces internal validation artifacts; public exports must not
  depend on untracked `dist/` files. Source SSR requires a TSX-capable toolchain.
- Edit `src/styles.css` or component classes, then run `pnpm css:write` and commit
  `styles/viewer.css`. Keep utilities prefixed and selectors scoped; omit global
  Preflight/reset rules. Use `--cdpv-*` variables for instance themes.

Use the [consumer verification instructions](CONTRIBUTING.md#consumer-verification)
for immutable GitHub installation. A local tarball is supplementary evidence and
cannot replace that distribution gate.

## Runtime Invariants

Read [docs/state-architecture.md](docs/state-architecture.md) before changing state
or React boundaries. Ordinary views read projections and dispatch commands from
event handlers. Keep writable atoms private and preserve independent viewer
Stores. Apply the same ownership rules in every file. Do not add filename
allowlists, rule-disable overrides, directory exemptions or inline suppressions.
Keep semantic state and stable bindings in ccstate; React only observes private
projections and bridges committed lifetimes. Do not use useMemo, useCallback,
useState, useRef, useEffect or useLayoutEffect in first-party runtime code.
`pnpm lint` also runs the architecture rule regressions.

Keep lint rules simple and focused on ordinary code and likely mistakes. Follow
the documented rule design policy; a deliberately constructed bypass alone does
not justify more analysis or special cases. Preserve multi-instance behavior
through implementation, behavioral tests and review.

- Each viewer owns its socket, request IDs, pending requests, timers, sessions,
  store and renderer. Do not introduce an implicit endpoint-keyed global pool.
- Preserve the private React context so host ccstate providers stay independent.
  Callback identity changes must not reconnect. Imports and SSR must allocate no
  browser connection or DOM resources.
- `windowId` is optional; zero is present. Unscoped operation must not require
  window APIs. Scoped targets require verified membership, including before
  attachment; a failed lookup must never expose an unfiltered target list.
  Individual background lookup failures exclude that page without retiring an
  independently verified selected owner. Keep selected membership failures,
  unsupported required capabilities and overall discovery deadlines strict.
- Window filtering is presentation scope. Endpoint access and browser provisioning
  belong to the host; browser-native WebSocket cannot add arbitrary auth headers.
- During tab replacement, already displayed pixels may remain only as a blurred,
  noninteractive connecting backdrop until the replacement is ready. Invalidate
  old decode work immediately. Clear pixels on selection loss, pause, failure,
  disconnect and teardown. Do not silently choose
  another page after losing an established selection. Release stale/late attach
  results through their owning connection without affecting a replacement.
- Route flattened CDP session IDs separately from numeric screencast frame IDs.
  Acknowledge owned frames even when they are not painted. Keep one active decode
  and at most one newest queued frame; discard stale results and close bitmaps.
- Pause, visibility changes and unmount must release owned work. Never close the
  remote browser or its tabs during viewer cleanup. Local contain fitting alone
  must not resize or emulate the remote viewport. Display adaptation is explicit
  opt-in or a manual command; scope its native sizing and emulation to the owning
  connection/window/session and retain bounded, coalesced resize work.
- Input is explicit opt-in and instance/session/document/focus owned. Keep the
  native textarea stable and focusable; never replace it during composition or
  send preedit/control keys through the committed-text path. Discard unsent work
  after ownership loss; never retry uncertain input/navigation. Preserve local
  toolbar/host focus and release owned keys/buttons. F8 exits remote keyboard
  focus. Route input through Chromium's current native focus; DOM caret metadata
  is optional and must not authorize or block input. Clipboard transfer must
  validate selection ownership and preserve the local browser gesture.

## Documentation and Change Hygiene

- Keep repository artifacts in English and match the user's language in updates.
- Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
- Keep README focused on the library and its usage; do not add issue references,
  internal delivery phases or task-tracking notes.
- Keep the consumer contract in `API.md`; link to existing guides for demo,
  interaction, architecture and validation details instead of duplicating them.
- Keep `docs/` focused on coding principles, architecture and validation methods.
  Put demo instructions and interaction behavior in `demo/`. Keep concrete
  business rules in implementation/tests and dated results in PRs, issues or CI
  artifacts rather than permanent engineering guidance.
- Record actual tested capabilities and limitations. A Node CDP connection does
  not prove browser Origin/TLS access. Do not claim provider, hosted, other-browser,
  same-target concurrent stream or physical OS IME compatibility without evidence.
- Never log, persist, commit or upload CDP credentials, raw provider error payloads,
  personal page content, clipboard data or real browser traces. Use fixed public
  diagnostics and synthetic, test-owned fixtures.
- Keep workflow notes and receipts in untracked, locally ignored `codex-work/`;
  never stage them. Preserve unrelated work and keep changes focused.
