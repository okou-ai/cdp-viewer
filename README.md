# cdp-viewer

A browser-native React viewer for existing Chrome DevTools Protocol browsers.
It provides **live streaming, target selection, optional window filtering,
and independent viewers**. Viewers are read-only by default. Enable `interactive`
for mouse, keyboard, native text composition, plain-text clipboard transfer,
remote navigation and tab creation/closure. Optional extensions can follow vendor activation events. Genuine macOS/Windows IME
validation remains pending; see the [interaction support matrix](https://github.com/okou-ai/cdp-viewer/blob/main/demo/interaction.md).

The package stays private and is distributed as source from GitHub. No npm
registry publication is planned. Supporting guide links below follow the repository's
`main` branch. For guides matching an installed revision, browse this repository
at the full commit SHA recorded in your lockfile.

Licensed under the [Apache License 2.0](./LICENSE).

## Try the demo

[Open the browser demo](https://okou-ai.github.io/cdp-viewer/). Paste your own
browser-level CDP WebSocket URL, optionally enter a window ID, then connect.
Add independent panels to view different windows. Draft edits apply only when
you choose **Apply & connect**; reconnect uses the last applied settings.
Each panel has optional **Extensions** checkboxes. Enable Browser Use to follow
active tabs reported by a compatible endpoint; leave all unchecked for standard
CDP. Extension choices apply with the other connection settings.

Each panel also offers pause/resume, interactive or view-only mode, independent
appearance and layout controls, a host-style preset, safe callback observations
and a usage example reflecting its applied configuration.

The demo enables interaction: click the live page to use your mouse and keyboard,
or use its address and history controls. Press **F8** to release remote keyboard
focus. Interactive viewers support plain-text copy/paste with an explicit local
copy recovery when automatic clipboard writing is blocked. Genuine
macOS/Windows system IME validation is pending. Connection details stay in page
memory and are cleared on refresh. An HTTPS page normally needs a
`wss://` endpoint whose server permits the page's Origin. See the
[connection and deployment guide](https://github.com/okou-ai/cdp-viewer/blob/main/demo/README.md) for parameters, network
requirements and compatibility evidence.

## Install from GitHub

In a React 19 application with a TS/TSX-capable bundler, replace the placeholder
with a verified full 40-character commit SHA from this repository:

```sh
pnpm add "github:okou-ai/cdp-viewer#<full-40-character-commit-sha>"
```

Commit the dependency and resolved lockfile in the consuming application. Upgrade
both in a reviewed change; roll back by restoring a previous verified SHA and
matching lockfile. Use immutable commits rather than a moving branch.

Public exports contain TS/TSX source and its types, plus a committed standalone
stylesheet. React and React DOM are host-provided peers. Consumers do not run a
viewer install-time build, install its development toolchain, or configure ccstate
or Tailwind. See [consumer verification](https://github.com/okou-ai/cdp-viewer/blob/main/CONTRIBUTING.md#consumer-verification)
for the tested toolchain.
Plain Node cannot import an uncompiled TSX entry; use a supported source-capable
bundler/runtime for SSR. Importing/rendering the viewer on the server opens no
browser connection.

```tsx
import { CdpViewer } from "cdp-viewer";
import "cdp-viewer/style.css";

export function BrowserViews({ cdpUrl }: { cdpUrl: string }) {
  return (
    <>
      <CdpViewer cdpUrl={cdpUrl} windowId={41} />
      <CdpViewer cdpUrl={cdpUrl} windowId={42} />
    </>
  );
}
```

These viewers run in the same host page and use the same browser-level `cdpUrl`
with different `windowId` values to access different windows of that browser
concurrently. Use actual window IDs from that browser; `41` and `42` are
illustrative. Each viewer opens its own connection and selected-target session.

## Connection and scope

`cdpUrl` must be a resolved **browser-level** absolute `ws://` or `wss://`
debugger endpoint. Authentication, browser provisioning, endpoint discovery, and
connection metadata belong to the host. Browser-native WebSocket cannot set
arbitrary authentication headers. HTTPS hosts ordinarily need a secure `wss://`
endpoint, and the server must permit the host's Origin. A working Node client
does not prove browser-origin access. Failures show fixed diagnostics without
echoing endpoints or provider error payloads.

Omit `windowId` to list page targets across windows. Supply an integer, including
`0`, to list/select only targets with verified membership. Scoped operation uses
the experimental `Browser.getWindowForTarget`; unsupported/failed lookup produces
an unavailable state, never an unscoped fallback. Target events update affected
pages; the active selection has an independent membership check every two seconds.
Silent title changes and other window moves are reconciled by full discovery
every ten seconds, including while paused, hidden or offscreen. Chromium may
omit a target event when a document title changes, so tab labels can lag until
that round. A full round has a ten-second completion deadline; failure clears
unverified targets instead of retaining them
indefinitely. Cadence plus completion can take up to twenty seconds while the
JavaScript event loop runs, and background timer suspension can delay discovery.
Title events neither renew membership age nor discard a valid in-flight window
check. Current checks can complete during continuous title changes; their age is
measured from request start. Older results cannot replace newer membership or
revive a removed target.
Selection/activation and completed attachment verify membership. Interactive input
then sends directly to the selected session, without a window query per event.
Selected membership expires twelve seconds after its last verification request
started; a delayed reply cannot renew it from arrival time. Expiry also blocks
local admission. Pausing ends this active check; resume freshly verifies attachment.
An external move can precede detection. Observed mismatch, expiry or lookup failure clears
the selection/image and cancels unsent input; it never silently replaces the target.
Inventory reconciliation is serialized/coalesced; selected checks run independently.
Scoped lookup failure clears unverified targets.
This is presentation scope, **not a server authorization boundary**.

A new connection initially chooses its first confirmed page. Losing an established
selection clears the image and requires explicit selection/recovery; it does not
guess a page by title, URL or list position. Viewing activates the selected tab in
its remote window so Chromium can produce live frames. Reconnect starts a fresh connection.
Changing callbacks does not reconnect. Unmounting releases this viewer's sessions
and connection without closing the remote browser or its tabs.

While switching tabs, the currently displayed image remains blurred behind the
static "Connecting to browser…" placeholder until the new selected page has
painted its first frame and interactive input is ready. Initial connections and
switches without a displayed image use the plain placeholder. The backdrop is
noninteractive and is cleared on pause, selection loss, fatal viewer failure,
disconnection and reconnect. Recoverable operation or configuration diagnostics
can preserve the live image; an `onError` report alone does not mean the viewer
has failed. The backdrop reuses the existing canvas; no per-tab images are
cached or persisted.

Favicons are read on demand from the selected page's declared icon URL, using its
existing control session after viewing/input are ready. Results stay in viewer
memory; they are absent from public snapshots and are cleared on reconnect.
Never-inspected tabs show the generic Globe. Document navigation refreshes the
declaration; icon-only DOM mutations are not watched. There is no favicon polling,
background attachment, guessed /favicon.ico, image-byte transfer over CDP or
viewer-managed persistent cache.
The host loads the image normally at low priority. Missing URLs, pending loads and
failures (including host CSP, authentication or reachability) show Globe; only a
successful load replaces it. Exact Chrome favicon selection is not promised.
Failed metadata reads are not retried; a later selected document can be inspected
after a definite session/context rejection. An unsupported command or uncertain
failure (including a request timeout) stops favicon discovery until reconnecting. Normal
viewing and input continue.

## API

| Prop                                          | Purpose                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `cdpUrl: string`                              | Required browser-level WS(S) endpoint                                            |
| `windowId?: number`                           | Optional presentation/selection scope                                            |
| `paused?: boolean`                            | Release this viewer's current stream while retaining connection/selection        |
| `interactive?: boolean`                       | Enable mouse, keyboard, native text input and page navigation; defaults to false |
| `showSettingsMenu?: boolean`                  | Show the settings menu beside the interactive address bar; defaults to true      |
| `transport?: "shared" \| "split"`             | Optional frame/control separation for interactive viewers; defaults to shared    |
| `windowSizeSync?: WindowSizeSync`             | Controlled display adaptation: `"off"`, `"initial"` or `"live"`                  |
| `onWindowSizeSyncChange`                      | Requests a controlled change, or reports a menu-owned change                     |
| `capture?: ViewerCaptureOptions`              | Live JPEG quality; automatic container/DPR bounds with optional fixed limits     |
| `extensions?: readonly ViewerExtension[]`     | Optional per-connection adapters, reconciled by ID and configuration key         |
| `colorScheme?: "light" \| "dark" \| "system"` | Optional host-controlled appearance; omitted inherits the host CSS color-scheme  |
| `className`, `style`                          | Host layout and instance-scoped theme customization                              |
| `onStatusChange`                              | Readonly semantic snapshot: status, page targets, selected ID, diagnostic        |
| `onError`                                     | Fixed diagnostic and optional command/code context; no raw provider payloads     |

Statuses are `connecting`, `streaming`, `paused`, `unavailable`, `disconnected`,
and `error`. Imported types include `CdpViewerProps`, `CdpViewerStyle`,
`ViewerCaptureOptions`, `ViewerSnapshot`, `ViewerTarget`, `ViewerStatus`, `ViewerNavigation`, `WindowSizeSync` and `ViewerError`.

`onStatusChange` reports snapshot changes. Equivalent target lists and navigation
observations retain the current snapshot and do not trigger another callback;
the callback is not a discovery heartbeat. Repeated operation warnings still
refresh their notification even when the public snapshot stays unchanged.

For constrained links, interactive hosts may opt into `transport="split"`.
Each viewer then opens two native WebSockets to the same `cdpUrl`, with separate
target sessions: one for control, input, navigation and sizing, and one for the
only screencast and its acknowledgements. View-only viewers always use one socket.
Capture quality, dimensions and native frame-credit defaults are unchanged.
This can reduce control-reply waiting behind large images; benefits depend on
the workload and connection, and it does not add downstream bandwidth.

The endpoint must permit both browser-Origin connections and simultaneous sessions;
check the provider's connection limits and billing. Generic provider compatibility
and physical OS IME are not implied. Losing either socket stops the whole viewer
and discards unsent input. Recovery is explicit through Reconnect or a host
configuration change, without automatic fallback or replay of uncertain actions.
If control is still available after frame loss, its original input cleanup is
allowed to settle before that socket closes; input admission stops immediately.
Changing `transport` reconnects the viewer; callbacks and live capture changes do
not. Keep `shared` for the lowest connection cost or unsupported endpoints.

Errors in `onError` and `ViewerSnapshot.error` include `kind` and a fixed `message`.
When a failed CDP request is known, optional `request` context identifies its
`method` and valid integer response `code`, for example:

```json
{
  "kind": "unsupported-capability",
  "message": "The browser does not support a required CDP viewer command.",
  "request": { "method": "Page.startScreencast", "code": -32601 }
}
```

Request timeouts identify the command without a response code. Wrapped input,
scope, tab and display failures retain the original request that caused the
failure or recovery. Browser/WebSocket failures may have no request context.
Parameters, raw provider messages, endpoint credentials and session IDs are
excluded. `onError` observes changes in the public diagnostic, including request
context; it is not a protocol traffic log.
Snapshots may include `navigation` (current remote address and available back/forward
actions), or `null` when unavailable. Remote page addresses can contain sensitive
data; do not log or persist snapshots indiscriminately.

### Image detail

Choose JPEG compression quality and maximum capture dimensions independently:

```tsx
<CdpViewer
  cdpUrl={cdpUrl}
  capture={{ quality: 70, maxWidth: 1280, maxHeight: 720 }}
/>
```

All three `ViewerCaptureOptions` fields are optional. Quality defaults to 70.
Omitted dimensions automatically follow the visible canvas container in CSS pixels
multiplied by the local device pixel ratio (DPR). Automatic bounds preserve the
container aspect ratio. All capture bounds share limits of 4096 pixels per edge
and 3840×2160 total pixels, including explicit settings.
Supplied dimensions override their respective automatic bounds independently,
including during display synchronization. Quality must be an integer from 0 to
100; each fixed dimension must be an integer from 1 to 4096. If both dimensions
are fixed, their product must fit the total pixel budget or the configuration is
rejected. If one dimension is fixed, the automatic axis fits the remaining budget
while preserving the fixed value.
These are capture ceilings: Chrome preserves the source aspect ratio and may
produce a smaller image. Higher settings can increase bandwidth and decoding
work; lower resolution can soften small text, especially when enlarged or on a
dense display. Encoded-frame resource limits still apply.

Changing these values restarts only this viewer's selected-session screencast.
The connection, selected page and native input/composition remain owned. The last
displayed image stays visible during the frame gap. In-flight same-page frames
may briefly reflect the previous setting; obsolete decode callbacks cannot
replace the current capture generation. Capture settings never resize/emulate the
remote page or change another viewer's settings. Automatic changes coalesce to
the latest measurement, at most once per 150ms, and continue during resizing.
An active native display synchronization takes priority; ordinary automatic
capture changes apply afterward, while required causal capture refreshes retain
their own bounded recovery.
A capture restart explicitly rejected during observed document replacement gets
one recovery attempt after navigation settles, on the same selected session.
The wait is bounded by the existing frame deadline; other capture failures retain
their diagnostics.

An image-only failure clears the image and disables input while retaining usable
connections and selected sessions. **Retry live image** becomes available after
the original capture and input cleanup are confirmed. It starts one new capture
on the same valid sessions, preserving their native display settings, without
reloading the page, reconnecting sockets or replaying input. Repeated clicks do
not start overlapping attempts. Input resumes only after a fresh image paints
and input initialization is ready.

**Reconnect viewer** remains a separate action for connection loss or recovery
whose original cleanup/fresh image cannot be confirmed. Unsupported capabilities
and configuration/scope errors do not offer image retry. Image retry uses native
Page/Runtime reads to confirm a fresh capture; it does not add those reads to
ordinary viewing or each input event. There is no automatic image retry or
WebSocket reconnect loop.

Pausing, hiding or moving a failed viewer offscreen does not start a retry.
Returning it to view leaves recovery explicit. If pause already released its
sessions after confirmed cleanup, retry revalidates and attaches the same target
on the existing connection. Losing that target still requires an explicit valid
target selection; recovery never silently picks a replacement.

Unavailable/zero-size surfaces retain the last valid bounds; before the first
measurement the bounded fallback is 1920×1080. Changes while paused apply on
resume. Equal effective settings do not restart. Remove a fixed dimension to
return that axis to automatic sizing. Window-size synchronization remains a
separate explicit capability.

Invalid settings report a `configuration` error. Invalid initial settings open
no connection; correcting them starts viewing. An invalid runtime update retains
the last valid capture, and correcting it clears its configuration diagnostic.
An actual stream failure uses normal viewer recovery. The library does not
persist capture preferences; hosts can provide their own controls.

### Interaction

```tsx
<CdpViewer cdpUrl={cdpUrl} interactive />
```

Click the remote image to focus its native input proxy. Local toolbar and host
fields retain their own input. **F8** releases remote keyboard focus to the selected
tab. Navigation and reload keep the viewer's existing keyboard focus while the
same selected tab remains available; moving focus to a local control leaves it
there. Keyboard input follows Chromium's current focus, including automatic
focus changes and focused frames. Composition stays in a stable local textarea
and mirrors preedit into the remote editor through CDP before committing the
selected text once. Unsupported composition commands retain final-text-only
input; candidate confirmation is distinct
from a later remote Enter. Optional caret metadata does not block input.
The tab strip compresses to fit its container and never scrolls horizontally.
Titles truncate, then narrow inactive tabs omit their close buttons; the selected
interactive tab prioritizes its close action. Full tab names remain accessible.
If the tabs cannot all fit at useful minimum widths, an **All tabs** popup
keeps every page reachable while the strip retains the selected page. Its styled
list inherits the viewer's theme, marks the current tab and wraps full titles.
Arrow keys move through the list; Enter selects, and Escape closes it. The popup
fits inside the viewer; long lists scroll vertically with the mouse wheel or
trackpad without scrolling the host page. This compact
fallback has no search field. Interactive viewers add new/close actions. The compact new-tab button
follows the tabs and stays reachable, showing a spinner during creation.
Enter in the address bar completes recognizable host addresses with `http://`
and passes explicit URL schemes to the remote browser. HTTPS upgrades and
destination support depend on that browser. Plain text is never sent to a search
engine. The navigation toolbar supports reload and
available history. See [interaction behavior and limits](https://github.com/okou-ai/cdp-viewer/blob/main/demo/interaction.md).

Ctrl/Cmd+V inserts local plain text once into the remote focused control.
Ctrl/Cmd+C copies supported remote text selections; blocked local writes expose
a readonly text field for native browser copying. Clipboard access requires a
secure client context and the embedding page's permission policy. Native text
controls, page text, same-origin frames and open shadow roots are supported;
password fields, inaccessible frames and application-defined clipboard payloads
are excluded. See the [clipboard contract](https://github.com/okou-ai/cdp-viewer/blob/main/demo/interaction.md#plain-text-clipboard)
for limits and the client-browser evidence boundary.

Each instance has its own socket, request IDs, timers, controller, private ccstate
store/context, Canvas queue, and cleanup. A host `ccstate-react` provider is
independent. Views of the same remote page still share the page's real website
state; **same-target simultaneous screencasts are not guaranteed**.
The required same-browser/different-window case has independent ownership.

The local image uses contain fitting. By default, the remote viewport is untouched.
Frames use one active decode and one newest queued frame;
Old-generation images and older timestamped readbacks are discarded.
`document.hidden`, `paused`, and an
offscreen viewer (when IntersectionObserver is available) release stream work;
resuming revalidates and attaches the selected target. Re-entering the viewport
does not override explicit pause or whole-document invisibility.
Cleanup cannot cancel a native image decode already in progress, but its result
is discarded and closed. No connection credentials are persisted by the library.

### Display adaptation

The three-dot menu to the right of the interactive address bar offers three modes:
**Do not sync automatically**, **Sync once on opening**, and **Sync continuously**.
Its single **Sync now** action always remains available when the stream and local
geometry are ready, and synchronizes both the page size and DPR in every mode.
It is temporarily disabled while a synchronization is pending. Modes apply per
viewer; the library does not persist settings.

Set `showSettingsMenu={false}` to hide the three-dot menu while keeping the address
bar and remote input. The default is `true`; view-only viewers still have no
navigation toolbar. Visibility changes apply without reconnecting and leave the
current synchronization mode intact, including host-controlled `windowSizeSync`.

```tsx
const [syncMode, setSyncMode] = useState<WindowSizeSync>("initial");

<CdpViewer
  cdpUrl={cdpUrl}
  windowId={windowId}
  interactive
  windowSizeSync={syncMode}
  onWindowSizeSyncChange={setSyncMode}
/>;
```

With `windowSizeSync`, the host owns the mode. The change callback requests a new
value; the mode changes only when the host updates the prop. Omitting the prop
gives the menu its own state, initially off, and the callback reports its changes.
Initialize host state to choose another starting mode; no separate default prop
is needed. Manual synchronization never changes the automatic mode.

Adaptation measures the available page surface in local CSS pixels and the client
browser's `devicePixelRatio`. It combines native content sizing with session-owned
page emulation so the logical page fits the surface and the screencast can carry
the corresponding physical pixels. This does not change the remote OS display
scale. Existing browser zoom settings are preserved during synchronization.
Continuous mode observes both surface size and DPR changes, coalesces work
with at least 150ms between operation starts, and retains one latest pending size.
Resizing keeps the socket, selected session and native input textarea intact.

Initial mode fits each real window once per connection. Reattaching a page in
that window restores its adapted density without refitting a changed local surface.
Manual synchronization updates it explicitly. Reconnecting starts fresh history.
Switching to off stops automatic updates; it does not undo the current display.
Detachment releases the session's emulation, while the last native window size
remains. Two viewers should control different remote windows; controllers of the
same window or page can compete over shared browser state.

Sizing retains the requested DPR and aspect ratio while reducing dimensions when
necessary: logical and physical edges are capped at 4096, and physical area at
3840 × 2160 pixels.
A density that cannot fit within the physical budget at minimum dimensions is
refused with a recoverable diagnostic.
These are protective product limits, not a universal performance guarantee.
Capture detail follows the independent image settings described above, within
the same capture edge and area limits in every display mode.
High DPR still increases capture, transport and decode cost within those limits.

Native sizing and emulation require browser support. Non-normal windows must be
restored first; unsupported commands produce a recoverable diagnostic and leave
viewing available. Synchronization remains pending until the new image paints;
pointer actions pause while native changes or a compatible image are pending.
When a DPR/layout change can keep the same image dimensions, the viewer refreshes
capture once on the existing session and requires a timestamp after the native
change. Ordinary size changes keep the current stream running.
If a frame claims the new size but its decoded pixels are clipped, the viewer
refreshes capture once on the same session and requires a fresh compatible image.
This conditional refresh uses the remaining presentation budget; persistent
clipping follows the same bounded recovery path as a missing image.
If display recovery cannot be confirmed, they remain paused
until synchronization succeeds; choose **Sync now** to retry. Text input remains
available. Native minimum sizes, fractional scale rounding and provider
restrictions may prevent exact matching. This is not browser zoom or a general
capture-quality selector. A controlled mode without `onWindowSizeSyncChange`
disables menu mode changes, while manual synchronization remains usable.

## Extensions

Standard viewing requires no adapter or vendor runtime. Browser Use activation
support is an optional import; an endpoint that never emits the event continues
to work as ordinary CDP:

```tsx
import { CdpViewer } from "cdp-viewer";
import { browserUse } from "cdp-viewer/extensions/browser-use";

<CdpViewer cdpUrl={cdpUrl} windowId={windowId} extensions={[browserUse()]} />;
```

The adapter follows browser-level `BrowserUse.activeTargetChanged` events with a
nonempty string `targetId`. Session-level, malformed, unknown, unavailable and
out-of-window suggestions are ignored. A candidate must already appear in the
viewer's discovered page list; the core rechecks its live page identity and window
membership before changing selection. Selecting the current target supersedes
older pending suggestions without restarting its stream. Pending requests lose
authority on adapter/connection replacement, intervening target discovery changes,
a newer valid suggestion or explicit user selection. Events are not buffered or replayed.
The event has no required sequence/timestamp; ordering follows this connection's
locally observed events rather than a provider clock. Live Browser Use service
compatibility requires separate provider evidence.

Import `ViewerExtension`, `ExtensionContext`, `ExtensionEvent`, `ExtensionState`
and `ExtensionCleanup` from the root or the type-only `cdp-viewer/extensions`
entry. A custom vendor-event adapter needs no core changes:

```tsx
import type { ViewerExtension } from "cdp-viewer/extensions";

function customVendor(channel: string): ViewerExtension {
  return {
    id: "custom-activation",
    key: channel,
    setup(context) {
      return context.subscribe(
        `${channel}.activeTargetChanged`,
        async (event) => {
          const id = event.params.targetId;
          if (
            event.sessionId !== undefined ||
            typeof id !== "string" ||
            !id.trim()
          )
            return;
          await context.requestTargetSelection(id);
        },
      );
    },
  };
}

<CdpViewer cdpUrl={cdpUrl} extensions={[customVendor("MyVendor")]} />;
```

Each accepted setup runs separately for each viewer and connection, including
when a descriptor is reused. Put mutable adapter state inside `setup`.
`context.signal` aborts on removal, configuration replacement, disconnection or
unmount. Subscriptions are automatically removed; their returned unsubscribe
functions are also safe to call explicitly. Setup may return a cleanup function
or a promise for one; cleanup may be asynchronous. Abort/unsubscribe happens
immediately, late setup results are still cleaned, and same-ID configuration
replacement waits for the old setup/cleanup to finish. Unrelated adapters proceed
independently. Custom asynchronous work must cooperate with the signal; a setup
or cleanup promise that never settles holds up that ID's replacement.

Reconciliation uses `id` plus optional string `key`. New array, descriptor or
setup callback references alone preserve the existing setup and never reconnect
the socket. Change `key` when captured configuration/callbacks need a new setup;
an active setup keeps its original closure. Removing then adding an ID also
starts a new lifetime. Changing `cdpUrl`, `windowId`, interactive mode or explicitly
reconnecting creates a fresh connection with the latest supplied descriptors.
Duplicate IDs or invalid descriptors reject the whole update while retaining the
last valid set (none initially); repeated equivalent invalid updates do not loop.

`getState()` returns readonly status, selected target ID and configured
`windowScoped`/`interactive` capabilities, excluding endpoint, page titles/content/
addresses and raw errors. These capabilities describe viewer configuration,
not provider support. After retirement it returns a disconnected state.
`requestTargetSelection(id)` resolves `true` only when the suggestion changes
selection; ignored, stale, already-selected or unverifiable requests resolve
`false`. The context exposes no raw transport or arbitrary command interface.

Setup and synchronous/asynchronous event-handler failures retire the offending
adapter; cleanup failures are contained. Fixed `onError` diagnostics have
`kind: "extension"` and exclude adapter IDs and raw exception/provider payloads.
Other adapters and standard viewing remain usable. A failed ID/key is not retried
by rerendering: change its key, remove/re-add it, or reconnect to retry deliberately.

## Styling

The Chrome-style controls include light and dark palettes. Appearance defaults to
the host container's CSS `color-scheme`. Pass the host's existing preference as
`colorScheme="light"`, `"dark"` or `"system"` to override it; `system` follows OS
changes. Class-based host themes can pass their setting or declare `color-scheme`
on the surrounding container. Changing appearance preserves the connection,
selection and native input nodes. Each viewer can use a different override.

Import `cdp-viewer/style.css` once. The package includes committed compiled prefixed Tailwind
utilities and scoped component selectors, without global Preflight. It works in
plain hosts and alongside conflicting unprefixed utility names.

Set instance-specific `--cdpv-background`, `--cdpv-foreground`, `--cdpv-muted`,
`--cdpv-border`, `--cdpv-accent`, or `--cdpv-radius` variables through `style`.
Default height is 28rem; set `style={{ height: "70vh" }}` for host layout.
`--cdpv-tab-background`, `--cdpv-address-background` and `--cdpv-stage-background`
customize the individual surfaces.
Canvas decode/paint does not cause a React update for every frame.

See [host integration boundaries](https://github.com/okou-ai/cdp-viewer/blob/main/docs/host-integration.md) for form embedding,
host shortcuts and the engineering conventions that keep normal integrations
independent.

## Validation and compatibility

Independent consumer checks validate immutable GitHub source installation,
distributed files and README links, host-provided peers, public types, production
builds and source SSR. Real-browser fixtures exercise installed public exports.
See the [validation strategy](https://github.com/okou-ai/cdp-viewer/blob/main/docs/validation.md)
for test boundaries and evidence requirements.

Initial automation targets current desktop Chromium. Experimental remote CDP
capabilities, provider Origin/TLS policy and other client browsers must be recorded
before compatibility is claimed. Browser Use connectivity and connections from
GitHub Pages require their own deployed-Origin evidence; see the
[demo guide](https://github.com/okou-ai/cdp-viewer/blob/main/demo/README.md).

## Contributing

See [CONTRIBUTING.md](https://github.com/okou-ai/cdp-viewer/blob/main/CONTRIBUTING.md)
for the developer setup and check commands. Commits follow
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
