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
| [Native transaction](../src/display/transaction.ts) | Prepare, dispatch, confirm presentation and recover using the original connection/session               |
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
native contents against the browser's outer window bounds. After a contents-size
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
