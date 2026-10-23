# Browser demo

The [GitHub Pages demo](https://okou-ai.github.io/cdp-viewer/) uses the same public
`cdp-viewer` component/types and `cdp-viewer/style.css` exports as consumers.
It enables the public `interactive` option for live viewing, tab selection,
tab creation/closure, mouse/keyboard input, plain-text clipboard transfer and
navigation, with independent panels. Optional extensions use the public adapter
exports; Browser Use is the currently available choice. Genuine macOS/Windows
system IME and live Browser Use provider validation remain pending.

## Connect

1. Obtain a browser-level CDP WebSocket endpoint from a browser you control.
   Provisioning, authentication and endpoint discovery belong to your provider.
2. Paste it into the masked **CDP URL** field. Optionally supply an actual
   **Window ID** and tick any optional **Extensions**. Choose **Connect**.
3. Select a page in the viewer's top tab strip. Add another viewer
   to control a different window independently. For windows of the same browser,
   use the same **CDP URL** in each panel with different actual **Window ID** values.

Selecting a page activates that tab in its remote window so it can produce live
frames.

| Parameter  | Accepted value                                   | Behavior                                                                                                                                     |
| ---------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| CDP URL    | Absolute `ws://` or `wss://` browser endpoint    | Required. Native WebSocket does not support arbitrary auth headers, URL userinfo or fragments. Provider query/path credentials are accepted. |
| Window ID  | Omitted or a safe integer, including `0`         | Omitted lists pages across windows. Present limits listing/selection to confirmed members of that window.                                    |
| Extensions | Independent checkboxes, all unchecked by default | Enable optional adapters for this panel. Browser Use follows endpoint-reported active tabs within the configured window scope.               |

Window IDs are browser-owned values, not tab indexes. Scoped viewing requires
`Browser.getWindowForTarget`; unsupported lookup, an empty/missing window or lost
membership produces an unavailable state. It never falls back to displaying all
windows. Filtering is presentation scope, not a server authorization boundary.

Editing fields does not alter the live connection. **Apply & connect** commits
the draft and creates a fresh viewer. **Reconnect** uses the last applied
settings, ignoring drafts. **Disconnect** unmounts that panel's viewer; its draft
remains in the form so you can connect again. **Remove viewer** removes its state.
Neither action closes the remote browser or its tabs. Refresh clears all panels
and settings. No endpoint is read from or written to the page URL, storage or
analytics. The app has no telemetry or third-party scripts/fonts.

Extension choices are independent, so multiple adapters can be enabled together
when available. Checkbox edits are drafts until **Connect** or **Apply & connect**;
**Reconnect** keeps the last applied extension list. The demo passes these
descriptors directly to the public component, which owns their subscriptions and
cleanup. Browser Use requires browser-level `BrowserUse.activeTargetChanged`
events from the endpoint. Choosing it does not provision a browser, change
authentication or establish provider compatibility; an endpoint without those
events continues to work as ordinary CDP.

Each viewer owns its connection, selection and cleanup. Two viewers of different
windows are supported; simultaneous screencasts of the same tab are not
guaranteed. The remote page remains shared website state regardless of how many
viewers display it.

## Explore the props

The preview leads each panel, with its connection bar above and grouped settings
alongside. Expanding groups leaves the preview height unchanged; overflowing
settings scroll within that height. Narrow panels put settings below the preview,
where groups expand with the page. All controls belong to that panel; adding
another viewer starts with independent defaults.

Drag the preview's lower-right corner to resize it. Height, Width, the dimension
caption and Usage stay in sync. The preview stays anchored at the top left while
resizing. Height ranges from 240 to 800px; width ranges from 50% to 100% of the
available stage, including on narrow screens. The surrounding stage keeps its
initial minimum height when the viewer shrinks and grows to fit a taller viewer.

The corner is also a keyboard control: Left/Right adjust width by 1%, Up/Down
adjust height by 10px, and Shift uses larger 5%/40px steps. Escape, focus loss or
pointer cancellation stops the drag at its current size. The sliders remain
available for precise changes. Resizing a preview keeps its live viewer and input
nodes. It changes local presentation; **Sync continuously** also adapts the remote
display to the new page surface.

| Public prop              | Playground surface                                 | When it changes                                                         |
| ------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `cdpUrl`                 | Masked connection bar                              | Connect or Apply & connect                                              |
| `windowId`               | Connection options                                 | Connect or Apply & connect; blank means omitted                         |
| `extensions`             | Optional adapter checkboxes                        | Connect or Apply & connect                                              |
| `paused`                 | Pause stream / Resume stream                       | Immediately, without replacing the connection                           |
| `interactive`            | Control mode                                       | Immediately; restarts this viewer using its applied connection settings |
| `capture`                | Image detail → JPEG quality and capture resolution | Immediately; restarts only the selected screenshot stream               |
| `colorScheme`            | Appearance & layout → Viewer theme                 | Immediately; Inherit page omits the prop, while System follows the OS   |
| `style`                  | Height, width, corner radius and custom accent     | Immediately; remote adaptation follows Window size sync                 |
| `className`              | Framed presentation preset                         | Immediately; demonstrates the demo's own `demo-viewer-framed` CSS class |
| `onStatusChange`         | State & events                                     | Always observed while connected                                         |
| `onError`                | State & events                                     | Always observed while connected                                         |
| `windowSizeSync`         | Appearance & layout → Window size sync             | Immediately, without replacing the connection; off by default           |
| `onWindowSizeSyncChange` | State & events / controlled Usage                  | Accepts browser-menu requests and updates the owning panel's mode       |

**Window size sync** and the address-bar menu share the same controlled mode:

- **Do not sync automatically** (`off`, default) stops automatic updates while
  keeping the last applied remote size and pixel density. It does not restore
  the window's previous dimensions.
- **Sync once on opening** (`initial`) fits each selected real window once per
  connection, using the viewer's page-surface size and client pixel density.
- **Sync continuously** (`live`) also adapts the remote display when you resize
  the viewer with its corner or Height/Width controls.

The setting is available before connecting, remains independent in each panel,
and changes immediately without reconnecting. Menu changes update the right-hand
control and Usage through `onWindowSizeSyncChange`. The menu's combined size/DPR
**Sync now** action remains available without changing the automatic mode.
See the [library contract](../README.md#display-adaptation) for sizing limits.

The demo initially enables interaction, while the library's default remains
view-only. Changing control mode creates a fresh viewer generation, using the last
applied endpoint/window/extensions even when connection fields contain unapplied
drafts. Pause, theme and styling retain the viewer and its input nodes. Ordinary
offscreen/document visibility behavior still applies.

**Image detail** separates JPEG quality (0–100) from maximum capture resolution.
The initial values match the library defaults: quality 70 and **Default for viewing
mode** resolution. This preserves 1920×1080 for ordinary viewing and the existing
4096×4096 ceiling for explicit display adaptation. Choose a
smaller maximum to save bandwidth or retain more detail with a larger maximum;
the remote page keeps its viewport and aspect ratio. Text can soften at smaller
resolutions, especially when enlarged. Both controls apply live, preserving the
viewer, selected page and native input, and appear in Usage. Changing local
preview dimensions keeps the selected capture limits. Window-size synchronization
can still change the remote viewport and actual image dimensions. Preferences
remain in this panel's memory and are cleared on refresh.

State & events retains only semantic summaries: status, tab count, selection
presence, navigation availability/history capabilities and diagnostic category.
It omits target IDs/titles and page addresses before storing observations. Error
events show the public fixed diagnostic. `onWindowSizeSyncChange` records only
the mode requested by the browser menu. Each panel retains at most twelve events;
Clear removes activity while retaining its latest state. Connection replacement,
disconnect and removal retire the old observations and reject late callbacks.

Usage shows the applied window/extensions with the current live controls. The
endpoint and status/error handlers are supplied as host component props. The
example initializes `useState<WindowSizeSync>` from the current selection and
passes its setter to `onWindowSizeSyncChange`, demonstrating how to accept menu
requests in a controlled integration. The framed preset requires
host-defined CSS; it is an integration example, not an additional library theme.
The example is selectable text. Neither code nor observations are saved.

## Tabs and recovery

The page-level **Appearance** setting selects **Light**, **Dark** or **System**.
Viewers inherit this host setting by default. System follows the OS preference;
changing appearance keeps the connection, current tab and local input nodes.

The top row contains compressible tabs, close buttons and a fixed **+**
new-tab button. Arrow keys move tab focus; Enter or Space selects the focused tab.
The tab row retains its height when there are no tabs, keeping the page area in place.
Tabs shrink from a comfortable maximum as space decreases; the row never scrolls
horizontally. Narrow tabs omit titles and inactive close buttons, while the selected
tab keeps its close action. When useful minimum widths no longer fit, **All tabs**
lists every page and the selected page remains in the strip whenever it can fit.
The styled popup follows each viewer's theme, marks the current tab and wraps full
titles. It fits inside the viewer and scrolls vertically for long lists. Arrow
keys navigate, Enter selects, and Escape closes; clicking outside also dismisses
it. It is an embedded-viewer fallback without a search field.
Discovery updates keep existing tabs in place and append newly discovered tabs.
Background updates preserve selection and the visible target order.
Creating a tab opens `about:blank` in the selected page's window and focuses the
address bar unless you focused another control while creation was pending.
Popup/sandbox policy can block this action; check the browser before
retrying an uncertain result. Opening requires standard CDP isolated-world APIs.
A page's JavaScript override of `window.open` does not change the isolated world.

Closing the selected tab selects the nearest surviving tab unless a later user
selection supersedes it. Closing another tab keeps the current selection.
External tab loss requires explicit selection. Closing the last tab leaves an
empty view; an unscoped viewer can create a new tab. A configured window that no
longer exists must be replaced by the host, never silently changed to another.
Removing a viewer never closes tabs. View-only viewers have no create/close actions.

Connection failures/disconnects show a message and **Reconnect viewer** inside
the canvas area. Reconnect replaces only that viewer's connection and does not
reload the remote page. Navigation or tab-operation failures keep a live image
and show one notification over the top of the page without moving it. A new
notification immediately becomes current and restarts its five-second display
interval. The previous notification stays still while the new opaque notification
slides down over it for 160ms. The previous one is removed only after the new one
has fully arrived. Rapid reports retain only the preceding notification underneath.
First appearance slides down and automatic dismissal slides upward (160ms each);
reduced motion disables these animations. Recovery messages and reconnect controls stay
visible until the connection or selection recovers. There is no debug footer.

## Interact

Click inside the live page to focus its remote control, then type or use mouse
and keyboard actions. Press **F8** outside composition to release remote keyboard
focus to the selected tab. Connection fields, page selection and the address
bar retain their own local input; typing in them is not sent to the remote page.

Enter a page address and press **Enter** to navigate. Recognizable host addresses
such as `example.com` or `localhost:3000` receive an `http://` scheme; explicit
schemes are handled by the remote browser. Plain text does not become a search.
Editing the address alone does not navigate. The toolbar also provides reload
and available back/forward actions. Disconnecting or removing a panel discards
its unsent input without closing the remote browser or tabs.

The demo uses the same native input proxy and ownership rules as the public
component. Input follows Chromium's current focus, including automatic control
changes and focused same/cross-origin frames. Plain-text clipboard gestures and
copy recovery come from the public component, with no separate demo engine.
The clipboard host/permission requirements still need deployed-Origin validation.
Genuine OS IME behavior and editor compatibility
are limited to the recorded evidence in the [interaction guide](interaction.md).
The component remains read-only by default in other host applications.

## Direct browser connectivity

The page connects directly to the supplied endpoint; there is no relay or HTTP
discovery. HTTPS pages normally need `wss://` with a browser-trusted certificate.
The endpoint must allow `https://okou-ai.github.io` as its WebSocket Origin.
Private/local-network access also depends on the client browser's permissions
and network policies. A working Node or sandbox connection does not establish
that these browser restrictions allow the same endpoint.
For an authorized local endpoint, allow local-network access when your browser
asks. That grant does not bypass TLS or the endpoint's Origin policy.

The remote endpoint must support target discovery, flattened sessions and
screencasting. Failures use fixed diagnostics without echoing the URL or raw
provider payload. Check your endpoint's reachability, TLS and Origin policy if
the connection is rejected. No Browser Use or other provider compatibility is
implied by a test against a different Chromium endpoint.

## Build and deploy

`pnpm build:demo` creates `dist/demo` with the project-site base `/cdp-viewer/`.
This output is separate from library sources and committed CSS; consumers still
install the library from a fixed GitHub SHA. The demo does not require an npm
publication or dependency install-time build.

Repository **Settings → Pages → Source** must be **GitHub Actions**. The
**Deploy demo** workflow builds and uploads only `dist/demo`, then deploys on a
push to `main` or a manual dispatch on `main`. Pull requests build and test the
production artifact without replacing the live site. Pages/OIDC write permissions
are limited to the deployment job. The repository must allow that job to deploy
to the `github-pages` environment.

After deployment, the workflow checks the actual HTTPS page, source-revision
marker, direct load/refresh and assets, then drives real CDP connections to
test-owned Chromium windows from that Origin. The `pages-smoke-<sha>` artifact
contains sanitized receipts with source/client/backend versions and capability
results. It contains no endpoint URLs, credentials or real browsing content.
These checks do not use a relay or establish other providers' policy. A failing
smoke job leaves the workflow red even if Pages accepted the static artifact.
The smoke browser explicitly grants local-network access for its owned loopback
endpoint, and records that condition in the receipt. It does not disable browser
security or assert that permission-denied clients can connect.

Revert and redeploy a known revision to roll back the demo. Consumer upgrades
and rollbacks still use reviewed full-SHA dependency and lockfile changes.

## Validation and limits

Follow the [validation strategy](../docs/validation.md). Interaction requires a
successful rollout receipt bound to its own deployed revision. Local production
receipts use `local-production-fixture`; the workflow
labels actual deployed-page receipts `actual-pages-deployment` and checks the
source revision to reject stale deployments. The same smoke file exercises
native input, local focus, independent windows and navigation after deployment.
The ownership smoke also exercises optional Browser Use configuration alongside
a standard CDP panel, draft isolation, reconnection and cleanup against owned
Chromium. This does not verify live Browser Use activation events or its service's
Origin policy.
Genuine system IME and provider compatibility still require their own evidence.
