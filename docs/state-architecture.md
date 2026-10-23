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
The bridge and runtime adapters are narrow infrastructure boundaries, not
general exemptions from code-quality rules.

## Instance ownership

Allocate a fresh Store and graph for each instance. Share immutable context
metadata or pure definitions, not mutable models, active resources or an implicit
global registry. The host application's state provider must remain independent
of library state.

Bootstrap allocation must be pure: no I/O, listeners, watchers or timers before
commit. Abandoned renders, repeated initialization under Strict Mode and server
rendering must be harmless. Subscriptions and external resources belong to
committed consumers and must have matching cleanup.

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

Display adaptation owns its rules in the private display module. A pure policy
transition owns the connection's mode, observations, explicit intent, execution
stage and window history. Target, configuration, measurement and transaction
outcomes enter that same contract; policy acquires no native or DOM resources.
Selected-session success and connection-window history have distinct lifetimes.
Native applied-key receipts belong to the selected transaction, not policy.

The synchronizer bridges that policy to one selected-session native executor and
owns bounded scheduling. Preparation, dispatch, presentation and recovery report
explicit stages and outcomes. Preparation consumes observations before returning
its outcome; observations arriving afterward remain pending. Dispatch captures
immutable native payloads while later measurements coalesce independently, so
progress does not require a quiet interval. Successful reuse and newly painted
writes enter one policy completion transition; retired or failed results cannot
commit window history or acquire a replacement's authority.

Each selected session shares one geometry owner across adaptation,
capture and input; native calibration, acknowledged transforms and painted facts
retain distinct meanings. Input consumes an immutable mapping rather than
deriving its own density and zoom formulas. Invalidations retire earlier geometry
reads and paint callbacks without changing native input ownership.
Preparation revalidates both intent and native geometry after read/capture
boundaries. Retired facts cannot authorize a display write; the current request
is retained for recomputation through the same bounded scheduler.
An already compatible presentation completes the same policy bookkeeping as a
newly painted write; deduplication skips native effects without skipping state.
The geometry owner distinguishes native calibration, writing, awaiting
presentation, presented and uncertain adaptation. Starting a write retires its
pointer mapping. A definite rejection can restore previous acknowledged units;
an unconfirmed outcome keeps them unknown. Successful application or rollback
requires compatible metadata and actual decoded raster dimensions followed by
successful drawing. The renderer rejects obsolete or incompatible decoded images
before changing the canvas. Native acknowledgements alone cannot end a display
transaction or enable fresh-layout fallback over its old visible pixels.

Presentation waits share the bounded request/stream budget and retire with their
selected session. A same-geometry density change or rollback also needs causal
capture evidence: the native executor reads a clock in a private isolated world
after acknowledged writes while the controller stops/starts the same bounded
stream. The geometry owner rejects pre-fence timestamps and decodes. This adds
no per-frame reads, React updates or refreshes during ordinary distinct-size
updates. Target-size metadata with an incompatible decoded raster can request
that same fenced refresh once during presentation. Decoded facts can diagnose
this mismatch before or after the final acknowledgement, but only painted facts
can complete presentation. Invalidations retire both. Conditional recovery
consumes the remaining presentation wait rather than starting a new full budget;
capture effects retain their bounded request deadlines and serialized owner.
New pointer gestures remain suspended through the transition; text,
native keys and release of already-owned buttons retain their input ownership.

The controller retains target/session lifetime and frame acknowledgement. DOM
observation and the effective host/menu mode remain in the runtime/model layers.
Capture transitions also belong to the controller. Bounded restoration preserves
the previous capture policy, distinguishes a rejected stop from an uncertain
stop/start, and confirms a stopped stream before repeating a possible start.
Every continuation revalidates its selected-session owner.
Capture timestamps order images; they do not identify an adaptation generation
or make native sizing, emulation and painting atomic.

Views invoke bound commands from event handlers. Keep semantic transitions in
the model rather than synchronizing duplicate state through React effects.
Use React effects only in the runtime adapter to synchronize external resources
with committed props and instance state.

Express related visible-state changes as semantic transitions owned by the model.
Derive shared interaction capabilities from committed configuration and runtime
facts in readonly projections. Execution validates current input ownership at
the point of use. Window membership is verified around selection/attachment and
invalidated by background discovery; stable input does not query it per action.
A rendered capability is not write authority.

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

Use canonical ccstate imports and the signal naming convention. Keep primitive
construction in its named definition site. Grant capabilities to the smallest
necessary boundary rather than exempting a directory. The
[lint configuration](../tools/eslint/policy.js) defines the exact capabilities;
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
