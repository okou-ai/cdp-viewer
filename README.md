# cdp-viewer

A browser-native React viewer for existing Chrome DevTools Protocol browsers.
It provides **live streaming, target selection, optional window filtering,
and independent viewers**. Viewers are read-only by default. Enable `interactive`
for mouse, keyboard, native text composition, plain-text clipboard transfer,
remote navigation and tab creation/closure. Optional extensions can follow vendor activation events. Genuine macOS/Windows IME
validation remains pending; see the [interaction support matrix](demo/interaction.md).

The package stays private and is distributed as source from GitHub. No npm
registry publication is planned.

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
[connection and deployment guide](demo/README.md) for parameters, network
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
or Tailwind. The consumer checks use pnpm 10.33.4, React 19.2.6 and Vite 8.
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
an unavailable state, never an unscoped fallback. Membership is refreshed on
target events and every two seconds to detect external moves; lookup and refresh
latency add to detection time, so this interval is not a maximum deadline.
Selection/activation and completed attachment verify membership. Interactive input
then sends directly to the selected session, without a window query per event.
An external move can precede detection. Observed mismatch or lookup failure clears
the selection/image and cancels unsent input; it never silently replaces the target.
Discovery is serialized/coalesced; scoped lookup failure clears unverified targets.
This is presentation scope, **not a server authorization boundary**.

A new connection initially chooses its first confirmed page. Losing an established
selection clears the image and requires explicit selection/recovery; it does not
guess a page by title, URL or list position. Viewing activates the selected tab in
its remote window so Chromium can produce live frames. Reconnect starts a fresh connection.
Changing callbacks does not reconnect. Unmounting releases this viewer's sessions
and connection without closing the remote browser or its tabs.

## API

| Prop                                          | Purpose                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `cdpUrl: string`                              | Required browser-level WS(S) endpoint                                            |
| `windowId?: number`                           | Optional presentation/selection scope                                            |
| `paused?: boolean`                            | Release this viewer's current stream while retaining connection/selection        |
| `interactive?: boolean`                       | Enable mouse, keyboard, native text input and page navigation; defaults to false |
| `windowSizeSync?: WindowSizeSync`             | Controlled display adaptation: `"off"`, `"initial"` or `"live"`                  |
| `onWindowSizeSyncChange`                      | Requests a controlled change, or reports a menu-owned change                     |
| `extensions?: readonly ViewerExtension[]`     | Optional per-connection adapters, reconciled by ID and configuration key         |
| `colorScheme?: "light" \| "dark" \| "system"` | Optional host-controlled appearance; omitted inherits the host CSS color-scheme  |
| `className`, `style`                          | Host layout and instance-scoped theme customization                              |
| `onStatusChange`                              | Readonly semantic snapshot: status, page targets, selected ID, diagnostic        |
| `onError`                                     | Fixed diagnostic category/message, excluding raw provider payloads               |

Statuses are `connecting`, `streaming`, `paused`, `unavailable`, `disconnected`,
and `error`. Imported types include `CdpViewerProps`, `CdpViewerStyle`,
`ViewerSnapshot`, `ViewerTarget`, `ViewerStatus`, `ViewerNavigation`, `WindowSizeSync` and `ViewerError`.
Snapshots may include `navigation` (current remote address and available back/forward
actions), or `null` when unavailable. Remote page addresses can contain sensitive
data; do not log or persist snapshots indiscriminately.

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
available history. See [interaction behavior and limits](demo/interaction.md).

Ctrl/Cmd+V inserts local plain text once into the remote focused control.
Ctrl/Cmd+C copies supported remote text selections; blocked local writes expose
a readonly text field for native browser copying. Clipboard access requires a
secure client context and the embedding page's permission policy. Native text
controls, page text, same-origin frames and open shadow roots are supported;
password fields, inaccessible frames and application-defined clipboard payloads
are excluded. See the [clipboard contract](demo/interaction.md#plain-text-clipboard)
for limits and the client-browser evidence boundary.

Each instance has its own socket, request IDs, timers, controller, private ccstate
store/context, Canvas queue, and cleanup. A host `ccstate-react` provider is
independent. Views of the same remote page still share the page's real website
state; **same-target simultaneous screencasts are not guaranteed**.
The required same-browser/different-window case has independent ownership.

The local image uses contain fitting. By default, the remote viewport is untouched.
Frames use one active decode and one newest queued frame;
old-generation images are discarded/closed. `document.hidden`, `paused`, and an
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
scale. Continuous mode observes both surface size and DPR changes, coalesces work
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
3840 × 2160 pixels. The menu reports **Size limit reached** when constrained.
A density that cannot fit within the physical budget at minimum dimensions is
refused with a recoverable diagnostic.
These are protective product limits, not a universal performance guarantee.
Opting into adaptation raises the screencast ceiling to 4096 × 4096 once on the
same session; untouched viewing retains JPEG quality 70 and 1920 × 1080 caps.
High DPR still increases capture, transport and decode cost within those limits.

Native sizing and emulation require browser support. Non-normal windows must be
restored first; unsupported commands produce a recoverable diagnostic and leave
viewing available. Native minimum sizes, fractional scale rounding and provider
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

See [host integration boundaries](docs/host-integration.md) for form embedding,
host shortcuts and the engineering conventions that keep normal integrations
independent.

## Validation and compatibility

```sh
pnpm install --frozen-lockfile
pnpm css:check
pnpm build
pnpm build:demo
pnpm format:check
pnpm lint
pnpm check-types
pnpm knip
pnpm test:package
```

Run `pnpm css:write` after editing viewer styles/classes and commit
`styles/viewer.css`. The consistency check regenerates CSS in memory and fails
on drift. The library/declaration build is an internal validation artifact;
consumers use source exports and do not need `dist/`.

The PR pipeline additionally runs the full unit suite and real-browser fixtures.
Follow repository/user guidance: no full local Vitest run or dev server unless
explicitly requested. Targeted protocol tests may be used for focused debugging.

`pnpm test:package` installs the current pushed Git commit from GitHub in a
separate temporary consumer. It verifies source/CSS file inclusion, React peers,
strict public types, a production build and bundled SSR without a connection.
Installation disables lifecycle scripts and automatic peer installation; a fresh
offline frozen reinstall must preserve the generated lockfile. The receipt under
`test-results/package/` records the actual source and lockfile hash.

`CDP_VIEWER_SOURCE_SHA` and `CDP_VIEWER_SOURCE_REPO` select an explicit immutable
GitHub revision; CI uses the pushed PR source SHA/repository rather than its
synthetic merge commit. Before pushing local changes, an explicit
`CDP_VIEWER_CONSUMER_SOURCE=tarball` selects supplementary local-pack verification.
It does not count as real GitHub distribution acceptance; the default never
silently falls back to local files.

Browser tests consume those same installed public exports. They create
test-owned Chromium windows and a bounded fixture HTTP server; a test-only extension
allows moving an actual tab between windows. Run browser fixtures with an installed
Playwright Chromium, or set `CDP_VIEWER_CHROMIUM` to an existing Chromium executable.
No browser provisioning service or development server is required for fixtures.

Initial automation targets current desktop Chromium. Experimental remote CDP
capabilities, provider Origin/TLS policy and other client browsers must be recorded
before compatibility is claimed. Browser Use connectivity and connections from
GitHub Pages require their own deployed-Origin evidence; see the
[demo guide](demo/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits follow
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
