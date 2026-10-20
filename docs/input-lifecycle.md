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
  coordinator's owned cleanup effects. `InputQueue` serializes CDP commands and
  checks the job's captured owner before and after each asynchronous request.

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

The queue holds at most 64 pending jobs. Only adjacent movement or text belonging
to the same owner can coalesce; text chunks retain the 64 KiB bound. Cancellation
clears queued work, while an already running request settles under its original
owner and cannot continue with a new one.

## Validation

State tests cover every transition policy, owner isolation, stale focus/release
results, composition event orderings and cancellation. Bounded four-event
press/acknowledge/cancel sequences check the pressed-input invariant. External
wire tests exercise the controller's captured owners, queue saturation, delayed
focus results and target/document changes during requests. Public-consumer
Chromium fixtures retain real input/focus/geometry, multiple viewers, navigation
and HTTP-204 release/recovery coverage.

These are state/routing tests. Genuine macOS/Windows IME receipts are still needed
for candidate-window placement, confirmation/cancellation and focus transitions.
CDP cannot atomically combine a remote focus check and insertion, or undo input
that a remote page has already accepted. See [interaction limits](interaction.md).
