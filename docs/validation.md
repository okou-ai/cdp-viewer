# View-only viewer validation

Observed on 2026-10-20 with Node 24.22.0, pnpm 12.14.0, Playwright 1.64.1,
Debian Chromium 155.0.8059.79, React 19.2.0, and ccstate/ccstate-react 6.0.0.
The PR checks validate the submitted source SHA separately. The initial packed
checks below establish viewer behavior; the source-consumption checks exercise
the revised GitHub distribution contract.

## Source-consumption checks

- The default consumer installs the actual pushed full-SHA GitHub dependency
  with pnpm 10.33.4, React 19.2.6 and Vite 8. Installation disables dependency
  lifecycle scripts and automatic peer installation.
- It removes node_modules and reinstalls offline with a frozen lockfile, verifies
  the lockfile is unchanged, and checks installed source/type/CSS entries and
  host-provided React peers. No untracked dist or source alias is used.
- It compiles public types, builds the React host without Tailwind setup, then
  bundles/imports/renders the public source for SSR with WebSocket creation
  forbidden. Plain-Node import of raw TSX is not a compatibility claim.
- Browser scenarios run through these installed exports with a host ccstate
  provider. The package receipt records GitHub versus explicit local-tarball
  source, exact dependency specifier, package manager and lockfile hash.
- The standalone CSS is committed; css:check compares an in-memory generation
  against it. Consumers do not invoke Tailwind or a viewer install-time build.

Before pushing, the explicit tarball mode verifies local changes through the same
source export contract. Only the default real-GitHub mode is distribution
acceptance evidence; no fallback is automatic.

## Local evidence

- Focused `tests/unit/client.test.ts`: 5 passing protocol tests covering reordered
  replies, event/session routing, request timeout/late attach ownership, bounded
  expired requests, disconnect and redacted diagnostics.
- Focused lifecycle regressions: 7 passing controller cases and 1 passing
  Strict Mode component case, including an early first frame, scoped movement,
  late attachment cleanup, per-instance teardown, and cancelled socket opening.
- Independent packed consumer: installs the tarball outside this repository,
  compiles strict public types, builds without Tailwind configuration and imports
  the ESM package on Node without opening a browser connection.
- Real-browser fixtures: 3 passing scenarios through the packed public exports.
  Two actual Chromium windows produce distinct JPEG/Canvas pixels. An active
  viewer is unmounted while the other receives newly changed page pixels; the
  remote page remains open. A test-owned extension moves an existing tab into
  the other window; the old scope becomes unavailable and the new scope lists it.
- Unscoped discovery includes pages across actual windows. Destroying the
  selected target clears its selection instead of choosing another page.
- Native WebSocket from an explicitly allowlisted loopback HTTP Origin succeeds.
  A different localhost Origin is rejected and produces a fixed UI diagnostic.
  This validates actual browser-origin policy rather than a Node CDP connection.
- Host ccstate remains interactive. Host button computed styles are unchanged
  when the stylesheet loads, and conflicting unprefixed utility names remain
  unaffected. Native browser frames use JPEG color tolerance in assertions.

The fixture HTTP server and extension are test infrastructure, not a hosted demo
or a local development server. They own the browser profiles and targets they
mutate, and contain no real connection credentials or personal browser content.
The sandbox's existing Chromium executable is selected with
`CDP_VIEWER_CHROMIUM=/usr/bin/chromium`; CI installs its Playwright Chromium.

Knip's optional raw-transfer AST buffer failed allocation in this sandbox. The
dependency check uses Knip's supported non-raw parser, preserving the same
public-entry-aware analysis rather than excluding findings.

## Demo validation

On 2026-10-20, the production demo build passed six focused Playwright
scenarios with Node 24.22.0, pnpm 12.14.0, Playwright 1.64.1 and Debian Chromium
155.0.8059.79. These consume public component/type/CSS exports at the
`/cdp-viewer/` project-site path:

- Two real windows stream distinct pixels. Editing drafts leaves the existing
  connection intact; reconnect uses committed settings, apply changes scope,
  and disconnect/remove release only the owning viewer. The surviving viewer
  paints newly changed remote pixels and the remote tabs remain open.
- Invalid endpoint/integer inputs do not navigate or open sockets. Zero is
  supplied as a real scope, omission lists pages across windows, and selected
  tabs paint their actual pixels. Refresh clears configuration; no URL or
  local/session storage persistence is used.
- Applying invalid URL or window drafts preserves the existing connection and
  selection. Empty and nonempty fragments, fractional IDs and unsafe integers
  produce field errors without replacing the live viewer, which continues to
  paint newly changed remote pixels. The empty-fragment regression was observed
  failing before the demo's validation fix.
- A backend denying the frontend Origin produces fixed diagnostics. The page
  fits a 390px viewport and disconnected panels can be removed/added.
- A separately labeled HTTPS-Origin fixture fulfills only static app assets
  locally and uses a real native CDP WebSocket with explicit local-network
  permission. This is not an actual GitHub Pages deployment or provider receipt.

Desktop two-window and mobile screenshots were inspected using synthetic pages
and masked test-owned endpoints. No development server or full local Vitest
suite was run. Format, lint, strict types, CSS consistency, dependency analysis
and library/demo production builds passed; broad units and real GitHub consumer
checks remain in PR CI.

Repository Pages is configured for workflow builds at
`https://okou-ai.github.io/cdp-viewer/`, with HTTPS enforced. The first actual
deployment and its source-bound Pages smoke receipt remain unverified before
merge. A routed HTTPS fixture or local production receipt does not satisfy that
rollout gate. The deployment workflow runs the same real-window scenarios
against its actual URL and uploads only sanitized receipts, including any
explicit local-network permission. See [the demo guide](demo.md).

## Remaining compatibility boundaries

- Intended Browser Use endpoint: not probed by these fixtures. No provider
  Origin/TLS or hosted-client compatibility claim is made.
- GitHub Pages: the new workflow still needs its first actual deployment/smoke
  receipt. Okou Origin compatibility is also not established by local fixtures.
- Real Windows/macOS IME and clipboard: P2/P3, outside this view-only slice.
- Other client browsers and remote CDP versions: require their own recorded
  capability probes before being advertised as supported.
- Two simultaneous streams of the same remote target: unverified; different
  windows/targets are the required multi-instance case validated here.

The full unit suite runs in the PR pipeline, following the user's instruction
against a full local Vitest run or local development server.
