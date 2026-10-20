# Viewer validation

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

The view-only demo was subsequently deployed from
`cdfe971fd14fb0e111590fa6a6ab95beccbc5987` at
`https://okou-ai.github.io/cdp-viewer/`. The successful
[deployment and smoke run](https://github.com/okou-ai/cdp-viewer/actions/runs/39421546854)
produced an `actual-pages-deployment` receipt bound to that source and URL.
Client/backend Chromium 156.0.8078.4 connected directly from the actual Pages
Origin to owned Chromium, with local-network permission explicitly granted.
The receipt verifies different windows, draft isolation, reconnect and independent
cleanup. It contains no endpoint URLs or input content. This establishes the
view-only rollout; interaction and other providers are not established by it.
See [the demo guide](demo.md).

## Interaction validation

On 2026-10-20, five focused interaction Playwright scenarios passed with Node
24.22.0, pnpm 12.14.0, Playwright 1.64.1 and Debian Chromium 155.0.8059.79.
They use an independently installed public-source tarball consumer with scripts
disabled, React 19.2.6 and Vite 8; this is supplementary local packaging evidence.
Actual pushed full-SHA GitHub consumption remains a PR CI check.

[CI for the interaction code](https://github.com/okou-ai/cdp-viewer/actions/runs/39448141488)
at `fba091e42eaf7fb326e7427eff8dd0526d5cc7bb` passed 25 unit tests, 14 browser
scenarios and actual GitHub consumer validation (pnpm 10.33.4, React 19.2.6,
source types/CSS, frozen reinstall, build and SSR). CI's browser is Chromium
156.0.8078.4; this does not establish real macOS/Windows system IME behavior.

- Two real browser windows receive their own native text/emoji, Ctrl and Meta
  selection intents, deletion, undo/redo, textarea Enter, button Space and Tab.
  Local host/address fields retain their input, F8 releases remote keyboard
  focus, and the surviving viewer stays usable after the other is unmounted.
  Native double-click selects a remote word; its regression failed before
  forwarding the browser's mouse click count and preserving same-viewer gestures.
- Actual nested rich contenteditable and an open-shadow text control receive
  committed text. Focused iframe input is rejected without writing the previous
  top-document control.
- Pointer drag/selection and wheel work with remote DPR 2, page scale 1.5,
  contain-fit letterboxes and visual-viewport panning; a control remains usable
  after the pan. Tests exposed and fixed missing held-button state on drag and
  double-applied viewport offsets.
  Captured release outside the viewer and every button release in a mouse chord
  reach the owning remote document without retaining a pressed button.
- Address drafts remain local; HTTP(S) navigation, back, forward and reload are
  explicit. JavaScript addresses are rejected. Blur and target replacement
  discard unfinished local composition.
  Late composition values are tested both while blurred and after refocusing a
  replacement target; the stale-value regression failed before its fix.
  Address text such as reload/back/forward is rejected rather than interpreted
  as a toolbar command; this regression was observed failing before the fix.
- Synthetic composition cases cover final-input ordering before/after/no
  trailing event, cancellation, repeated identical characters and IME/229 Enter.
  Committed text arrives once and candidate confirmation does not submit the
  remote form; a later ordinary Enter does. These are not genuine OS IME tests.

Five focused input-lifecycle unit regressions cover pending focus guards across
target/document replacement, an unacknowledged held-key release, accepted text
followed by disconnect without retry, and unrelated frame/context changes versus
main-context destruction. Relevant existing controller/component tests also
passed during implementation. No full local Vitest suite or dev server was run.
The consumer SSR fixture covers both read-only and interactive rendering with
browser connections forbidden. Synthetic two-window UI screenshots were inspected.

The current Run exposes no authorized VNC or SSH desktop hosts, so genuine
macOS/Windows system-IME candidate placement and focus-transition receipts remain
unverified. The acceptance gate is retained. See [the interaction support matrix](interaction.md).

## Remaining compatibility boundaries

- Intended Browser Use endpoint: not probed by these fixtures. No provider
  Origin/TLS or hosted-client compatibility claim is made.
- GitHub Pages: the view-only receipt above does not establish an interactive
  demo or system IME compatibility. Okou Origin compatibility is unverified.
- Real Windows/macOS system IMEs: require genuine OS receipts; synthetic browser
  composition does not establish them. Clipboard transfer remains unimplemented.
- Other client browsers and remote CDP versions: require their own recorded
  capability probes before being advertised as supported.
- Two simultaneous streams of the same remote target: unverified; different
  windows/targets are the required multi-instance case validated here.

The full unit suite runs in the PR pipeline, following the user's instruction
against a full local Vitest run or local development server.
