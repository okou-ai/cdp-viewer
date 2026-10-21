# Interaction and native text input

Set `interactive` on a viewer to enable mouse, keyboard and page navigation.
The component defaults to read-only; the Pages demo explicitly enables interaction.
Each instance owns its native textarea, focus, pressed keys/buttons, bounded
command queue and selected-target CDP session. No endpoint-keyed global input
owner or document-wide keyboard handler is installed.

Lifecycle transitions and cleanup use one coordinator, with separate native
composition state and an owner-bound ordered executor. See the
[input lifecycle architecture](../docs/input-lifecycle.md) for ownership and
concurrency principles.

Click the displayed page to establish remote focus and focus the local proxy.
Pointer coordinates follow the contained image and remote CSS visual viewport,
including page scale and panning; JPEG size and client DPR are not coordinates
to send directly. Initial clicks in the letterbox are ignored. Captured drags
continue to the image edge; release/cancel/blur releases owned pressed input.
Mouse is the initial supported pointer type; touch and pen are not advertised.
Coordinates use painted-frame metadata when available, with fresh layout queries
after invalidation or missing metadata. Continuous wheel input combines only
compatible adjacent pending deltas, preserving scroll distance and gesture order.

Keyboard events belong only to the focused viewer's native textarea. Typing in a
host field or the viewer's address/target controls stays local. **F8**, outside
composition, releases keyboard focus to the viewer's selected tab. Tab and
Shift+Tab navigate remote controls while remote input owns focus. Ctrl/Cmd+A and
Ctrl/Cmd+Z/Shift+Z use explicit Blink select-all/undo/redo commands, avoiding an
assumed remote OS shortcut mapping; Ctrl+Y also requests redo. Other forwarded
shortcuts retain their modifier bits and depend on the remote platform/site.
Plain-text copy/paste uses local clipboard gestures; cut remains suppressed.
The proxy's temporary composing value is never treated as a remote selection.
The proxy stays disabled while connecting, paused, unavailable, disconnected or
errored, so local Tab navigation can pass through the inactive viewer. It keeps
the same textarea node and becomes focusable again when streaming resumes.
Offscreen panels pause their owned stream where IntersectionObserver is available;
returning to view revalidates the selected target. Explicit pause and document
visibility still apply, and pausing discards unsent input as described below.

## Plain-text clipboard

With the remote proxy focused, Ctrl/Cmd+V consumes the actual local paste event's
plain text and inserts the whole string once into Chromium's current focused
control. Newlines do not become Enter keys or submit forms. The viewer does not
also read the clipboard asynchronously or forward a paste shortcut. Empty text
does nothing; non-text-only payloads and text over 64 Ki UTF-16 code units receive
a fixed diagnostic. Finish an active composition before copying or pasting.

Ctrl/Cmd+C reads the supported remote selection after earlier input has been
acknowledged. The local clipboard write starts in the original gesture with a
deferred text payload, so remote-read latency does not by itself lose that
gesture. The focused document/control chain is checked again before text is
returned. Owner changes cancel pending reads; uncertain writes are never replayed.
An empty selection preserves the previous clipboard content.

If automatic local writing is denied or unavailable, the viewer displays the
completed selection in a readonly **Text to copy** field. Focus it to select the
text and use your browser's native Copy command, or try **Copy text** with a fresh
gesture. These controls are local and do not send input to the remote page.
Dismissal, new remote edits, navigation, target changes and disposal clear the
recovery text. Clipboard text stays in the owning viewer's memory; it is excluded
from public status snapshots, diagnostics and persistence. Unsupported remote
selection produces a limitation message rather than unrelated fallback text.

| Copy source                                                                                                    | Boundary                                                 |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Native text/search/url/tel inputs and textarea                                                                 | Selected text, including readonly controls               |
| Page text with document focus and native contenteditable                                                       | Native DOM selection, not a site's custom copy payload   |
| Focused same-origin frames and open shadow roots                                                               | Bounded focused-chain traversal and document validation  |
| Password fields and controls without selection APIs                                                            | Unsupported; protected values are never extracted        |
| Cross-origin/OOPIF, closed shadow roots, opaque/non-editing focused hosts, canvas and custom editor selections | Unsupported; no retained top-document selection fallback |

Copy limits do not prevent normal native input/paste into focused cross-origin
frames. Rich formats, files/images, cut and application-defined clipboard
handlers are outside the plain-text contract. `Input.insertText` is text insertion
and does not synthesize a trusted remote paste event.

The initial automated client is full desktop Chromium, using genuine gestures
without manually granted clipboard permissions. Tests cover deferred writes,
trusted paste and browser-enforced Permissions-Policy denial with native recovery.
Safari, Firefox, physical OS clipboard integrations and actual user-denied
permission dialogs need separate validation. The client must run in a secure
context (HTTPS or a trusted loopback origin). An embedding host must allow the
appropriate clipboard policy for automatic writes; denial retains the native
manual-copy recovery. No remote system-clipboard permission is required.

## Composition and candidate placement

A stable, uncontrolled, visually transparent textarea hosts the local OS input
method. It remains rendered and focusable; `display:none`, `visibility:hidden`
and `type=hidden` cannot do this. Ordinary desktop keys use native keyboard
events. Completed Unicode composition and native text input use
`Input.insertText`. While composing, changed preedit is mirrored through
`Input.imeSetComposition` so Pinyin and other temporary text appear in the remote
editor. Confirmation replaces that native composition range once; cancellation
removes it. Adjacent unsent updates coalesce without crossing a final commit or
gesture, and late work stays bound to its original session/document/focus owner.
Composition/input event
ordering is consumed as a value boundary so a trailing final input does not
duplicate committed text or suppress a subsequent identical character.
Separate native text commits retain their event boundaries while waiting to be
sent, so a control can move focus before the next commit arrives.
Cancellation sends no committed text. Focus exit, pause and teardown cancel
owned preedit while the original document is retained; confirmed document loss
does not send old cancellation into the replacement. A definite unsupported
composition command falls back to final-text-only input for that input session;
ordinary keys and the local IME remain usable. Uncertain failures discard work
without replaying text. IME/229/composing Enter is kept separate from a later
ordinary Enter, which can submit the remote form or insert a newline.
Late composition values after blur or target replacement are discarded, including
events arriving after the native proxy has been refocused for another control.

For ordinary contenteditable selections, a collapsed DOM range supplies the
candidate anchor where available. Native input/textarea controls do not expose a
standard caret rectangle, so the fallback is near the focused control's top-left
editing area; the initial click is the fallback before remote geometry resolves.
Caret reads are optional and follow the current focused control through
accessible frames and shadow roots. Missing metadata, including inaccessible
cross-origin frames, leaves the click anchor in place and does not reject input.
The proxy uses the measured image transform and does not mirror remote values.
Exact native candidate-window placement still requires actual OS validation.

## Ownership, navigation and uncertain outcomes

Chromium routes keyboard and text events to its current native focus, including
same/cross-origin frames, Tab navigation and controls that a site replaces or
automatically focuses. Input does not require a retained DOM element or editable
control lookup. The browser decides whether the focused control accepts an event.

Unsent work is discarded on local blur, target/session replacement, observed
document/context navigation, pause, disconnect and unmount. Async continuations
check their original owner before sending. Owned key/button releases use their
original connection. Input sends remain ordered while acknowledgements settle
independently, with a combined bound on queued and in-flight work. Explicit toolbar
navigation waits for previously sent input to settle. Queued input/navigation is
never automatically replayed. A site can move its native focus before an
already-sent event executes.
Already accepted remote input cannot be cancelled or rolled back.

Pressed keys/buttons remain owned until their matching release response confirms
release. An old response cannot clear a later press of the same key/button. A failed
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
do not navigate. Enter, reload and available history actions are explicit standard
CDP requests and invalidate input before sending. Remote page addresses remain
in memory and may contain sensitive data; do not record them in snapshots/logs.

## Support and evidence matrix

| Surface                                          | Automated fixture                                      | Candidate anchor / limitation                                                 |
| ------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Top-document text input                          | Native text/emoji, selection, deletion, undo/redo      | Control rectangle fallback; not an exact input caret                          |
| Top-document textarea                            | Text and ordinary Enter/newline                        | Control rectangle fallback                                                    |
| Native contenteditable with nested rich markup   | Text replacement and Unicode                           | Collapsed selection range when exposed                                        |
| Open shadow-root text input                      | Native text input through an actual open-root control  | Closed-root candidate geometry is unavailable                                 |
| Automatic focus handoff / replaced input         | Sequential native keys reach the current control       | DOM identity changes do not require clicking again                            |
| Focused same-origin iframe                       | Keys, Unicode, Tab, textarea and contenteditable       | Accessible frame metadata can supply an anchor                                |
| Cross-origin / out-of-process iframe             | Same native input scenarios in an owned isolated frame | Click anchor when DOM metadata is inaccessible                                |
| Application editors such as ProseMirror/Lexical  | Not verified                                           | No application-specific editor compatibility claim                            |
| macOS system IMEs                                | Pending genuine OS receipt                             | Candidate placement, confirmation/cancellation and focus transitions required |
| Windows system IMEs                              | Pending genuine OS receipt                             | Same required native scenarios                                                |
| Other frontend browsers / provider CDP endpoints | Not verified by owned Chromium fixtures                | Capability, Origin and platform evidence required                             |

Synthetic composition exercises browser routing and event ordering, not a real
system IME. Genuine receipts must record source revision, client OS/browser,
IME name/version and remote Chromium version; exercise candidate placement,
confirmation versus submit, cancellation, repeated characters, emoji/mixed text,
toolbar/other-viewer focus, navigation and target replacement. Record outcomes
without input text, endpoint URLs, real content or unredacted traces/screenshots.
