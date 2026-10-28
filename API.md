# API reference

See [README](README.md) for installation and a minimal example. This reference
describes the library contract; the [demo guide](demo/README.md) covers controls
and the [interaction guide](demo/interaction.md) covers input behavior and limits.

## Props and types

| Prop                                          | Purpose                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `cdpUrl: string`                              | Required browser-level WS(S) endpoint                                               |
| `windowId?: number`                           | Optional presentation/selection scope; `0` is present                               |
| `paused?: boolean`                            | Release the current stream while retaining connection/selection                     |
| `interactive?: boolean`                       | Enable remote input, navigation and tab creation/closure; defaults to false         |
| `showSettingsMenu?: boolean`                  | Show the interactive toolbar's settings menu; defaults to true                      |
| `transport?: "shared" \| "split"`             | Frame/control transport mode; defaults to shared                                    |
| `onTransportChange`                           | Requests a controlled transport change, or reports a menu-owned change              |
| `windowSizeSync?: WindowSizeSync`             | Display adaptation: `"off"`, `"initial"` or `"live"`; defaults to off               |
| `onWindowSizeSyncChange`                      | Requests a controlled sync mode change, or reports a menu-owned change              |
| `capture?: ViewerCaptureOptions`              | WebP/JPEG format, image quality and automatic or fixed maximum image dimensions     |
| `onCaptureChange`                             | Requests a controlled capture change, or reports a menu-owned change                |
| `extensions?: readonly ViewerExtension[]`     | Optional adapters, reconciled by ID and configuration key                           |
| `colorScheme?: "light" \| "dark" \| "system"` | Appearance override; omitted inherits the host CSS color-scheme                     |
| `className`, `style`                          | Host layout and instance-scoped theme customization                                 |
| `onStatusChange`                              | Readonly snapshot: status, targets, selected ID, diagnostic and optional navigation |
| `onError`                                     | Fixed diagnostic with optional failed-command context                               |

Root type exports include `CdpViewerProps`, `CdpViewerStyle`,
`ViewerCaptureFormat`, `ViewerCaptureOptions`, `ViewerSnapshot`, `ViewerTarget`, `ViewerStatus`,
`ViewerNavigation`, `ViewerTransport`, `WindowSizeSync` and `ViewerError`.
Extension types are also available from `cdp-viewer/extensions`.

### Runtime requirements

Client mounting requires `AbortSignal.any`, `Uint8Array.fromBase64`,
`createImageBitmap`, `ResizeObserver`, `IntersectionObserver` and `window.matchMedia`.
Missing APIs throw a `TypeError` naming the requirement before listeners,
observers or connections are acquired. This applies to paused and view-only
viewers too; there are no bundled polyfills or reduced-functionality paths.
Hosts can handle it with a React error boundary. Imports and server rendering
do not perform the check or acquire browser resources.

## Connection and scope

`cdpUrl` must be a resolved absolute **browser-level** `ws://` or `wss://`
debugger endpoint. URL userinfo and fragments are rejected; provider path/query
credentials are accepted. The host owns provisioning, authentication and discovery.
Browser-native WebSocket cannot add arbitrary auth headers. HTTPS hosts normally
need `wss://` with trusted TLS and an endpoint that permits their Origin.

Omit `windowId` to discover pages across windows. Supply a safe integer, including
`0`, to list/select only confirmed window members. Scoped operation requires
`Browser.getWindowForTarget`; failed or unsupported lookup becomes unavailable,
never an unscoped fallback. Filtering is presentation scope, not endpoint access
control or an atomic cross-client handover boundary.

Target events update affected pages. Active selected-window membership is checked
independently every two seconds; full discovery reconciles silent title changes
and window moves every ten seconds, including while paused, hidden or offscreen.
A full round has a ten-second completion deadline; cadence plus completion can
take up to twenty seconds, and background timer suspension can delay it further.
Selected membership expires twelve seconds after the verification request starts,
not after its reply. Selection/activation and completed attachment also verify
membership. Stable input does not query the window per event. An external move
can precede detection; mismatch, expiry or lookup failure clears selection/image
and cancels unsent input. Pausing ends the active check; resume verifies afresh.

Discovery has no fixed target-count cap, but is subject to metadata-memory,
message-size and verification limits. Resource exhaustion reports unavailable;
it never silently truncates tabs or exposes an unfiltered list.

### Selection and lifecycle

A fresh connection chooses its first confirmed page. Viewing activates the tab
in its remote window to produce frames. Losing an established selection requires
explicit selection/recovery; the viewer does not silently choose another page.
See [tabs and recovery](demo/README.md#tabs-and-recovery) for user actions.

Each viewer owns independent connections, sessions, state, input and rendering.
Sharing an endpoint with different real `windowId` values supports concurrent
windows. Website state remains shared; same-target simultaneous screencasts are
not guaranteed. Host ccstate providers remain independent.

`paused`, whole-document invisibility and an offscreen surface release stream
work. Resuming revalidates the selected target; returning onscreen does not
override explicit pause or document invisibility. Callback identity changes do
not reconnect. Changing `cdpUrl`, `windowId`, `interactive` or `transport`, or
explicitly reconnecting, starts a fresh connection. Unmount releases only owned
resources, preserving the remote browser and its tabs. Connection credentials
and viewer preferences are not persisted by the library.

## Controlled configuration

`transport`, `capture` and `windowSizeSync` share the same ownership convention:

- Omit the prop for independent, per-viewer menu state. Its callback reports changes.
- Supply the prop for host-controlled state. Its callback requests an update;
  the value changes only when the host changes the prop. Without a callback,
  those menu controls are disabled.
- Hiding the settings menu preserves current settings. Manual **Fit page to
  viewer** remains usable with a controlled sync mode and does not change it.

```tsx
import { useState } from "react";
import { CdpViewer } from "cdp-viewer";
import type {
  ViewerCaptureOptions,
  ViewerTransport,
  WindowSizeSync,
} from "cdp-viewer";
import "cdp-viewer/style.css";

export function ControlledViewer({ cdpUrl }: { cdpUrl: string }) {
  const [transport, setTransport] = useState<ViewerTransport>("shared");
  const [capture, setCapture] = useState<ViewerCaptureOptions>({
    format: "webp",
    quality: 70,
  });
  const [syncMode, setSyncMode] = useState<WindowSizeSync>("initial");

  return (
    <CdpViewer
      cdpUrl={cdpUrl}
      interactive
      transport={transport}
      onTransportChange={setTransport}
      capture={capture}
      onCaptureChange={setCapture}
      windowSizeSync={syncMode}
      onWindowSizeSyncChange={setSyncMode}
    />
  );
}
```

### Transport

`shared` uses one native WebSocket. Interactive `split` opens two connections to
the same endpoint with separate sessions: one for control/input/navigation/sizing,
one for the sole screencast and its acknowledgements. View-only mode always uses
one connection. Split can reduce control replies waiting behind images; it does
not add downstream bandwidth or change capture detail.

The endpoint must allow both browser-Origin connections and simultaneous sessions;
check provider limits and billing. Losing either socket stops the entire viewer
and discards unsent input. Original input cleanup can settle if control is still
available. Recovery requires explicit reconnect or configuration change, with no
automatic fallback or replay. Selecting the current mode does not reconnect;
changing modes retains capture/display preferences.

### Capture quality

`ViewerCaptureOptions` has four optional fields:

| Field       | Accepted value       | Default                       |
| ----------- | -------------------- | ----------------------------- |
| `format`    | `"webp"` or `"jpeg"` | `"webp"`                      |
| `quality`   | Integer 0–100        | 70                            |
| `maxWidth`  | Integer 1–4096       | Container width × client DPR  |
| `maxHeight` | Integer 1–4096       | Container height × client DPR |

WebP is the default image format. Set `capture={{ format: "jpeg" }}` to
request JPEG explicitly. This also applies when upgrading a host that previously
omitted the format and received JPEG. The remote endpoint must support the chosen
`Page.startScreencast` format; support varies by browser/version/provider. There
is no automatic fallback. If an endpoint rejects WebP, select JPEG in the menu
(or update the controlled prop), then use **Retry image** after cleanup completes.
Quality applies to both formats, but the same number does not imply equal visual
quality or byte size across codecs. `ViewerCaptureFormat` names the format union.

All bounds share a 4096-pixel edge limit and 3840×2160 total-pixel budget.
Automatic bounds preserve the container aspect ratio. Each fixed dimension
independently overrides its automatic axis. Two fixed dimensions must fit the
area budget; with one fixed dimension, the automatic axis fits the remaining
budget. These are capture ceilings: Chrome preserves the source aspect ratio
and may return smaller images. Higher settings cost bandwidth/decode work;
lower resolution can soften text. Encoded-frame resource limits still apply.

Changing capture settings restarts only the selected-session screencast, keeping
the connection, selection, native input/composition and last displayed image.
In-flight same-page frames may briefly use the previous settings. Automatic
resize changes are coalesced with bounded progress; explicit preferences apply
immediately. Capture settings do not resize/emulate the remote page. Display
synchronization takes priority over ordinary automatic capture changes.

Zero-size/unavailable surfaces retain the last valid bounds; before measurement
the fallback is 1920×1080. Paused changes apply on resume. Equivalent effective
settings do not restart; removing a fixed dimension restores automatic sizing.
Invalid initial settings open no connection. An invalid runtime update reports
`configuration` while retaining the last valid capture; correcting it clears
that diagnostic. See [image recovery](demo/README.md#image-recovery) for stream failures.

Custom or independent per-axis host bounds may match no menu resolution preset.
Editing format or quality preserves them; choosing Auto removes both fixed
dimensions while retaining format and quality. The settings panel offers WebP
and JPEG under **Image format**, followed by the existing resolution choices.

### Display adaptation

The local image uses contain fitting; by default it does not change the remote
viewport. `windowSizeSync` opts into remote size and pixel-density adaptation:

| Mode      | Behavior                                                             |
| --------- | -------------------------------------------------------------------- |
| `off`     | No automatic updates; keeps the last applied native size and density |
| `initial` | Fits each real window once per connection                            |
| `live`    | Also follows local page-surface dimensions and client DPR            |

**Fit page to viewer** applies once in any mode, without changing that mode.
Reattaching a page in an initially fitted window restores its adapted density
without refitting a changed local surface; reconnect starts fresh history.
Detachment releases session emulation, while the last native window size remains.
Viewers adapting the same remote window/page can compete over shared state.

Adaptation combines native content sizing and session-owned page emulation;
it preserves browser zoom and does not change remote OS display scale.
Resizing retains the connection, selected session and native input node.
Logical and physical edges are capped at 4096 and physical area at 3840×2160.
Dimensions shrink while retaining requested DPR/aspect ratio when necessary;
a density that cannot fit at minimum dimensions gets a recoverable diagnostic.
Capture quality remains independent, within its image limits above.

Restore non-normal remote windows before syncing. Unsupported native sizing or
emulation commands report recoverable diagnostics while viewing remains available.
Pointer actions pause until compatible pixels paint; text input remains available.
If recovery cannot be confirmed, use **Fit page to viewer** to retry. Native
minimum sizes, fractional rounding and provider restrictions may prevent an exact
match. See the [display architecture](docs/display-architecture.md) for geometry,
presentation and recovery ownership.

## Snapshots and errors

Statuses are `connecting`, `streaming`, `paused`, `unavailable`, `disconnected`
and `error`. `onStatusChange` reports semantic snapshot changes, not discovery
heartbeats. Equivalent target/navigation observations do not trigger another
callback. Repeated warnings can still refresh the notification.

`onError` and `ViewerSnapshot.error` contain `kind`, a fixed `message` and optional
original failed-command context:

```json
{
  "kind": "unsupported-capability",
  "message": "The browser does not support a required CDP viewer command.",
  "request": { "method": "Page.startScreencast", "code": -32601 }
}
```

Timeouts identify the command without a response code; some failures have no
request context. Parameters, raw provider messages, endpoint credentials and
session IDs are excluded. `onError` observes diagnostic changes, not protocol
traffic. A recoverable diagnostic may preserve the live image; an error callback
alone does not imply fatal viewer failure.

Snapshots include target IDs/titles and may include `navigation` with the remote
address and available history actions, or `null` when unavailable. Addresses can
contain sensitive data; do not log or persist snapshots indiscriminately.

## Extensions

Standard CDP needs no adapter. Browser Use activation support is optional:

```tsx
import { CdpViewer } from "cdp-viewer";
import { browserUse } from "cdp-viewer/extensions/browser-use";

<CdpViewer cdpUrl={cdpUrl} windowId={windowId} extensions={[browserUse()]} />;
```

The adapter follows browser-level `BrowserUse.activeTargetChanged` events with a
nonempty string `targetId`. Malformed, session-level, unknown, unavailable or
out-of-window suggestions are ignored. The candidate must already be discovered;
the core rechecks live page identity and window membership. Already-selected
suggestions supersede older pending ones without restarting the stream.
Replacement, discovery changes, newer valid suggestions or explicit user selection
retire pending authority. Events follow locally observed order, without a required
provider timestamp/sequence, buffering or replay. Endpoints without these events
continue as standard CDP; live Browser Use compatibility requires its own evidence.

### Custom adapters

Import `ViewerExtension`, `ExtensionContext`, `ExtensionEvent`, `ExtensionState`
and `ExtensionCleanup` from the root or the type-only `cdp-viewer/extensions`
entry. For example:

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
```

Pass descriptors through `extensions={[customVendor("MyVendor")]}`. Each viewer
and connection gets its own setup, even when a descriptor is reused. Put mutable
adapter state inside `setup`. `context.signal` aborts on removal, configuration
replacement, disconnect or unmount; subscriptions are removed automatically.
Returned unsubscribe functions are safe to call explicitly. Setup can return a
cleanup or promise for one; late results are cleaned and cleanup can be async.
Same-ID replacement waits for the old setup/cleanup, while unrelated adapters
proceed independently. Custom async work must cooperate with the signal; a
never-settling setup/cleanup blocks that ID's replacement.

Reconciliation uses `id` and optional string `key`. New arrays, descriptors or
callback identities alone preserve setup and do not reconnect. Change `key` when
captured configuration/callbacks need replacement; otherwise setup retains its
original closure. Removing/re-adding an ID or starting a fresh connection also
creates a new lifetime. Invalid/duplicate descriptors reject the whole update
while retaining the last valid set (none initially).

`getState()` returns readonly status, selected target ID and configured
`windowScoped`/`interactive` capabilities, not provider support. It excludes
endpoints, titles, content, addresses and raw errors; after retirement it returns
disconnected. `requestTargetSelection(id)` resolves `true` only for a changed
selection; ignored/stale/current/unverifiable suggestions resolve `false`.
The context exposes no raw transport or arbitrary command interface.

Setup or sync/async event-handler failures retire that adapter; cleanup failures
are contained. Fixed `kind: "extension"` diagnostics exclude IDs and raw payloads;
other adapters and standard viewing remain usable. Rerendering does not retry a
failed ID/key: change its key, remove/re-add it or reconnect deliberately.

## Styling

Import `cdp-viewer/style.css` once. Its compiled prefixed utilities and scoped
selectors require no host Tailwind setup and include no global Preflight.
Internal DOM/classes are not customization APIs; see [host integration](docs/host-integration.md).

Appearance inherits the host CSS `color-scheme`. Use `colorScheme="light"`,
`"dark"` or `"system"` to override it; system follows OS changes. Class-based
themes can pass their setting or declare `color-scheme` on the parent. Changes
preserve the connection, selection and native input nodes.

Set instance-specific variables through `style`:

- General: `--cdpv-background`, `--cdpv-foreground`, `--cdpv-muted`,
  `--cdpv-border`, `--cdpv-accent`, `--cdpv-radius`.
- Surfaces: `--cdpv-tab-background`, `--cdpv-address-background`,
  `--cdpv-stage-background`.

Default height is 28rem; set outer dimensions with `style`, for example
`style={{ height: "70vh" }}`, or a host `className`.
