# State and React boundaries

Ordinary views read ccstate projections and invoke bound commands from event
handlers. They do not construct stores, define signals, retain mutable refs,
synchronize state with effects, or control browser resources. This applies to
both `src/react/CdpViewer.tsx` and the demo views.

## Instance ownership

`src/state/instance.ts` is the only Store construction definition. Each call
creates a fresh Store and signal graph. `src/viewer/model.ts` and `demo/model.ts`
define their own graphs inside factories, keeping writable atoms private and
returning computed projections and commands. The demo owns panel configuration;
each mounted public `CdpViewer` still owns a separate library instance.

`src/state/react.tsx` defines a private context/subscription bridge. The named
context modules pass model factories into `createScope`; they share only context
metadata. A provider allocates and retains its own model. This is a narrow pure
bootstrap exception: allocation during render must perform no I/O, install no
listeners or watchers, and start no timers or subscriptions. Abandoned renders,
Strict Mode's repeated initialization and source SSR must be harmless.

The bridge uses `useSyncExternalStore` with the same read for server rendering.
Subscriptions belong to committed React consumers. Runtime `ccstate-react`
imports are forbidden in production so the host's provider cannot accidentally
own viewer state. There is no global viewer Store, endpoint registry or implicit
connection pool. Supporting several independent viewers is a required invariant.

## Commands and runtime resources

The viewer model owns reconnect revisions, target/navigation actions and address
drafts. The demo model owns panel identities, draft validation, committed
connections and reconnect generations. Editing a connection draft does not
replace an applied connection. Reconnect uses committed settings; an invalid
apply preserves the current viewer. Address editing survives remote URL updates
while active; a completed draft is released on the next URL transition.
Disabling interaction ends that address editor's lifetime and discards its
draft; re-enabling starts from the current remote URL. Sibling drafts and
connections retain their independent lifetimes.

`src/react/runtime.tsx` is the exact DOM/resource adapter. It owns stable canvas
and textarea refs, committed callbacks, layout effects, visibility observation,
native input, controller binding and cleanup. It binds model actions to its own
controller and removes only the matching binding during teardown. Changing a
callback does not reconnect. Each socket, session, request, timer, renderer and
native input lifetime remains owned by its viewer.

Commands do not replace the serialized CDP input lane or its captured ownership
checks. DOM resources start after commit and stop on ownership loss. Never retry
uncertain input or close the remote browser as viewer cleanup. Read
[input-lifecycle.md](input-lifecycle.md) before changing those boundaries.

## Lint policy

`pnpm lint` runs type-aware Oxlint, ESLint and the real-config policy regressions.
All architecture rules are errors; warnings also fail the command. Production
code cannot disable ESLint/Oxlint checks or suppress TypeScript diagnostics.
React hook and accessibility checks remain enabled.

The local ESLint plugin adapts 20 selected rules from
[`okou-ai/okou` at 7354b16deac91ae677fa1edbfb82d16c5c6e5504](https://github.com/okou-ai/okou/tree/7354b16deac91ae677fa1edbfb82d16c5c6e5504/turbo/packages/eslint-rules/src/ccstate).
It has no private workspace dependency. Selection and library-specific changes
are documented in [the plugin notes](../tools/eslint/README.md).

The rules enforce signal naming and canonical imports, private writable atoms,
accessor/Store boundaries, render purity, async cancellation checks, explicit
promise failure handling and instance construction. Additional local rules
restrict graph factories and private scope definitions, reject view writes,
block primitive import/forwarding bypasses and prevent suppressions. The Store
rule is deliberately enabled here even though it was only registered in the
inspected Okou configuration.

Ordinary views may use type-only React/ccstate imports and private scope reads
and commands. Runtime React imports are denied everywhere except the exact
definitions below; namespace imports and aliases cannot acquire additional
capabilities. ccstate constructors must use their canonical names and appear
only in approved model definitions. A new model or primitive definition requires
an explicit policy change with positive and negative regression coverage.

| Definition                                        | Granted capability                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/state/instance.ts`                           | Construct a Store inside `createInstance`                                                 |
| `src/viewer/model.ts`, `demo/model.ts`            | Define a graph inside its factory; call `createInstance`                                  |
| `src/react/context.ts`, `demo/context.ts`         | Create private scope metadata from a model factory                                        |
| `src/state/react.tsx`                             | `createContext`, `useCallback`, `useContext`, `useId`, `useState`, `useSyncExternalStore` |
| `src/react/runtime.tsx`                           | `createContext`, `useContext`, `useEffect`, `useLayoutEffect`, `useMemo`, `useRef`        |
| `demo/main.tsx`                                   | `StrictMode` and the root document bootstrap                                              |
| `src/cdp/client.ts`                               | Native cancellation owners and wire deferred Promises                                     |
| `src/viewer/controller.ts`, `src/input/native.ts` | Native cancellation owners                                                                |

These are per-rule capabilities, not directory-wide lint exemptions. All other
ownership, naming, failure-handling and type checks still apply in these files.
In signal graphs, caught failures must propagate; catching and immediately
rethrowing is permitted. CDP parsing, native input and request cleanup instead
use their existing protocol-specific error and cancellation contracts. Terminal
async work must have an explicit rejection handler that checks the captured
owner before reporting; empty catches and `void` discarding are forbidden.

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
purity, resource cleanup and independent viewer Stores, graphs and connections.
Simplifying a rule must preserve the library's multi-instance behavior.
