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
Backend startup waits for the owned Chromium port file to publish both endpoint
lines. Native file notifications are registered before reading; cancellation is
bounded, and other filesystem errors remain visible. Five native-filesystem cases
cover existing, later and partial publication, cancellation and IO errors.

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

### Demo interaction integration

On 2026-10-21, all seven production-demo Playwright scenarios passed locally
with Node 24.22.0, pnpm 12.14.0, Playwright 1.64.1 and client/backend Chromium
156.0.8078.4. The new interaction scenario failed on the previous view-only
build because its native input proxy was absent, then passed after the demo
enabled the existing public interaction option.

Two test-owned windows receive their own native text, including Unicode.
F8 releases remote keyboard focus; connection/address drafts stay local.
Removing one panel leaves its remote tab open and the remaining panel accepts
new text at a 390px viewport width. Go, back, forward and reload operate on that
panel's actual remote page. Reload checks await the new load before reading
its execution context. Desktop and narrow connected screenshots were inspected.
The existing six connection/scope/cleanup/mobile/Origin scenarios also passed.

These are local production-fixture results. Their sanitized receipt identifies
`local-production-fixture`, source marker `local`, browser versions and tested
capability booleans; it contains no endpoints or input content. The Pages smoke
workflow runs the same test on the real deployed Origin after an authorized
main rollout, where its receipt must identify `actual-pages-deployment` and the
deployed source SHA. The earlier view-only Pages receipt remains historical
viewing evidence. This integration adds no physical system-IME, clipboard,
focused-frame typing or other-provider validation.

## Interaction validation

On 2026-10-20/21, eight focused interaction Playwright scenarios passed with Node
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
- Hash and history changes release held Shift and mouse input in the retained
  document and allow input recovery. The missing key-up was reproduced in owned
  Chromium before repair; loading-start alone must not discard that ownership.
- Navigation returning HTTP 204 retains the original document and releases held
  Shift and mouse input. Its key-up regression failed before repair. Recovery
  uses real input; the fixture reads the retained execution context because
  locator navigation auto-wait would wait for a commit that 204 forbids.
- Local Tab navigation skips the inactive proxy while paused or after an error;
  resuming streaming keeps the same textarea and restores remote typing. The
  pause regression failed in owned Chromium before repair.

Twenty-three focused input-lifecycle unit cases cover pending focus guards across
target/document replacement, an unacknowledged held-key release, accepted text
followed by disconnect without retry, and unrelated frame/context changes versus
main-context destruction. Rejected key-up and blur before key-up acknowledgement
retain original-session release cleanup; the rejection regression failed before
its fix. Same-document navigation also covers owned key/button release after an
ambiguous loading-start event; it failed before repair. Cross-document/history
navigation starts, captured old owners, queue saturation/recovery and late focus
objects are also covered. Six Runtime ownership cases cover separate result and
exception handles for both evaluation and focus-guard calls while current, after
blur and after timeout. All six failed before the executor cleanup repair; a
native Chromium probe confirmed that even by-value exceptions produce two
distinct handles. Recovery sends only new input, without replaying failed work.
Twenty-five state cases cover transition policy,
cross-session token isolation, stale acknowledgements, composition ordering and
cancellation; one case explores all 81 four-event press/acknowledge/cancel
sequences. The four focused lifecycle/state/component/controller files passed
64 cases after the Runtime cleanup repair. No full local Vitest suite or dev server was run.
The consumer SSR fixture covers both read-only and interactive rendering with
browser connections forbidden. Synthetic two-window UI screenshots were inspected.
Seven focused component cases include local keyboard traversal during connection,
pause, error and disconnect. All four inactive-state cases failed before the
proxy's availability fix.

The initial delivery recorded no authorized VNC or SSH desktop hosts. This
refactor did not perform physical OS validation; genuine macOS/Windows system-IME
candidate placement and focus-transition receipts remain unverified. The
acceptance gate is retained. See [the interaction support matrix](interaction.md).

## Input latency validation

On 2026-10-21, owned Chromium 156.0.8078.4 fixtures compared the input path before
and after hover supersession, preflight text collection and nonblocking optional
caret reads. Node 24.22.0, pnpm 12.14.0 and Playwright 1.64.1 used the current
public-source tarball consumer, with scripts disabled and React 19.2.6. Each
configuration has three trials; each trial types five letters 80ms apart.

The probe adds 50ms to each WebSocket transit direction, for 100ms simulated RTT.
Times below are medians from the local native event to actual remote DOM input,
excluding screenshot return/paint. They do not measure a user's network or the
deployed Pages app.

| Configuration    | Click before / after | Typed character before / after |
| ---------------- | -------------------: | -----------------------------: |
| No window filter |        589ms / 379ms |                  255ms / 159ms |
| With windowId    |        902ms / 592ms |                  420ms / 251ms |

Click medians improved 35.7% and 34.4%; sustained-typing medians improved 37.6%
and 40.2%. Unscoped click samples ranged from 376ms to 606ms, and scoped clicks
from 591ms to 592ms. An already-dispatched hover still has to settle. Initial
focus/window checks and input acknowledgements remain on the remote path;
collecting continuous text does not remove the first character's focus-check
round trip or promise the official viewer's shorter ordinary input path.

Twelve deterministic cases cover pending-hover supersession with drag movement,
collecting text during focus/window checks, sealing a sent payload, intervening
keys, text bounds/cancellation, and bounded/stale optional caret work. Four
initial regression cases failed before the fix. Two public-consumer browser
cases hold an actual focus-guard response and verify one native text batch plus
subsequent deletion/text order, with and without window scope. Both failed
against source `7a52d7b5777cb3d86bc6d2404c41a0f19f3186fd` with separate `a` / `bc`
writes, then passed with collection during preflight. CI assertions use explicit
protocol synchronization rather than tight wall-clock budgets.

All ten focused interaction scenarios passed on the optimized local source,
including existing pointer DPR/scale/pan, composition, navigation, owner cleanup
and independent-viewer behavior. These results add no genuine system-IME,
focused-frame, clipboard, provider or deployed-Origin compatibility claim.

## Whole-viewer performance validation

On 2026-10-21, a second audit measured main source
`386a0ab72ea9c9857c59a050ecbe9997b8a323b2` against the subsequent performance
changes, using the same owned Chromium 156.0.8078.4 and independently installed
public-source consumer. It compared the currently deployed Browser Use live
viewer, whose page asset SHA-256 was
`55b2aa5d0efc99ff25b51d3944b75787fc9541bd6613a638271b2027f1a571b5`.

The input probe again adds 100ms RTT, uses three click trials and fifteen typed
characters at 80ms spacing, and measures actual remote DOM delivery rather than
returned pixels. A wheel burst sends twenty synthetic DOM events over twenty
animation frames, totaling 240 CSS pixels. Completion requires all scroll delta
to be transmitted, so a temporary gap between proxy response and client receipt
cannot falsely establish an empty input queue.

| Configuration    | Click before / after | Character before / after | Last wheel delivery after burst before / after |
| ---------------- | -------------------: | -----------------------: | ---------------------------------------------: |
| No window filter |        375ms / 164ms |            161ms / 160ms |                                  3921ms / 84ms |
| With windowId    |        587ms / 372ms |            252ms / 161ms |                                 6200ms / 291ms |

Click medians improved 56.3% and 36.6%; scoped character latency improved 36.1%,
while unscoped typing remained similar. All 240 wheel-delta units were retained,
with 20 dispatches reduced to 4 and 3 respectively. These improvements come from
painted-frame viewport metadata, overlapping independent scope/read preparation
and combining compatible pending wheel work. Required scope/focus checks and
ordered input acknowledgements remain; the official direct-forwarding path still
has lower ordinary input latency (about 54–60ms in the comparison).

First-frame receipt after the first CDP command improved from 771ms to 564ms
unscoped, and from 998ms to 759ms scoped, by overlapping stream and input setup.
These are single connection samples, not startup percentiles or physical paint
latency. Interactive availability still waits for both initialization and paint.

A separate conversion microbenchmark used fifteen iterations per path, discarding
the first three. Native base64 conversion of a deliberately high-entropy
1920x1080 JPEG (1,049,008 bytes) took a median 1.3ms versus 56.1ms with
`atob`/callback-based conversion in the same run. The baseline run measured
54.85ms versus 1.2ms. JPEG decoding remains separate, around 21–23ms; a typical
11,502-byte editor frame needed only about 0.6ms for the old conversion. This is
a CPU stress case, not a claim that every page saves 55ms. Older clients use a
portable byte loop; both paths verify identical bytes, and the fallback painted
actual JPEGs in the public-consumer browser test.

Deterministic regressions cover painted versus arriving geometry, missing/invalid
metadata, resize/document invalidation and late paints, scope/read overlap with
no early writes, late-handle cleanup after failed scope, wheel distance/barriers,
sent-payload immutability and finite bounds, startup overlap/readiness, and
independent visibility/explicit pause. Six initial protocol regression cases and
three component/conversion cases failed on the previous implementation.

All sixteen focused interaction/viewer browser scenarios passed, including
dynamic viewport resize/page scale, a held real wheel acknowledgement, real
offscreen pause/resume, independent panel painting and the existing
DPR/contain/drag/pan/composition/navigation ownership cases. Frame metadata was
also cross-checked against fresh CSS viewport metrics at DPR 1/2, page scale 1.5,
and portrait dimensions; fractional rounding differed by less than 0.001 CSS px.
CI assertions use protocol/event boundaries, not tight wall-clock thresholds.

The audit retained fixed JPEG quality/resolution, per-instance sockets and fresh
target discovery: there is no representative quality/bandwidth evidence for an
adaptive transport or mandatory provider mechanism. Offscreen surfaces release
only their owned stream/session through existing pause semantics. No full local
Vitest suite, development server, physical OS IME, provider or deployed-Origin
compatibility claim is added by these measurements.

## State architecture validation

On 2026-10-21, the strict React/ccstate migration passed 69 real-config lint
regressions and 26 focused cases across the model, component, controller and
Canvas test files. Coverage includes independent drafts and reconnect revisions,
stale runtime unbinding, valid zero window IDs, invalid applied settings,
monotonic panel identities, host ccstate isolation, Strict Mode cleanup,
callback-only updates and stable native textarea nodes.

Seven owned Chromium 156.0.8078.4 scenarios passed through the production demo
and the explicitly packed public-source consumer: independent-window input and
navigation, explicit apply/reconnect/removal, invalid drafts retaining a live
connection, local toolbar focus, composition committing once, and moving a real
tab between window scopes. There was no development server or full local Vitest
run. Broad unit/browser checks remain owned by the PR pipeline.

The independent tarball consumer passed with pnpm 10.33.4 and React 19.2.6,
including source types/CSS, disabled lifecycle scripts, frozen offline reinstall,
production build and bundled SSR without WebSocket construction. This local
receipt does not establish installation from the submitted GitHub SHA; CI runs
that separately. Formatting, strict lint/types, dependency analysis, CSS
consistency and library/demo builds also passed.

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
