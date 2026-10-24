# Display architecture

Display adaptation coordinates native browser sizing, capture and input geometry
without acquiring another viewer's authority. It follows the shared
[state and resource boundaries](state-architecture.md). Consumer controls and
interaction instructions belong in the [demo guide](../demo/README.md).

## Responsibilities and dependencies

| Owner                                               | Responsibility                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Policy](../src/display/policy.ts)                  | Pure transitions for connection mode, observations, explicit intent, execution stage and window history |
| [Synchronizer](../src/display/sync.ts)              | Bridge policy to one selected-session executor; own bounded, coalesced scheduling                       |
| [Native preparation](../src/display/preparation.ts) | Own selected-window calibration and acquire coherent native/runtime/layout snapshots                    |
| [Native transaction](../src/display/transaction.ts) | Dispatch, confirm presentation and recover using the original connection/session                        |
| [Session viewport](../src/display/viewport.ts)      | Own calibrated, acknowledged, decoded and painted geometry facts and immutable input mappings           |
| [Geometry functions](../src/display/geometry.ts)    | Calculate native sizing and projection without acquiring resources                                      |
| [Viewer controller](../src/viewer/controller.ts)    | Own target/session lifetime, capture transitions and frame acknowledgement                              |

Policy acquires no native or DOM resources. Target, configuration, measurement
and transaction outcomes enter its one transition contract. Selected-session
success and connection-window history have distinct lifetimes; native applied-key
receipts belong to the selected transaction. DOM observation and the effective
host/menu mode remain in the runtime/model layers.

## Transaction and scheduling ownership

Preparation, dispatch, presentation and recovery report explicit stages and
outcomes. Preparation consumes observations before returning its outcome;
observations arriving afterward remain pending. Revalidate intent and native
geometry after asynchronous read/capture boundaries. Retired facts cannot
authorize a write; retain the current request for recomputation through the same
bounded scheduler.

Dispatch captures immutable native payloads while later measurements coalesce
independently. Progress must not require a quiet interval. Reusing an already
compatible presentation and completing a newly painted write enter the same
policy completion transition. Retired or failed results cannot commit window
history or acquire a replacement's authority.

## Geometry and presentation authority

Each selected session shares one geometry owner across adaptation, capture and
input. Native calibration, acknowledged transforms and painted facts have
distinct meanings. Input consumes an immutable mapping rather than deriving
separate density/zoom formulas. Invalidations retire earlier reads and paint
callbacks without changing native input ownership.

The geometry owner distinguishes calibration, writing, awaiting presentation,
presented and uncertain adaptation. Starting a write retires its pointer mapping.
A definite rejection can restore previous acknowledged units; an unconfirmed
outcome keeps them unknown. Application or rollback requires compatible metadata
and actual decoded raster dimensions followed by successful drawing. The renderer
rejects obsolete or incompatible images before changing the canvas. Native
acknowledgements alone cannot finish a transaction or authorize fresh-layout
fallback over old visible pixels.

Native contents sizing and compositor dimensions are separate rounding
boundaries. Before its first emulation write, the selected transaction calibrates
the current decoded frame's native device extent against the browser's outer window
bounds. Initial page layout may already be emulated and cannot substitute for
that native frame. An unavailable first frame waits within the geometry owner's
existing single settlement slot and deadline, without polling or another waiter.
Native structural observations have an immutable identity separate from input
and paint revisions. A changed metadata extent retires preparation immediately,
before asynchronous decoding; only that observation's accepted decode can make
it usable for calibration. An older decode cannot validate a newer observation.
Identical-sized animation frames retain the accepted identity without requiring
a quiet period. Capture invalidation retires both metadata and decode authority.
The native observation owner exposes one immutable snapshot containing accepted
frame evidence and a validity check over its observation identity and geometry
revision. Decode acceptance changes pending evidence into accepted evidence
without replacing that structural identity. The selected preparation owner reads
window, runtime and layout against that snapshot. It retains a frame/window reference only while that pair is
current, independently of later layout reads. A stable move in an unscoped viewer
replaces the old window's reference using accepted native facts and observed bounds;
an unavailable new-window frame uses the same bounded native waiter. Scoped
membership and mid-operation window identity checks still apply. The transaction
revalidates its snapshot after capture preparation and before the first write.

Frame metadata has no window identity. Reference acquisition progresses through
unbound, observed-window, captured-window and verified-calibration phases in one
selected preparation owner. First and changed-window acquisition share that path.
The observed window retains its identity and outer extent; the captured phase
adds the receipt returned by the existing serialized native-only refresh after
its confirmed elapsed-clock boundary. An accepted frame records that same local
capture receipt. It is an association with a capture boundary, not a remote
window identifier or a globally atomic generation. Native-only fencing preserves
the current painted/input receipt.

One synchronous confirmation boundary may install verified calibration. It
checks the selected owner and original attempt, scope/normal window state,
confirming identity/extent, snapshot freshness and accepted frame/capture
association together. An observed identity/extent change starts acquisition for
that observation; delayed metadata cannot bind an earlier extent to later bounds.
Failure retires unfinished acquisition, so a late provisional reply cannot
install calibration after a sibling read has failed. Calibration verified before
that failure retains its separate lifetime. Creating the operation snapshot still
requires all concurrent reads and current snapshot evidence. Verified calibration
continues translating subsequent same-window bounds and own writes without a
new capture. Independent hidden geometry changes between native reads are not atomic.
Missing post-fence frames and failed capture, clock or provisional window
confirmation remain bounded failures; explicit retry acquires a new capture.

Suspend new display transactions during image recovery while joining original
native work under its original owner. Retain valid applied native adaptation
instead of detaching its session to retry an image.
Cancel image waiters against the halted capture, including waiters registered
after a delayed start reply. Original native effects still settle independently.
Capture retry uses the same
serialized stop/start and elapsed native-clock boundary as presentation fencing;
it cannot replace missing proof with a local generation or an older frame. Resume
queued display intent after current image readiness, preserving the latest
measurement and preferences after the retry's capture lane is released, even
when paint arrives before its start receipt. A failed initial/live operation
interrupted by image loss may resume once; already completed work is not replayed
merely because the image recovered.
The image-recovery policy distinguishes a usable current image from a released
capture lane. Its runtime coordinator consumes either arrival order through one
readiness reconciliation. Current input may resume before the start reply, while
display capture work still waits for lane release. Native receipt certainty stays
with the original capture resource rather than the visible streaming status.
Another observed window change restarts rebinding for that destination. Initial
acquisition adds one verification restart on the same capture lane. Same-window
preparations with an established reference and no-op reuse do not gain a capture
restart or a new waiter.
Under emulation, a native window move can change compositor dimensions without
a page resize event. The previous presentation can reject that new-size frame
from painting while its decoded native metadata remains a calibration fact.
Painted geometry alone still authorizes presentation and input; native calibration
does not make rejected pixels usable. Acknowledged effects bind the dispatched
projection and actual native presentation in one immutable receipt. Presentation
consumes that receipt as a unit; only matching painted pixels complete it and
allow its reuse. Preparation expires when own writes start, while verified native
calibration survives those writes within the same selected window.
After a contents-size
acknowledgement it reads and verifies that same window again, translating the
contents by the observed outer-bounds delta. Presentation and no-op reuse use
that native result rather than the requested integral DIP. Frame metadata and
decoded-pixel tolerances remain unchanged; input still follows painted geometry.
This constant-size reference belongs to one selected session and window. It must
not be initialized from an already emulated layout or transferred to another
selection. The translation assumes stable native window chrome; an incompatible
content extent still cannot complete presentation. There is one additional
browser-window read per native sizing operation and no per-frame read.

Density changes with an unchanged logical viewport, same-raster transitions and
rollback also need causal capture evidence. Compare the current logical viewport
under both the previous and projected scale; different native dimensions alone
do not guarantee a new static capture frame. Fence decisions retain pre-write
observations until the acknowledged native extent is known, including when
distinct requested sizes round to the same actual image.
Capture bounds can also collapse distinct native sizes to identical decoded
rasters, so freshness decisions must include the active image bounds.
After acknowledged writes, the native executor establishes an elapsed timestamp
fence in a private isolated world while the controller restarts the same bounded
stream. The geometry owner rejects pre-fence images. Timing details and the
static-image regression rationale belong beside the native transaction's fence
implementation. Capture timestamps order images; they do not identify an
adaptation generation or make native sizing, emulation and painting atomic.

## Recovery and cleanup

Presentation waits share the bounded request/stream budget and retire with their
selected session. Target-size metadata with an incompatible decoded raster can
request one fenced capture refresh during presentation. Decoded facts can
diagnose the mismatch before or after the final acknowledgement; only painted
facts complete presentation. Invalidations retire both. Conditional recovery
uses the remaining presentation wait instead of starting a new full budget;
capture effects retain bounded request deadlines and their serialized owner.
Ordinary distinct-size updates need no per-frame clock reads, React updates or
extra capture refreshes.

Capture restoration preserves the previous policy, distinguishes a rejected stop
from uncertain stop/start, and confirms a stopped stream before repeating a
possible start. Every continuation revalidates its selected-session owner. Do not
replay uncertain input or move effects onto a replacement connection/session.

New pointer gestures remain suspended while their mapping is unavailable. Text,
native keys and release of already-owned buttons retain their input ownership;
see [input lifecycle architecture](input-lifecycle.md). A connecting backdrop is
only a presentation fact and grants no geometry or input authority.

## Validation boundary

Pure transition checks establish policy decisions and scheduling invariants.
Protocol checks hold actual asynchronous boundaries to expose stale reads,
uncertain effects and cleanup. Installed-browser checks establish decoded raster,
paint and input-mapping behavior. None alone proves a live provider's native
window policy. Follow the [validation strategy](validation.md) and keep dated
regression results in issue/PR/CI evidence.
