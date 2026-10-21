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

## Commands and runtime resources

Views invoke bound commands from event handlers. Keep semantic transitions in
the model rather than synchronizing duplicate state through React effects.
Use React effects only in the runtime adapter to synchronize external resources
with committed props and instance state.

Express related visible-state changes as semantic transitions owned by the model.
Derive shared interaction capabilities from committed configuration and runtime
facts in readonly projections. Execution still validates current ownership and
external scope at the point of use; a rendered capability is not write authority.

Resource bindings belong to their instance and lifetime. Remove only a matching
binding during cleanup, so an old owner cannot detach a replacement. Callback
identity changes must not recreate unrelated resources. Keep required DOM node
identities stable across ordinary state updates.

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
