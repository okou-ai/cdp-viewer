# Guarded adjacent-input experiment

This opt-in feasibility experiment compares the independently installed public
interactive viewer with a **test-only keys/committed-text executor** close to an
owned Chromium. It is outside the normal browser correctness suite. It does not
add a public adapter, server dependency, service or deployment to the library.

Run from the repository root using an immutable pushed source revision:

```sh
CDP_VIEWER_SOURCE_SHA=<full-40-character-sha> pnpm exec playwright test --config tests/experiments/playwright.config.ts
```

The prototype reuses this checkout's actual `InputSession`, `InputQueue`,
`InputLifecycle` and `CdpClient`; the command rejects a source/runtime mismatch.
The public consumer is independently installed with disabled lifecycle scripts
and a frozen reinstall, including public types, build and source SSR checks.
Output is `test-results/adjacent-input/**/measurements.json`. Keep dated results,
raw samples and acceptance decisions in PRs/issues, not this methodology guide.

## Topology and observation boundaries

The direct control uses the normal public `NativeInput` path. The prototype uses
a minimal stable local textarea and an explicit fixture intent channel, while
the public viewer streams read-only. Its actual input coordinator uses its own
short local CDP connection. Each participating window has an independently
admitted owner, input session, connection, queue and renderer.

Playwright intercepts the fixture channel in the test process; this is a shaped
topology experiment, not a network service. All client CDP messages, frames and
intent/reply traffic receive the configured one-way transit. Adjacent CDP remains
local. No history/guard/ack response is artificially held during measurements.
Separate real guard/reply holds establish sibling independence before timing.

Each profile uses three trials of five native Backspace down/up gestures and
twelve separate native committed-text events. Gestures are one animation frame
apart. One and two scoped viewers use the same owned browser URL and distinct
real windows; concurrent viewers run in separate client pages. An unscoped direct
control and unshaped profile expose unrelated costs and normal variation.
Viewport and JPEG70/max1920x1080 capture remain identical.

Local native event, remote DOM input, actual streamed canvas marker and client
acknowledgement times use the same host clock. The receipt includes every input's
latency, final-input-to-canvas time, first-input-to-all-acks time, outstanding
logical intent peak, executor active peak, native dispatches and membership
lookups. Direct lookup counts include independent target discovery. Concurrent
rows contain two observations per trial; they are not independent extra trials.
Intermediate frames may be coalesced, so final canvas feedback is measured
separately from all remote input effects. There is no physical-display timing.

## Admission, ordering and bounds

Only fixture-selected targets/windows are admitted. Each channel has an opaque
owner; it accepts validated keys or committed text with contiguous sequence and
confirmed acknowledgement progress. It never accepts a client-selected CDP
session or arbitrary method. The existing coordinator performs fresh scope checks
and native dispatch on its short connection. The channel sends acknowledgements
only after actual CDP replies, not merely on enqueue.

Both ends cap the complete unconfirmed intent window at 64. The executor checks
client confirmation against contiguous actual completions, so short-link replies
still in long-link transit cannot silently replenish credits. Local queued and
pending work retain the actual input queue's independent bounds. Invalid input,
overflow, ownership transitions, failure or disconnect revoke the admission and
discard unsent work; uncertain native effects are never replayed. This prototype
does not readmit a revoked channel. Cleanup closes only owned sessions and
connections; the fixture owns and tears down its browser and client profiles.

## Acknowledged keys/text retirement

An explicit fixture host reserves each target before asynchronous admission.
Each viewer still owns its independent CDP connection and input lane. The host
does not admit overlapping owners or treat an endpoint as a shared connection
pool. Client intent cannot choose a target or session.

Retirement immediately revokes admission and discards unsent work through the
actual input coordinator. It keeps the original connection until all dispatched
native writes and required original-session key releases have positive replies,
then waits for acknowledged detach. Repeated retirement shares the same result.
Only confirmed retirement releases the host reservation. A missing/rejected
reply, bounded cleanup deadline or CDP loss leaves the target unavailable; local
teardown never becomes proof of remote cleanup. No uncertain input is replayed
and no second connection attempts cleanup. The observer also bounds unconfirmed
native receipts during retirement. Emergency fixture close is not a handover
receipt.

The opt-in lifecycle cases in `handover.spec.ts` hold actual native replies while
two real windows hold modifiers. Fixture host commands report pause/unmount or
viewer-channel loss, and the sibling must continue native input and actual
streamed feedback. A lost viewer reply channel can still retire through live
CDP; losing CDP cannot confirm cleanup. A separate case actually moves a tab,
discards held old input, confirms original-owner release and admits a replacement
only after verifying the destination window. Late old continuations cannot
release its new acquisition. These are explicit fixture host lifecycle reports,
not integration with a shipping client adapter. They remain separate from timing
samples and ordinary correctness CI.

## Limits

This is keys/text stable-window feasibility, using a deliberately smaller local
adapter than `NativeInput`. It cannot establish complete local-adapter parity,
click/pointer/wheel/navigation/clipboard ordering or genuine OS composition.
Acknowledged cleanup and controlled tab-move handover cover keys/text only; a full
interaction and ownership evaluation remains necessary before adopting any public
adapter. A fresh local check and CDP send are still not atomic against arbitrary
external tab movement.

Opaque fixture admission is not production authentication or endpoint access
control. Public wire versioning, authorization, browser provisioning, recovery,
provider compatibility and operational cost require a separate integration
decision. Normal browser-side standard CDP remains unchanged. Small synthetic
trials establish neither production capacity, provider/OS compatibility, tail
latency nor uniform improvement on an unshaped local connection.
