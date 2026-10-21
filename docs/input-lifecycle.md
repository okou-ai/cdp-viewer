# Input lifecycle architecture

Separate event adaptation, state transitions and protocol execution. Each layer
should own one responsibility and expose explicit facts or effects to the next.

## Responsibilities

| Layer                 | Responsibility                                                           |
| --------------------- | ------------------------------------------------------------------------ |
| Native adapter        | Translate DOM events and own local listeners and references              |
| Composition model     | Represent pending local input and its captured owner                     |
| Lifecycle coordinator | Decide ownership transitions and required cleanup without performing I/O |
| Session adapter       | Translate protocol facts and execute the coordinator's effects           |
| Serial executor       | Order external writes and enforce their captured ownership               |

Keep transition decisions in the coordinator instead of distributing policy
across event handlers. Adapters report semantic facts rather than selecting
cleanup flags. Publish a new ownership state before executing effects so
reentrant callbacks observe the current lifetime.

## Ownership

Bind work to an immutable owner identity and its lifetime. External identifiers
alone are insufficient: a later instance may reuse the same identifier. Every
asynchronous continuation must check its captured owner before applying state
or sending another write.

Losing ownership invalidates pending work. Late results must not acquire the
replacement's authority. Release unretained handles through the connection that
created them, including results received after cancellation or timeout.

Cleanup is explicit and idempotent. Separate releasing an owned external
resource from clearing local bookkeeping. Release only resources the library
owns; disposing one instance must not affect a sibling or its host.

## Concurrency and bounded work

Order preparation and sends that act on the same external resource. Independent
read-only preparation may overlap, but join it before any write that depends on
its results. Revalidate ownership after the join. Wait for acknowledgements only
at boundaries that depend on completion; track other replies separately from
the ordered send lane.

Bound queued and in-flight work together and make overflow behavior explicit.
Match release acknowledgements to their original acquisition generation so a
late reply cannot clear a newer acquisition of the same external resource.
Coalescing must preserve ordering and observable intent. A dispatched payload is
immutable; later work must not change a request that is already awaiting
acknowledgement.

Remote composition is transient owned editing state. Keep preedit updates,
final commits and cancellation ordered, and retain cleanup ownership until the
matching acknowledgement. A late acknowledgement cannot clear a later composing
generation. Release an old composing range only while its original document
exists, before the executor admits replacement-owner input. Use the browser's
native composition range rather than guessing committed-text deletions.

Optional background work must have a captured owner, bounded concurrency and a
way to discard stale results. It must not authorize a write or overwrite newer
state. Keep it off the critical path when correctness does not require it.

## Failure handling and validation

Distinguish unsent, acknowledged and uncertain work. Cancellation can discard
pending work but cannot undo an external effect that may already have happened.
Never automatically replay a non-idempotent operation with an uncertain outcome.
Handle failures at the layer that owns the operation and retain required cleanup.

Test lifecycle transitions independently from DOM and network adapters. Verify
ownership across replacement, delayed replies and cancellation through the
public integration boundaries. Use explicit synchronization rather than sleeps
or tight timing budgets; see the [validation strategy](validation.md).
