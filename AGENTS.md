# Agent Guide

## Project

`cdp-viewer` is a generic browser-side React library for existing Chrome DevTools
Protocol browsers. Read `README.md`, `CONTRIBUTING.md` and `docs/validation.md`
before changing behavior or making compatibility claims.

The current component supports view-only streaming, target selection, optional
window filtering and multiple independent instances. Input/IME, clipboard and
vendor adapters are not implemented. Keep vendor-specific behavior optional when
adding extensions; ordinary CDP must remain usable independently.

## Repository Map

- `src/index.ts`: public component and type exports.
- `src/cdp/`: native WebSocket transport, protocol diagnostics and window lookup.
- `src/viewer/`: controller/session lifecycle, ccstate model and public types.
- `src/react/`: React component and private context/subscription bridge.
- `src/render/`: Canvas decoding, frame queue and painting.
- `src/styles.css`: source styles; `styles/viewer.css`: committed compiled CSS.
- `scripts/`: CSS generation/checks and independent consumer verification.
- `tests/unit/`: Vitest, Testing Library and a fake external CDP wire.
- `tests/browser/`: Playwright fixtures with test-owned Chromium windows.
- `tests/consumer/`: separately installed React/Vite host and SSR fixtures.
- `demo/`: view-only connection forms and independent panels using public exports.
- `vite.demo.config.ts`: production demo build with the `/cdp-viewer/` Pages base.

## Toolchain and Checks

Use the pnpm version pinned in `package.json` (currently 12.14.0). Node must satisfy
`engines.node`; CI uses Node 24. TypeScript is strict, with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled. Follow the
existing ESM, Prettier, Oxlint and ESLint configuration.

Run commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm css:check
pnpm build
pnpm build:demo
pnpm format:check
pnpm lint
pnpm check-types
pnpm knip
pnpm test:package
```

Choose local checks appropriate to the change. **Do not run the full local Vitest
suite or start a development server unless the user explicitly requests it.**
The PR pipeline runs broad unit and browser checks. For a focused regression,
an individual file can be run with
`pnpm exec vitest run tests/unit/client.test.ts`.

Browser tests use bounded fixture servers, test-owned profiles and real Chromium;
they do not need a development server. `CDP_VIEWER_CHROMIUM` may select an existing
Chromium executable. Do not weaken assertions, increase timeouts or add arbitrary
sleeps to hide a failure.

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

`pnpm test:package` installs the pushed GitHub revision using the consumer baseline
of pnpm 10.33.4 and React 19.2.6. It checks types, CSS, peers, frozen reinstall,
production build and bundled SSR with lifecycle scripts disabled.
`CDP_VIEWER_SOURCE_SHA` and `CDP_VIEWER_SOURCE_REPO` select an explicit source.
For unpushed changes, `CDP_VIEWER_CONSUMER_SOURCE=tarball pnpm test:package` is a
supplementary local check; it does not establish real GitHub installation.

## Runtime Invariants

- Each viewer owns its socket, request IDs, pending requests, timers, sessions,
  store and renderer. Do not introduce an implicit endpoint-keyed global pool.
- Preserve the private React context so host ccstate providers stay independent.
  Callback identity changes must not reconnect. Imports and SSR must allocate no
  browser connection or DOM resources.
- `windowId` is optional; zero is present. Unscoped operation must not require
  window APIs. Scoped targets require verified membership, including before
  attachment; a failed lookup must never expose an unfiltered target list.
- Window filtering is presentation scope. Endpoint access and browser provisioning
  belong to the host; browser-native WebSocket cannot add arbitrary auth headers.
- Clear old pixels when a selection is lost or replaced. Do not silently choose
  another page after losing an established selection. Release stale/late attach
  results through their owning connection without affecting a replacement.
- Route flattened CDP session IDs separately from numeric screencast frame IDs.
  Acknowledge owned frames even when they are not painted. Keep one active decode
  and at most one newest queued frame; discard stale results and close bitmaps.
- Pause, visibility changes and unmount must release owned work. Never close the
  remote browser or its tabs during viewer cleanup. Local contain fitting must not
  resize or emulate the remote viewport.

## Documentation and Change Hygiene

- Keep repository artifacts in English and match the user's language in updates.
- Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
- Keep README focused on the library and its usage; do not add issue references,
  internal delivery phases or task-tracking notes.
- Record actual tested capabilities and limitations. A Node CDP connection does
  not prove browser Origin/TLS access. Do not claim provider, hosted, other-browser,
  same-target concurrent stream or physical OS IME compatibility without evidence.
- Never log, persist, commit or upload CDP credentials, raw provider error payloads,
  personal page content, clipboard data or real browser traces. Use fixed public
  diagnostics and synthetic, test-owned fixtures.
- Keep workflow notes and receipts in untracked, locally ignored `codex-work/`;
  never stage them. Preserve unrelated work and keep changes focused.
