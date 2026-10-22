# Assessing optional adjacent execution

Evaluate execution location separately from public API and deployment decisions.
A fast isolated input path is insufficient evidence for a complete interactive
adapter. Preserve ordinary browser-only CDP and every interaction/ownership
contract while comparing alternatives.

## Compare the same work

Use one immutable revision for the independently installed public direct viewer
and the private actual-NativeInput candidate. Verify source, clean checkout,
consumer lockfile, disabled lifecycle scripts, frozen reinstall, public types,
extensions, build and SSR. Keep browser, default capture, workloads and transit
profiles matched. Retain an unshaped control as well as added transit in both
directions. Do not credit earlier source optimizations to a later experiment.

Record scope policy as an input to every comparison. Public scoped input uses
selection/attachment checks and background invalidation; private adjacent fixtures
may still perform fresh per-action checks. Do not describe their movement behavior
as equivalent. A before/after public-path comparison must identify an intentional
policy change separately from execution-location effects.

Use one and two scoped viewers on one browser URL, distinct real windows and
independent client pages. Each viewer retains its own connection, request IDs,
session, ordered queue, transient pressed/composition state and renderer. Pair
viewer observations by trial; two windows are not independent extra trials.

Start at the actual local input event. Observe the intended remote DOM effect
and the first canvas frame containing a distinct current marker. Reset and
observe preparation outside the stopwatch equally for both paths. A pointer
preparation may be deferred through an animation frame; an empty batch counter
alone does not prove that it has even entered the queue. Join its real remote
event and the candidate's actual ACK before cutting the sample. Also join input
readiness: ownership invalidation can empty both batch and ACK counters while
input remains unavailable. Synthetic composition must use the current focused
proxy and admitted generation rather than silently emitting an unowned event.

Keep all guards and writes required by the measured action. Record raw samples,
workload, trial/window, method counts, visible latency and bounded-work evidence.
Report exact acknowledgement drain only where observed. A later verification or
queue-join duration is an observation bound, not an exact wire completion time.
Do not turn local timings into universal correctness thresholds or infer tails,
throughput or production capacity from a few trials.

The opt-in [experiment guide](../tests/experiments/README.md) documents commands
and fixture observation boundaries. Composition is synthetic local event input
with actual Chromium native effects. Clipboard copy ends at the trusted local
Clipboard API result, with its value verified through a real local paste; copying
has no invented remote DOM or new-frame effect. The client clipboard is a shared
physical resource, so paired copy gestures run serially. Paste, composition and
navigation workloads can overlap across independent viewers.

Representative same-document navigation and subsequent native editing are
measured separately. Full-document, history, reload and retained-document
correctness require their own lifetime cases. A valid navigation protocol result
does not prove that a page loaded. Scrolling a prepainted marker measures streamed
translation; it does not prove delivery of arbitrary scroll-handler application
repaints. State these boundaries instead of merging unlike metrics.

## Compare credible alternatives

| Approach                                                     | What it can improve                                                              | Required boundary or remaining cost                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Direct input bound to the selected session                   | Avoids per-event membership RTTs, earlier dispatch replies and optional metadata | External movement can precede background discovery; selection/attachment and local owner checks remain required                   |
| Fresh per-action membership                                  | Checks observed scope before each queued write                                   | Each scoped check crosses the CDP link; check and send are still not atomic against external movement                             |
| Reduce optional metadata or separate frame/control transport | Can reduce redundant reads or contention                                         | Measure it independently; it does not remove a dependent membership round trip                                                    |
| Cached membership                                            | Can remove repeated lookups                                                      | Cached presentation membership cannot silently become current input authorization                                                 |
| Parallel preflight or a versioned membership lease           | May overlap preparation under an explicit ownership protocol                     | A result prepared before other work is not an atomic check at dispatch; invalidation and external moves need an enforced contract |
| Original-owner release exception                             | Can finish owned cleanup after focus/membership loss                             | Cannot authorize new input, erase unknown results or release a replacement's acquisition                                          |
| Raw WebSocket relay                                          | Can change connection topology                                                   | Relaying dependent client requests does not relocate guard/dispatch decisions                                                     |
| Explicit adjacent intent executor                            | Moves dependent guard/dispatch work to short CDP                                 | Adds host admission, an optional wire contract, extra resources and operational failure modes                                     |

Select by demonstrated benefit and preserved contracts, not by smallest diff or
fixture speed alone. Unmeasured alternatives remain unmeasured; do not label them
incompatible merely because another approach has a working prototype.

## Requirement and evidence matrix

Publish a revision-specific table in the PR or issue. For each requirement record
passed, failed or unverified, its exact source/evidence, and its practical limit.
Do not convert an explicit limit into a passed production gate.

| Requirement                           | Evidence needed                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Input execution and streamed feedback | Matched raw direct/candidate observations, unchanged capture and unshaped controls; both required dimensions improve for a claimed workload            |
| Complete native adaptation            | Immediate click/type, sustained text, editing, pointer/wheel, Tab/focus, preedit/commit/cancel, trusted clipboard and representative navigation        |
| Independent viewers                   | A's actual guard/reply is held while B makes a new DOM edit and paints new pixels; one browser and distinct windows                                    |
| Owned cleanup                         | Both viewers hold modifiers; A blur/pause/unmount/viewer loss releases only original acquisitions while B continues                                    |
| Target movement                       | Actual selected-tab move with queued/held work, terminal invalidation, original cleanup/detach and verified fresh destination admission                |
| Failure and pressure                  | Lost/rejected/partial/malformed/late replies, bounded queues and receipts, viewer/executor/CDP loss/reconnect, no uncertain replay and retained denial |
| Replacement safety                    | Old generations, callbacks, results and releases cannot edit, grant credit to or release a replacement's acquisitions                                  |
| Compatibility                         | Ordinary direct CDP, public source/type/CSS exports, independent Stores, host peers and immutable GitHub consumer remain usable                        |
| Provider and native platform          | Actual Origin/TLS/session behavior and genuine OS input/clipboard evidence, independently of synthetic fixtures                                        |
| Production adoption                   | Reviewed authentication/admission/isolation, wire compatibility/rollout, durable recovery, observability and measured resource/cost envelope           |

## Authority and isolation review

The local DOM adapter owns the stable native proxy, composition adaptation and
trusted clipboard gesture. The execution session owns immutable document/focus
generations, ordered guarded writes, bounded original effect receipts and cleanup.
The connection validates protocol outcomes; instrumentation does not grant them.
A pure completion fence cannot acquire permission for another input. The host
reserves an admitted target and releases that reservation only after positive
original retirement and detach. Unknown outcomes remain unavailable and are
never replayed on a fresh connection.

An opaque fixture owner is not production authentication. A deployed host needs
an authenticated principal, verified browser entitlement and server-controlled
target/session lifetime. Window filtering is presentation scope, not endpoint
access control or tenant isolation. Shared browser profiles can intentionally
share cookies and storage even when input lanes are independent. Define who may
provision, attach, observe, mutate and retire each browser before exposing an
executor. Never accept a client-chosen CDP session as that authority.

Fresh membership lookup followed by native dispatch is not atomic against an
arbitrary external tab move. Explicit revoke/cleanup/handover cases establish the
tested boundary; stronger isolation requires a separately enforced ownership
contract. Production authentication, durable leases and restart recovery are
separate from an in-memory fixture reservation.

## Compatibility and operating cost

A private message union is not a versioned public adapter protocol. Before a
public integration, review capability/version negotiation, limits, owner and
generation identity, contiguous confirmation credit, clipboard/navigation
semantics, backpressure, disconnect and unknown-retirement behavior. Preserve a
browser-only direct option, explicit opt-in and rollback. Do not silently publish
an experimental wire format through existing component props.

Account for each participating viewer independently. The experiment retains its
public stream connection and adds an intent connection plus an original adjacent
CDP connection. Include queue/receipt/timer state, CPU, memory, connection count,
message/egress volume, lifetime and idle behavior. Per-session bounds are not a
production capacity or affordability result. Larger fleets also need host-level
limits and isolation; the fixture does not implement those deployment contracts.

Evaluate operating cost as measured session time, compute/memory, connections,
network traffic and any selected provider/storage/observability charges against
verified rates. Record missing measurements and rates rather than inventing a
price. Failure handling must include viewer loss, executor/CDP loss, host restart
and durable admission cleanup. An in-memory reservation surviving one lost viewer
does not establish recovery after process restart.

## Decision

Separate architecture feasibility, fixture parity and shipping adoption. A
positive matched result can support further integration work while production
adoption remains deferred. A completed evaluation can conclude defer, provided
every criterion is classified and the missing gates are explicit; it cannot
claim those gates passed or close an ancestor whose completion conditions remain
unmet. Keep the dated decision and all raw results in PR/issues. Scope future
implementation only after that evidence-backed decision is separately selected.
