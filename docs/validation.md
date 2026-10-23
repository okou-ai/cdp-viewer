# Validation strategy

Choose checks from the changed contract and risk. Prefer behavior visible at a
public boundary over assertions that mirror private implementation details.
Use repository configuration as the source of truth for tool versions and
commands; report evidence for the exact revision that was tested.

## Test boundaries

- Model tests exercise transitions, derived state and independent instances.
- Protocol tests use controlled external endpoints to exercise ordering, errors,
  cancellation and cleanup through real adapters.
- Component tests exercise the public API, host isolation, committed lifetimes,
  accessibility and stable DOM ownership.
- Browser tests use owned browsers and bounded fixture servers to validate
  behavior that depends on actual rendering, focus and native events.
- Consumer checks install public exports independently to validate types,
  distribution, host dependencies, production builds and server rendering.
- Lint regressions exercise the actual repository configuration with ordinary
  accepted and rejected source patterns.

Keep fixtures synthetic and test-owned. Mock an external boundary when needed;
do not replace internal modules merely to make assertions easier. Cleanup must
release fixture resources even after failure and must not mutate an unowned
browser or external service.

## Browser captures and durations

Each browser invocation prepares and fully validates one independently installed
consumer before running cases. Global setup owns that immutable build and releases
it after the workers finish, including when a case fails. Individual spec files
serve the build on their own bounded HTTP servers; each case still owns its own
Chromium profiles and windows. The separate experiment configuration retains its
own consumer lifecycle.

CI partitions browser spec files across independent jobs while preserving each
file's execution order and worker policy. Each invocation owns its validated
consumer and failure diagnostics. The browser environment preinstalls matching
browser binaries and system dependencies; keep its image version aligned with the
project's Playwright dependency. Source checks run independently, and the aggregate
CI result requires the checks job and every browser shard to succeed.

CI performs the [source distribution gate](#source-and-distribution-checks) in
browser setup. The standalone consumer check has its own preparation and cleanup;
see [consumer verification](../CONTRIBUTING.md#consumer-verification) for commands
and source selection.

Browser tests report individual durations in CI. Compare runs with the same
toolchain, worker policy and fixture setup, and distinguish test-case durations
from the separately logged consumer setup duration, browser-step and full job
time. A slow case is not redundant when it covers a distinct
rendering or lifecycle contract.

Tab tests save manual-review PNGs only when explicitly requested:

```sh
CDP_VIEWER_CAPTURE_TAB_SCREENSHOTS=1 pnpm test:browser tests/browser/tabs.spec.ts
```

These files are visual review aids, without snapshot comparisons. Screenshots
used as pixel-assertion inputs remain unconditional. Validate correctness with
review captures disabled so their painting/font waits cannot supply incidental
synchronization; retain condition-based assertions for asynchronous behavior.
Failure traces remain available under the normal Playwright configuration.

## Concurrent viewers

Use installed public exports with one test-owned browser endpoint and distinct
real windows. Exercise sibling viewers in the same host page using the same
`cdpUrl` and different `windowId` values; cover separate client pages when
validating independent clients. Verify that frames and input reach the intended
window.

Hold one viewer at an actual protocol boundary and verify that the other makes
independent progress. Pause, disconnect and unmount one viewer while confirming
that the sibling continues streaming and accepting input. Check that cleanup
releases only the originating owner's resources and preserves the remote browser
and tabs.

Check transitions separately by moving a selected target between windows with
queued or held input and late results or cleanup. Stable-window concurrency
alone does not establish correctness during an in-flight window handover.

The opt-in [window capability probe](../tests/experiments/README.md#window-isolation-capability-probe)
distinguishes direct CDP sessions from installed public viewers. It provides
manual capability evidence outside default CI. Normal project regressions remain
in the browser and unit suites. Direct checks overlap text, keys and pointer
dispatch across windows and continue text input during another window's tab
activation. Public checks cover sibling wheel queues and separate-client
keyboard/text input. A held real reply establishes sibling input and painting
progress. A single host document's physical keyboard focus is separate from
these remote operation lanes.

Remove any automation framework's remote-page focus emulation before native
focus acceptance. The native-focus fixture inspects the owned default context
with `noDefaults: true`. A headed browser alone is insufficient: verify that
unselected tabs are not forced focused, and record DOM focus separately from
native window focus. Keep local client input focus separate from the remote
browser's focus when interpreting results.

Use the manual guide's explicit immutable-source and headed commands. Any
temporary display must belong to that invocation. Local JSON records the source,
browser, mode, window/target/session mapping and observed focus state. Virtual
X11 evidence does not establish physical macOS/Windows IME or a live provider's
event routing. Keep synthetic Browser Use window-following coverage distinct
from live service evidence.

## Deterministic asynchronous tests

Validate pure policy transitions with bounded event sequences as well as named
examples. Check lifecycle and ordering invariants across configuration changes,
unavailable observations, replacement and late outcomes. Assert semantic
decisions, retained intent and committed history rather than reproducing the
transition implementation as the expected-value calculation. A pure model test
does not establish native effects or presentation; retain public protocol and
installed-browser checks for those boundaries.

Hold and release actual protocol or event boundaries to test delayed work,
replacement and cancellation. Assert both the intended effect and the absence
of stale effects. Do not hide races with arbitrary sleeps, higher timeouts or
weaker assertions.

Performance correctness tests should verify bounds, ordering and required
synchronization. Keep latency measurements in separate reproducible probes.
Record conditions, samples and the measured boundary before claiming a gain;
do not turn one machine's timings into a universal threshold.

Capture freshness tests should verify that a sampled native clock boundary has
elapsed before restarting capture. Cover the first sub-millisecond static frame,
malformed or regressed clock proofs, stale/same-raster images and cancellation
while the native operation waits. Match the CI browser revision when investigating
native capture behavior; a successful resize acknowledgement alone does not
prove compatible presented pixels.

Cover density-only changes with an unchanged logical viewport at different native
DPR and zoom values. Withhold automatic resize frames, retain the stale pixels
barrier and require exactly one fresh capture to restore input. Ordinary logical
resizes and no-op reuse must retain their bounded native IO behavior.

For continuous input, measure first input to first changed canvas, changing-frame
gaps during the action, and final input to the corresponding final canvas. Record
actual native scroll distance alongside normalized outbound deltas, request count
and pending work. An acknowledgement or incoming frame packet does not prove
visible completion. Use natural frame delivery and actual renderer draws, with
fresh per-trial preparation and a scene whose scrolling changes visible pixels.
Label canvas-draw timing separately from physical-display presentation.

Compare exact source revisions under the same workload, capture and network
conditions. Establish equal remote work before comparing speed; a provider's
non-additive wheel conversion can change distance when events are coalesced.
Use independent direct-CDP controls to distinguish endpoint transformations from
the actual viewer path. Preserve failed samples, censored waits and outliers;
later successful samples do not explain earlier failures. Normal correctness
coverage should verify native default scrolling and streamed final position
without adding machine-specific latency assertions to CI.

Exercise original-owner admission through synchronous callbacks as well as
delayed replies. Retire or replace input while clearing clipboard/error state,
flushing a full queue and publishing deliberate focus/navigation transitions.
Assert no old-event write on the successor and confirm that a fresh event still
works. Clipboard capture/bubble and compatibility pointer/mouse events must keep
their original binding. A leading scheduler's pressure fixture must actually
retain a trailing sample at the held boundary; an already sent leading sample
cannot be cancelled retroactively.

Verify native send ordering at the controlled protocol wire. Chromium can
schedule wheel and keyboard DOM callbacks independently; check their remote
effects separately when ordered sends intentionally do not await acknowledgement.

The opt-in [adjacent-input experiment](../tests/experiments/README.md) compares
guarded execution locations with an independently installed public consumer.
It is separate from the normal browser correctness suite; its narrow prototype
does not establish a shipping adapter's full interaction or ownership contract.

## Source and distribution checks

Validate the exact public source contract in an independently installed consumer.
Use an immutable pushed revision and a frozen lockfile. Disable dependency
lifecycle scripts so installation cannot conceal a missing distributed file or
an undocumented build requirement.

Verify included source/CSS, public types, host-provided peers, an unchanged offline
frozen reinstall, a production build and source SSR without allocating browser
resources. Check README file links against the actual installed files: a link can
resolve in the checkout yet target a document omitted from the package. Supporting
guides outside the package use repository URLs; local links must stay inside the
package and resolve to files. The consumer check covers ordinary inline file links,
not arbitrary Markdown syntax, anchors or external HTTP availability.

A local package can supplement these checks before submission but must not
silently replace actual GitHub source installation as distribution evidence.
The [consumer fixture](../scripts/consumer.mjs) defines baseline versions and
records source identity, the generated lockfile hash and completed checks in its
receipt; application repositories commit their own consumer lockfiles.

## Local checks and CI

Use the [developer checklist](../CONTRIBUTING.md#checks) for commands and choose
checks appropriate to the change. Do not run the full local Vitest suite or
start a development server unless explicitly requested. Use focused regressions
for local debugging; the PR pipeline owns broad unit and browser checks.
Formatting and link checks are sufficient for documentation-only changes.

Keep formatting, lint, types, dependency analysis, generated-file consistency
and applicable builds enabled. Diagnose failures in the responsible source,
fixture or environment rather than weakening the check or blindly rerunning it.

## Evidence and compatibility claims

Bind results to the tested source and environment. Separate local checks, source
CI, deployed-origin checks and native-platform validation. A lower-level or
synthetic check does not establish compatibility at a different boundary.

Keep revision-specific results, benchmarks and receipts in PRs, issues or CI
artifacts. State limitations in the relevant user guide. Do not place historical
test counts, one-off timings or delivery logs in engineering documentation.

Never record endpoint credentials, personal content or unredacted traces in
test output. Retain only the sanitized evidence needed to assess the result.
