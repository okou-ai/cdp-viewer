# State and React boundaries

Keep state ownership, presentation and external resources separate. Views read
projections and dispatch commands; models express state transitions; runtime
adapters connect committed UI lifetimes to external resources.

## Layers

| Layer                | Responsibility                                                |
| -------------------- | ------------------------------------------------------------- |
| Instance entry       | Construct an independent Store and signal graph               |
| Model                | Own private writable state, computed projections and commands |
| Private React bridge | Provide instance context, subscriptions and bound commands    |
| View                 | Render projections and dispatch commands from event handlers  |
| Runtime adapter      | Own DOM references, external resources and cleanup            |

Keep dependency direction explicit. Models must not depend on React or acquire
DOM resources. Views must not reach through their model to control a transport.
The bridge and runtime adapters follow the same ownership checks as every other
file. Their names and locations grant no lint privileges.

## Instance ownership

Allocate a fresh Store and graph for each instance. Share immutable context
metadata or pure definitions, not mutable models, active resources or an implicit
global registry. The host application's state provider must remain independent
of library state.

Bootstrap allocation must be pure: no I/O, listeners, watchers or timers before
commit. Abandoned renders, repeated initialization under Strict Mode and server
rendering must be harmless. Subscriptions and external resources belong to
committed consumers and must have matching cleanup.

Each Store is a private readonly instance field. Stable snapshot/subscription
and command bindings belong to that same instance and signal identity. React
observes them through its external-store contract; ordinary rerenders must not
recreate subscriptions or command identities. Context metadata stays immutable,
and useId preserves server/client accessibility identity.

Keep writable atoms private. Expose computed projections for reads and commands
for transitions. Create graph identities during instance initialization, not
while running another command or rendering an ordinary view.

## Concurrent viewers of one browser

Support multiple viewer instances on the same host page using the same
browser-level `cdpUrl` with distinct real `windowId` values to access different
windows of that browser concurrently. Separate client pages can use this
arrangement too.

Sharing an endpoint address preserves each viewer's own connection,
selected-target sessions, mutable state, input queue, protocol acknowledgement
bookkeeping, held input, rendering queue and cleanup. Keep operations ordered
within their owning session while allowing viewers of different windows to make
independent progress. Future resource and performance changes must preserve this
independence.

A viewer may own a group of transports. Qualify session identifiers and events
by their originating connection; identifiers from separate sockets can collide.
Keep one selection and geometry authority across the group, establish all native
attachments before calibration, and let only one owner produce its screencast.
Terminate admission for the whole group if a required transport fails. Preserve
original control-effect receipts during selection retirement, while obsolete
frame resources can be released independently. Do not migrate or replay uncertain
operations into a replacement group.

Pausing, disconnecting or unmounting a viewer releases only that owner's
applicable resources, preserving sibling streams and input and the remote
browser and tabs. Window filtering remains presentation scope; the host owns
endpoint authorization. A window scope does not create a separate browser profile
or isolate website state. See [concurrent-viewer validation](validation.md#concurrent-viewers).

## Commands and runtime resources

Keep pure policy transitions separate from native execution and DOM observation.
Policy owns semantic intent and outcomes; resource owners acquire effects and
validate the originating connection/session before committing results. Coalesce
later observations without mutating a dispatched operation or requiring a quiet
interval to make progress. Reuse and new work must complete the same semantic
bookkeeping; deduplication must not skip state transitions.

Share one selected-session geometry authority across display, capture and input.
Native acknowledgement, decoded image compatibility and actual presentation are
distinct facts. An obsolete result or still-visible old image cannot grant a
replacement's input or display authority. See [display architecture](display-architecture.md)
for module responsibilities, causal presentation and bounded recovery.

An intentional tab replacement may retain already displayed pixels as a blurred,
blocked connecting backdrop. This presentation fact belongs to the private model;
it grants no input or session authority. Renderer invalidation still retires old
decodes immediately. All other selection-loss and cleanup paths clear pixels,
and actual replacement paint/readiness removes the backdrop.

Keep image failure separate from connection and selected-session lifetime. A
failed capture revokes image/input admission and clears pixels immediately;
valid native sessions may still own useful display configuration. The model
owns a pure recovery policy with explicit preparation, possible-start and
readiness stages. A runtime coordinator binds its effects and outcomes to the
original selection resources; it does not retain another semantic phase or
capture queue. Validate owner and legal stage before every model effect, so an
obsolete outcome cannot alter a successor's private presentation either.
Capture resources own serialized attempt revisions, native possible-start epochs,
positive stop receipts and bounded IO. A stopped receipt remains an original
resource fact after admission retires; it cannot restore that owner's authority
and cannot settle a newer possible start. Read-only preparation preserves that
proof. Original input cleanup and a positively stopped capture precede another
attempt; only current painted output and initialized input restore admission.
Paint readiness and capture-lane release are independent milestones reconciled
through the same policy. Unknown cleanup fences same-target acquisition.
Pausing retires normal session resources and any subsequent acquisition needs
fresh validation; visibility alone does not retry a failed image.

Retain the latest produced screencast frame at the native credit boundary so a
static final state does not require another page change after acknowledgement.
Keep native frame-credit defaults independent from local decode backpressure:
the renderer still owns one active decode and one newest queued frame. Native
last-frame retention adds bounded provider-side storage/work; it does not relax
selected-session, capture-revision or presentation-fence checks for late frames.

Views invoke bound commands from event handlers. Keep semantic transitions in
the ccstate model. React observation is limited to context, identity and external
Store subscription. Do not use useMemo, useCallback, useState, useRef, useEffect
or useLayoutEffect in first-party runtime code. A pure instance bootstrap and a
mount/update/unmount bridge connect committed props/projections to the DOM owner;
the bridge holds no alternate application state. Runtime owners allocate stable
element references and reconcile resources only after commit.

Deferred operations and cancellation controllers belong to non-static instance
resource members outside render and signal commands. Every operation still
needs bounded settlement and original-owner cleanup; syntactic ownership alone
does not prove these behaviors. Commands inherit cancellation and propagate
caught failures. These requirements apply to every file equally.

Express related visible-state changes as semantic transitions owned by the model.
Derive shared interaction capabilities from committed configuration and runtime
facts in readonly projections. Execution validates current input ownership at
the point of use. Window membership is verified around selection/attachment and
invalidated by background discovery; stable input does not query it per action.
A rendered capability is not write authority.

The per-instance model owns one target inventory and its visible projection.
Target events, explicit create/close acknowledgements and query outcomes enter
the same pure transition contract; the controller does not separately splice the
visible list. Connection resources own bounded IO scheduling, cancellation and
timers, and deliver outcomes with their original observation identity.

Target lifetime, metadata order and window membership are separate facts. A title
change cannot revoke an otherwise valid membership observation or renew its age.
Current checks must progress during continuous metadata changes. Newer applicable
membership and target retirement reject older authority; an older list cannot
overwrite newer metadata, erase newer existence evidence or resurrect removal.
Bound inventory, dirty work and active lifecycle journals. Acknowledged closure
retires the target before another publication, independently of event delivery.

Selected membership progresses independently of unrelated inventory reads. Its
original lifetime and request-start freshness cannot transfer through delayed
replies. Paused connections retain inventory reconciliation without an active
selected observation. Reset and disposal retire original connection authority.
Target events do not reliably report every document title change. Authoritative
reconciliation also repairs metadata; selected membership checks alone do not
refresh tab labels.
Metadata alone cannot extend proof expiry. Deadlines still bound unavailable
observations and the time an inventory waits behind background work.

Resource bindings belong to their instance and lifetime. Remove only a matching
binding during cleanup, so an old owner cannot detach a replacement. Callback
identity changes must not recreate unrelated resources. Keep required DOM node
identities stable across ordinary state updates.

Optional extensions use the same ownership boundary. Descriptors define semantic
configuration; a connection-owned registration creates each setup's mutable state,
signal, subscriptions and cleanup. Reconcile committed configuration independently
from transport creation. Retire authority before asynchronous teardown and retain
late setup results until their resources can be released. The core validates
extension suggestions against current connection/selection/discovery ownership and
external scope; a vendor callback cannot directly acquire a target session.

Keep local focus policy in its DOM runtime owner. Native adapters report semantic
intent through supplied callbacks rather than depending on surrounding control
markup. Shared cleanup helpers take the originating resource explicitly, while
the caller retains the decision about when that resource may be released.

Asynchronous work must retain its original owner and check that owner before
applying results or external writes. Cleanup must be idempotent and release only
owned work. See [input lifecycle architecture](input-lifecycle.md).

## Lint policy

`pnpm lint` runs type-aware checks and real-config policy regressions. Architecture
rules are errors; warnings also fail the command. Keep React hook, accessibility
and strict type checks enabled. Fix violations rather than adding inline lint
or type suppressions.

Use canonical ccstate imports and the signal naming convention. Construct
graphs inside instance signal/model factories and keep writable state private.
Do not add filename allowlists, disabled-rule overrides or infrastructure
exemptions. Necessary operations must satisfy one uniform ownership contract.
The [lint configuration](../tools/eslint/policy.js) defines that contract;
[plugin notes](../tools/eslint/README.md) record rule provenance and adaptations.

### Rule design and review

Keep lint rules focused on idiomatic code and likely accidental mistakes.
Strictness means clear ownership constraints and error-level enforcement;
exhaustive coverage of every possible spelling is not a goal.

New rule logic needs a normal project pattern or a realistic misuse to justify
its complexity, with representative accepted and rejected examples. Do not add
recursive alias tracking, callback execution analysis or special syntax cases
solely to catch deliberate circumvention. Prefer direct syntax checks and clear
coding conventions. A constructed bypass alone is not a lint defect; unusual
or intentionally evasive code belongs in code review.

Lint supplements behavioral tests and review. They must still verify bootstrap
purity, resource cleanup and independent instance state. Simplifying a rule must
preserve the library's multi-instance behavior.
