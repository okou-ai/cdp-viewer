# Input lifecycle architecture

Separate event adaptation, state transitions and protocol execution. Each layer
should own one responsibility and expose explicit facts or effects to the next.

## Responsibilities

| Layer                 | Responsibility                                                              |
| --------------------- | --------------------------------------------------------------------------- |
| Native adapter        | Translate DOM events and own local listeners and references                 |
| Input ingress         | Bind original event authority, schedule continuous work and order admission |
| Composition model     | Represent pending local input and its captured owner                        |
| Lifecycle coordinator | Decide ownership transitions and required cleanup without performing I/O    |
| Session adapter       | Translate protocol facts and execute the coordinator's effects              |
| Serial executor       | Order external writes and enforce their captured ownership                  |

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

Keep local input ownership separate from remote window discovery. The public
controller verifies scope around selection/attachment, then checks the selected
session locally for input. Background discovery invalidates it after an observed
window mismatch or lookup failure. A pending discovery query does not block stable
input while the selected membership observation remains fresh. Its independent
deadline and local admission check prevent delayed positive replies from renewing
an expired observation; receipt time is not observation time. External movement
may precede detection; this policy cannot provide atomic
scope-and-dispatch or cross-client admission. Test cancellation after detection
and validate any destination owner after confirmed original cleanup.

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

One input ingress owns continuous scheduling and discrete ordering before
protocol admission. Capture the original port and immutable owner before a flush
or callback, and give DOM adapters a bound capability. Its methods can only use
that original authority. Sessions carry the supplied identity through callbacks
into queue admission; the queue must never substitute whichever owner is current.
This includes synchronous callbacks, not only awaited continuations. Deliberate
focus/navigation transitions use the generation published before cleanup effects;
reading a later current generation is not a transition receipt.

Retain one compatible continuous sample for a natural frame. Keep raw movement
coordinates until actual dispatch. Reset retires pending samples and frame
callbacks; even a cancelled callback that runs later cannot flush a new lifetime.
The protocol executor retains the same compatibility boundaries when coalescing
under reply pressure. Its ordered sends and separate acknowledgements serve a
different boundary from the ingress buffer.

Clear pending state before external effects. A discrete action or selection read
flushes preceding continuous work using its original binding; retirement makes
the following action inadmissible. A clipboard event retains one binding across
capture and bubble, with denied capture cancelling later admission. Local
clipboard writes still begin synchronously in the original trusted gesture.
Pointer capture/compatibility mouse events likewise retain their gesture binding.

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

An acknowledgement is an owned protocol outcome, not a successful local send.
The CDP transport validates response envelopes once. Instrumentation observes
payload-free command metadata and validated outcomes; it must not infer cleanup
success by decoding another copy of the wire protocol.

Keep preparation reads separate from effect writes. Input sessions retain bounded
original-session write receipts after ownership loss, including key/button
releases and composition cancellation. A completion fence joins earlier work
without acquiring membership or permission to send another input. Retirement
publishes terminal admission first, cancels unsent preparation, joins dispatched
work and its late cleanup, and completes through the original connection. Unknown
cleanup remains unavailable; it cannot authorize replacement or replay.
Retirement observes the original send lane and its receipts independently of
focus/document generations. Navigation may invalidate write authority and cancel
unsent jobs without cancelling this cleanup wait; late composition cleanup still
requires its original document.

The public controller stops obsolete streams immediately and retains retiring
input sessions until original effects settle before detaching. It forwards their
document events and fences same-target
reuse within that controller. Other targets keep independent admission. This
local fence is not a lease shared by separate viewers or clients, and connection
teardown cannot guarantee remote cleanup.

Image recovery may suspend input without disposing its native session. Publish
the successor input generation and cancel unsent work, then join original native
effects and pressed/composing cleanup without granting another owner. A useful
session or an open socket alone does not authorize input while its image is
unavailable. Its current capture must paint before admission resumes; an unknown
cleanup receipt remains unavailable even when capture restart would succeed.

Test lifecycle transitions independently from DOM and network adapters. Verify
ownership across replacement, delayed replies and cancellation through the
public integration boundaries. Use explicit synchronization rather than sleeps
or tight timing budgets; see the [validation strategy](validation.md).
