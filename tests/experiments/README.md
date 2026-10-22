# Manual browser experiments

These opt-in experiments run through explicit configurations, outside the normal
browser correctness suite and default CI.

## Window isolation capability probe

Verify one owned browser endpoint with two real windows using direct CDP and
installed public viewers. This checks key/text/pointer routing, text during
bidirectional tab activation, and sibling input/pixel progress while one real
reply is held. It is separate from the guarded executor experiments below.

Run from the repository root with an immutable pushed source revision:

```sh
CDP_VIEWER_SOURCE_SHA=<full-40-character-sha> pnpm exec playwright test --config tests/experiments/window-isolation.config.ts
```

The manual config reuses the normal consumer setup and browser settings. It
selects only `windows.spec.ts`, retains the normal case timeout and writes local
synthetic `test-results/window-isolation/**/window-isolation.json` receipts.
The default CI does not run these scenarios or upload their receipts.

For native foreground/activation validation, use the direct scenario headed.
On Linux, with Xvfb and Openbox installed, own the temporary display and window
manager for this invocation:

```sh
CDP_VIEWER_SOURCE_SHA=<full-40-character-sha> xvfb-run -a sh -c '
  openbox >/dev/null 2>&1 &
  pnpm exec playwright test --config tests/experiments/window-isolation.config.ts --headed --grep "cdp sessions"
'
```

The remote browser uses its default context with `noDefaults: true` so Playwright
does not force page focus. Record native window focus separately from selected
tabs and DOM focus. Virtual X11 evidence does not establish physical
macOS/Windows input/IME or live Browser Use service routing. Keep dated findings
and environment-specific conclusions in issues/PRs, not this guide.

## Guarded adjacent-input experiment

This opt-in evaluation compares the independently installed public interactive
viewer with test-only executors close to an owned Chromium: the narrow
keys/committed-text comparator, an actual NativeInput pointer/keyboard experiment,
and an explicit generation-bound composition/lifetime mode. It is outside the normal browser correctness suite. It does not
add a public adapter, server dependency, service or deployment to the library.

Run from the repository root using an immutable pushed source revision:

```sh
CDP_VIEWER_SOURCE_SHA=<full-40-character-sha> pnpm exec playwright test --config tests/experiments/playwright.config.ts
```

The prototype reuses this checkout's actual `InputSession`, `InputQueue`,
`InputLifecycle` and `CdpClient`; the command rejects a source/runtime mismatch.
The public consumer is independently installed with disabled lifecycle scripts
and a frozen reinstall, including public types, build and source SSR checks.
Output is `test-results/adjacent-input/**/measurements.json` or
`native-measurements.json`. Keep dated results,
raw samples and acceptance decisions in PRs/issues, not this methodology guide.

## Keys/text topology and observation boundaries

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

## Actual NativeInput pointer/keyboard batches

Select `native-input.spec.ts` with the same config/source command to run this
increment separately. Both paths use the actual NativeInput DOM adapter. The
direct path uses the installed public interactive viewer; the candidate bundles
the source-matched private DOM adapter as a test-only entry and mounts it on the
installed read-only viewer canvas with a stable textarea. No private export is
added to the package. Only the adapter's type dependency is narrowed to an
internal port; ordinary production calls and scheduling remain unchanged.

The candidate admits validated key/text/pointer batches of at most 16 actions.
Opaque owner, contiguous batch sequence and client-confirmed completions bound
the whole unconfirmed window to 64 logical actions. The existing input queue
retains its independent capacity, including completion fences; 64 is a ceiling,
not a promise that every such burst can be accepted. Overflow revokes without
replay. Queued moves and wheels may coalesce. A receipt therefore completes a
whole logical batch after an owner-bound cancellable queue fence and actual
native replies, rather than assigning one native reply to every intent. Fences
are real candidate overhead; they do not change the normal direct send lane.

The pointer/keyboard mode verifies click/type ordering, Tab/focus, actual drag selection
and sibling DOM/canvas progress while actual guard/reply boundaries are held. Retirement still uses
the original connection's native/release/detach receipts. Local blur closes this
fixture admission; it does not implement nonterminal focus recovery. Optional
remote caret placement metadata is not queried by the candidate port and cannot
authorize input. Composition and selection/copy operations are explicitly
unavailable; local browser clipboard gesture parity and navigation are unproved.

Matched measurements use three trials of immediate click/type and a 300 CSS-pixel
scroll for one viewer and two concurrent viewers, on one browser URL and distinct
windows. Both 0/50ms one-way profiles preserve capture defaults; candidate CDP is
local and all viewer/client intent/reply traffic is shaped. Synthetic DOM effects
and an actual streamed document marker use the common host clock. Click/type
changes its color; scrolling moves an already painted marker by 300 CSS pixels
and verifies both its new position and the cleared old position. Each trial has
a distinct expected color and position, preventing stale-frame acceptance.
Compositor scrolling and main-thread scroll events are measured independently;
post-scroll application repaint latency is outside this marker's proof. Direct
command counts include any discovery/metadata work inside the sampled interval.
Logical
batch acknowledgements, coalescing and extra guard/fence work are not hidden as
one-intent/one-write results. Keep raw observations and any regressions or
variation in the PR. These checks establish this pointer/keyboard increment,
not complete native-adapter parity or an adoption decision.

## Composition and nonterminal ownership

The same actual NativeInput bundle also supports an explicitly admitted
composition mode. It carries bounded preedit/commit actions and opaque generation
tags alongside the original key/text/pointer intents. The server binds each tag
to the actual immutable InputSession document/focus owner; no client can choose a
CDP target or session. Each generation has its own contiguous batch/confirmation
credit. Old-generation effects and replies cannot replenish or acquire a new
generation's authority.

Local blur immediately discards unsent work and invalidates the client token.
Remote semantic transitions also suspend admission and reset the same stable
textarea's local composition. The server uses the existing current-owner queue
completion fence to join preceding jobs, including late original-document
preedit cancellation, then waits for original native/release receipts. Only a
still-current owner with positive completion publishes ready. A reply already
crossing the link after local blur is discarded without revoking a future owner.
Missing cleanup replies have a bounded deadline; native rejection, scope loss or
uncertainty revokes without replay. Only a definite unsupported IME method retains
the actual session's existing final-text fallback before IME has been accepted.
A rejected cancellation after an accepted preedit cannot count as successful
cleanup or fallback.

Composition retirement makes external admission terminal first, while retaining
the original session and document-event observation through the completion join.
It then confirms original cleanup, disposes with the requested stop reason and
confirms detach. An early native-map snapshot is insufficient because an old
preedit's finally continuation can send a later cancellation. No auxiliary cleanup
connection or production queue policy is introduced, and unknown retirement
keeps its reservation unavailable.

The owned-browser cases use synthetic local composition events with actual
Chromium preedit/commit/cancellation, native focus and streamed pixels. They cover
commit-once, blur/resume on the same proxy, a real document replacement with stale
trailing composition, held client intent/reply ordering and original retirement
while another window edits/streams. Controlled-wire cases separately withhold the
last late cancellation receipt and verify that ready/detach/readmission cannot
precede it. Synthetic events do not establish genuine OS IME. The full-adapter
recovery scenarios below combine these boundaries. Existing pointer/key timing
profiles do not measure composition latency or production capacity.

## Trusted clipboard and navigation

The generation mode extends the same ordered batches with bounded selection and
allowlisted back/forward/reload/address actions. They share the existing action
credit and queue capacity; navigation must be last in its batch. Composition-mode
messages have a 512 Ki serialized-character ceiling, and packing accounts for
JSON escaping so one supported 64 Ki-character text action fits while large
bursts split into bounded messages. The legacy message limits stay unchanged.
Selection uses
the actual owner-bound InputSession reader, including its focused-chain snapshot,
second validation, size/protected-control/frame limits and original object release.
Results carry the captured generation and a monotonic request ID. The client
retains one latest pending read with a bounded deadline and discards superseded,
blurred or old-generation results. A delayed clipboard reset names the last
request already processed, so an earlier edit cannot cancel a newer copy.

The real NativeClipboard starts its deferred ClipboardItem write in the original
trusted local gesture before requesting remote text. Its errors and readonly
native-copy recovery are rendered by private fixture controls outside the input
stage. Feedback and recovery float over the layout so clearing an error during
pointer movement cannot move the canvas beneath that gesture. No second
clipboard implementation or permission grant is used. Owned
Chromium exercises native Unicode copy/paste, empty/protected/opaque selections,
old results crossing blur and real clipboard-write policy denial. The activation
case holds an external reply at the native socket and releases it through CDP
with userGesture:false after observing actual activation expiry. Its public frame
connection is native and unshaped, so Playwright response delivery cannot supply
activation. That case supplies correctness evidence, not a shaped timing sample.

Navigation calls the actual InputSession after validating the local address.
It flushes bounded earlier local actions and immediately invalidates client
admission. Transition completion is enqueued in the next microtask, after the
session has synchronously appended its navigation barrier; readiness therefore
joins navigation and original cleanup rather than preceding the command. No
uncertain command is replayed. Generation-tagged history metadata cannot replace
an active local address draft. The same native proxy survives same-document,
full-document, history/reload and retained-context HTTP-204 outcomes. Owned cases
verify actual DOM/canvas feedback, local toolbar/host focus and F8 exit; direct
context assertions avoid waiting for a commit that HTTP 204 forbids.
Navigation buttons preserve input focus through their native press/click so an
earlier blur cannot disable the gesture or discard its navigation. They move
focus locally after navigation has flushed and invalidated the old admission.

## Full-adapter recovery and moved-target handover

`native-fixture.ts` shares the actual NativeInput/NativeComposition/NativeClipboard
bundle, independently installed consumer, owned targets and pixel assertions
between `native-input.spec.ts` and `recovery.spec.ts`. Select either spec with the
same explicit source/configuration command. The recovery cases write synthetic
`recovery.json` receipts with checkout/source/consumer/browser/capture identity.
They are correctness evidence, separate from the matched timing profiles.

The recovery cases combine pointer, committed text, transient composition,
trusted local clipboard and navigation with Shift/Control acquisitions in two
real windows on one browser URL. Blur resumes the same proxy only after original
cleanup; explicit fixture pause/unmount and private viewer-channel loss retire
the original executor before a fresh client can be admitted. Sibling input and
actual newly painted canvas effects must continue while an original native reply
is held. Host lifecycle reports are fixture commands, not a shipping adapter.

Real selected tabs move through the owned extension while composition or
navigation receipts and a client selection result are held. Terminal admission
discards old work before cleanup. The trusted new-owner completion fence is a
no-op that joins the original lane; it does not require the target to remain in
its former window. External intent stays denied throughout retirement, and the
replacement must independently verify its destination before attaching.
Original native writes, composition cancellations, key/button releases and detach
must all receive positive replies. Navigation writes participate in the same
receipt accounting, so losing ownership cannot hide a rejected navigation reply.
Late old results/releases cannot acquire or clean up a replacement owner.

Controlled-wire mixed-interaction cases complement these real-effect cases with
partial/rejected/lost replies, discarded queued barriers and the shared 64-action
unconfirmed ceiling. CDP loss or emergency executor teardown preserves the
same-host target reservation: opening a fresh connection/host is not a recovery
receipt. A live independent sibling remains usable. Reconnection of the original
target is evaluated only after positive original retirement. Missing cleanup
remains denied; no uncertain input or navigation is replayed.

Client batch credit requires a matching pending sequence and an explicit
successful acknowledgement. A partial reply without its success field revokes
the client instead of confirming work or replenishing that credit.
Original native cleanup likewise requires an explicit CDP result object; an
ID-only reply cannot confirm retirement or release the target reservation.

## Limits

The keys/text comparator uses a deliberately smaller local adapter than
`NativeInput`. The actual-adapter modes exercise pointer/key, composition,
clipboard and navigation in their owned fixture cases. They do not establish
complete local-adapter parity or genuine OS composition.
Controlled-wire and owned-browser recovery cover only the exercised interactions,
failure boundaries and real-tab handovers. A combined performance, authentication,
isolation, wire-version, provider and operational-cost assessment remains necessary
before adopting any public adapter. A fresh local check and CDP send are still not
atomic against arbitrary external tab movement.

Opaque fixture admission is not production authentication or endpoint access
control. Public wire versioning, authorization, browser provisioning, recovery,
provider compatibility and operational cost require a separate integration
decision. Normal browser-side standard CDP remains unchanged. Small synthetic
trials establish neither production capacity, provider/OS compatibility, tail
latency nor uniform improvement on an unshaped local connection.
