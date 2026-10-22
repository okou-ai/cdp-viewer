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

Browser tests report individual durations in CI. Compare runs with the same
toolchain, worker policy and fixture setup, and distinguish test-case durations
from full job time. A slow case is not redundant when it covers a distinct
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

## Deterministic asynchronous tests

Hold and release actual protocol or event boundaries to test delayed work,
replacement and cancellation. Assert both the intended effect and the absence
of stale effects. Do not hide races with arbitrary sleeps, higher timeouts or
weaker assertions.

Performance correctness tests should verify bounds, ordering and required
synchronization. Keep latency measurements in separate reproducible probes.
Record conditions, samples and the measured boundary before claiming a gain;
do not turn one machine's timings into a universal threshold.

The opt-in [adjacent-input experiment](../tests/experiments/README.md) compares
guarded execution locations with an independently installed public consumer.
It is separate from the normal browser correctness suite; its narrow prototype
does not establish a shipping adapter's full interaction or ownership contract.

## Source and distribution checks

Validate the exact public source contract in an independently installed consumer.
Use an immutable pushed revision and a frozen lockfile. Disable dependency
lifecycle scripts so installation cannot conceal a missing distributed file or
an undocumented build requirement.

Verify public types, styles, host-provided peers, a production build and source
SSR without allocating browser resources. A local package can supplement these
checks before submission but must not silently replace actual GitHub source
installation as distribution evidence.

## Local checks and CI

Run checks appropriate to the change. Do not run the full local Vitest suite or
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
