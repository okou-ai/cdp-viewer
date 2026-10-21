# Input lifecycle

Input is private to one viewer's connection and selected CDP session. The public
component/API and native textarea remain unchanged. Internal responsibilities are:

- `NativeInput` adapts DOM keyboard, pointer, focus and composition events. Its
  key/button sets describe local physical gestures and capture, not remote state.
- `NativeComposition` represents idle, composing and awaiting-trailing-input
  states. A composition captures its original input owner. Completion can commit
  once to that owner; cancellation and late events cannot commit to a replacement.
- `InputLifecycle` owns immutable document/focus tokens, pending/active remote
  focus and the ledger of remotely sent pressed keys/buttons. Its transition
  table decides cleanup without performing DOM or network effects.
- `InputSession` normalizes protocol and local lifecycle facts, then executes the
  coordinator's owned cleanup effects. `InputQueue` serializes input writes and
  their required checks, and checks the job's captured owner before and after
  each asynchronous request.

An owner token's identity binds it to its viewer/connection/session even when
another connection reuses the same CDP session ID. Document loss invalidates all
of its focus work. Local focus loss invalidates the current focus lifetime.
Remote Tab/click handoffs within the same viewer run in FIFO order, so a later
click does not erase earlier committed-text intent. Each subsequent write still
checks the expected remote focused element.

## Transition rules

| Event                                         | Unsent work / composition                     | Remotely held keys and buttons                                                        |
| --------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Local blur, F8 or window blur                 | Invalidate focus owner and reset native state | Release through the original live session                                             |
| Navigation starts                             | Invalidate focus owner                        | Release before forgetting ownership: cancellation or HTTP 204 can retain the document |
| Same-document URL/history change              | Invalidate focus owner                        | Release in the retained document                                                      |
| Document commit / main execution-context loss | Invalidate document and focus work            | Forget old-document state without deliberately sending old actions to a replacement   |
| Target replacement, pause or unmount          | Terminate this input owner                    | Release through the original live session before detach                               |
| Disconnect                                    | Terminate the connection's input owner        | Clear locally; delivery through a closed socket cannot be promised                    |
| Input failure or queue saturation             | Invalidate focus owner; discard unsent work   | Best-effort original-session release                                                  |

`Page.frameStartedLoading` alone establishes neither navigation type nor document
loss. Protocol handlers report semantic facts instead of choosing a release
boolean. The coordinator publishes the new owner before effects run; DOM reset
suppresses its own synchronous blur feedback. Terminal cleanup is idempotent.

A sent key/button remains in the remote ledger until its release response is
acknowledged. Invalidating a pending release can therefore send an additional
best-effort release when its outcome is unknown. Text and navigation are never
replayed. A late focus-object result is released using its original session.

Runtime replies can contain separate handles in their result and exception
details, even for a by-value request. The executor releases every distinct
unretained handle through the requesting session, including replies received
after cancellation or timeout. Only a successful current by-reference focus
result transfers ownership to the lifecycle; exception handles never do.

The queue holds at most 64 pending jobs. Only adjacent movement or text belonging
to the same owner can coalesce; text chunks retain the 64 KiB bound. A running
text batch can collect adjacent text while its window/focus checks are pending,
provided no intervening job exists. The batch seals before `Input.insertText` is
sent: later text cannot mutate its payload or cross a key/pointer boundary.
Cancellation clears queued/collecting work, while an already running request
settles under its original owner and cannot continue with a new one.

A button press supersedes an unflushed hover move at the same position. Held
drag movement still flushes before release, and each forwarded pointer job reads
fresh CSS viewport metrics rather than using a geometry cache.

Initial focus acquisition and pre-write focus/window checks remain blocking.
Optional post-action caret geometry does not block later input: one background
read and one newest desired refresh are retained per session. Results must match
the owner, focused object and focus/refresh generation, including another click
within the same owner. Stale or failed optional reads cannot move the caret,
clear a newer error or authorize an input write. Their Runtime result handles
retain the executor's original-session cleanup.

## Validation

State tests cover every transition policy, owner isolation, stale focus/release
results, composition event orderings and cancellation. Bounded four-event
press/acknowledge/cancel sequences check the pressed-input invariant. External
wire tests exercise the controller's captured owners, queue saturation, delayed
focus results and target/document changes during requests. Public-consumer
Chromium fixtures retain real input/focus/geometry, multiple viewers, navigation
and HTTP-204 release/recovery coverage.

Latency regressions hold protocol responses explicitly to verify preflight
batching, payload sealing, FIFO boundaries, bounded caret work and stale-result
suppression. Owned-browser cases hold an actual remote guard response and verify
native text reaches the remote control as one batch, both with and without
window scope. Timing comparisons use separate controlled network-delay probes;
CI assertions do not depend on tight wall-clock budgets.

These are state/routing tests. Genuine macOS/Windows IME receipts are still needed
for candidate-window placement, confirmation/cancellation and focus transitions.
CDP cannot atomically combine a remote focus check and insertion, or undo input
that a remote page has already accepted. See [interaction limits](interaction.md).
