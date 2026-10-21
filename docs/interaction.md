# Interaction and native text input

Set `interactive` on a viewer to enable mouse, keyboard and page navigation.
The component defaults to read-only; the Pages demo explicitly enables interaction.
Each instance owns its native textarea, focus, pressed keys/buttons, bounded
command queue and selected-target CDP session. No endpoint-keyed global input
owner or document-wide keyboard handler is installed.

Lifecycle transitions and cleanup use one coordinator, with separate native
composition state and an owner-bound serial executor. See the
[input lifecycle contract](input-lifecycle.md) for ownership and release rules.

Click the displayed page to establish remote focus and focus the local proxy.
Pointer coordinates follow the contained image and remote CSS visual viewport,
including page scale and panning; JPEG size and client DPR are not coordinates
to send directly. Initial clicks in the letterbox are ignored. Captured drags
continue to the image edge; release/cancel/blur releases owned pressed input.
Mouse is the initial supported pointer type; touch and pen are not advertised.

Keyboard events belong only to the focused viewer's native textarea. Typing in a
host field or the viewer's address/target controls stays local. **F8**, outside
composition, releases keyboard focus to the viewer's page selector. Tab and
Shift+Tab navigate remote controls while remote input owns focus. Ctrl/Cmd+A and
Ctrl/Cmd+Z/Shift+Z use explicit Blink select-all/undo/redo commands, avoiding an
assumed remote OS shortcut mapping; Ctrl+Y also requests redo. Other forwarded
shortcuts retain their modifier bits and depend on the remote platform/site.
Clipboard transfer is not implemented: copy/cut/paste gestures are suppressed
on the proxy so its temporary text is not mistaken for a remote selection.
The proxy stays disabled while connecting, paused, unavailable, disconnected or
errored, so local Tab navigation can pass through the inactive viewer. It keeps
the same textarea node and becomes focusable again when streaming resumes.

## Composition and candidate placement

A stable, uncontrolled, visually transparent textarea hosts the local OS input
method. It remains rendered and focusable; `display:none`, `visibility:hidden`
and `type=hidden` cannot do this. Ordinary committed text and completed Unicode
composition use `Input.insertText`. Preedit stays local. Composition/input event
ordering is consumed as a value boundary so a trailing final input does not
duplicate committed text or suppress a subsequent identical character.
Cancellation sends no text. IME/229/composing Enter is kept separate from a later
ordinary Enter, which can submit the remote form or insert a newline.
Late composition values after blur or target replacement are discarded, including
events arriving after the native proxy has been refocused for another control.

For ordinary contenteditable selections, a collapsed DOM range supplies the
candidate anchor where available. Native input/textarea controls do not expose a
standard caret rectangle, so the fallback is near the focused control's top-left
editing area; the initial click is the fallback before remote geometry resolves.
The proxy uses the measured image transform and does not mirror remote values.
Exact native candidate-window placement still requires actual OS validation.

## Ownership, navigation and uncertain outcomes

The remote focus guard retains the expected connected top-document/open-shadow
element, rather than choosing a control by title or cached selection. A changed
element or unsupported focused iframe rejects text with a fixed diagnostic;
click a supported control to recover. Pointer viewing/clicking a frame does not
establish supported keyboard/composition routing into it.

Unsent work is discarded on local blur, target/session replacement, observed
document/context navigation, pause, disconnect and unmount. Async continuations
check their original owner before sending. Owned key/button releases and late
focus-object cleanup use their original connection. Queued input/navigation is
never automatically replayed. CDP cannot atomically bind `Input.insertText` to a remote
DOM element: a site can move focus between the guard and an already-sent command.
Already accepted remote input cannot be cancelled or rolled back.

Pressed keys remain owned until their `keyUp` response confirms release. A failed
or interrupted release still permits best-effort release cleanup on the original
session, which can send an additional `keyUp` when its outcome is unknown.
Committed text and navigation are not replayed by this cleanup.
Hash and history changes that retain the document release owned keys/buttons
before clearing input ownership. Navigation start also releases held input:
cancellation or HTTP 204 can retain the original document. A loading-start event
alone does not establish document loss; explicit navigation/context facts drive
the lifecycle transition table.

The toolbar accepts absolute `http://` and `https://` addresses; it does not infer
a scheme, run JavaScript URLs or perform endpoint discovery. Draft address edits
do not navigate. Go, reload and available history actions are explicit standard
CDP requests and invalidate input before sending. Remote page addresses remain
in memory and may contain sensitive data; do not record them in snapshots/logs.

## Support and evidence matrix

| Surface                                          | Automated fixture                                     | Candidate anchor / limitation                                                 |
| ------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Top-document text input                          | Native text/emoji, selection, deletion, undo/redo     | Control rectangle fallback; not an exact input caret                          |
| Top-document textarea                            | Text and ordinary Enter/newline                       | Control rectangle fallback                                                    |
| Native contenteditable with nested rich markup   | Text replacement and Unicode                          | Collapsed selection range when exposed                                        |
| Open shadow-root text input                      | Native text input through an actual open-root control | Closed roots are not supported                                                |
| Focused same-origin iframe                       | Explicit rejection without writing another control    | Frame-context input routing is not implemented                                |
| Cross-origin / out-of-process iframe             | Not separately probed                                 | Outside the supported input boundary                                          |
| Application editors such as ProseMirror/Lexical  | Not verified                                          | No application-specific editor compatibility claim                            |
| macOS system IMEs                                | Pending genuine OS receipt                            | Candidate placement, confirmation/cancellation and focus transitions required |
| Windows system IMEs                              | Pending genuine OS receipt                            | Same required native scenarios                                                |
| Other frontend browsers / provider CDP endpoints | Not verified by owned Chromium fixtures               | Capability, Origin and platform evidence required                             |

Synthetic composition exercises browser routing and event ordering, not a real
system IME. Genuine receipts must record source revision, client OS/browser,
IME name/version and remote Chromium version; exercise candidate placement,
confirmation versus submit, cancellation, repeated characters, emoji/mixed text,
toolbar/other-viewer focus, navigation and target replacement. Record outcomes
without input text, endpoint URLs, real content or unredacted traces/screenshots.
