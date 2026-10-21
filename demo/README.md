# Browser demo

The [GitHub Pages demo](https://okou-ai.github.io/cdp-viewer/) uses the same public
`cdp-viewer` component/types and `cdp-viewer/style.css` exports as consumers.
It enables the public `interactive` option for live viewing, tab selection,
tab creation/closure, mouse/keyboard input and navigation, with independent panels. Clipboard transfer
and vendor adapters are not supported. Genuine
macOS/Windows system IME validation remains pending.

## Connect

1. Obtain a browser-level CDP WebSocket endpoint from a browser you control.
   Provisioning, authentication and endpoint discovery belong to your provider.
2. Paste it into the masked **CDP URL** field. Optionally supply an actual
   **Window ID**. Choose **Connect**.
3. Select a page in the viewer's top tab strip. Add another viewer
   to control a different window independently.

Selecting a page activates that tab in its remote window so it can produce live
frames.

| Parameter | Accepted value                                | Behavior                                                                                                                                     |
| --------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| CDP URL   | Absolute `ws://` or `wss://` browser endpoint | Required. Native WebSocket does not support arbitrary auth headers, URL userinfo or fragments. Provider query/path credentials are accepted. |
| Window ID | Omitted or a safe integer, including `0`      | Omitted lists pages across windows. Present limits listing/selection to confirmed members of that window.                                    |

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

Each viewer owns its connection, selection and cleanup. Two viewers of different
windows are supported; simultaneous screencasts of the same tab are not
guaranteed. The remote page remains shared website state regardless of how many
viewers display it.

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

Enter an absolute `http://` or `https://` address and press **Enter** to navigate.
Editing the address alone does not navigate. The toolbar also provides reload
and available back/forward actions. Disconnecting or removing a panel discards
its unsent input without closing the remote browser or tabs.

The demo uses the same native input proxy and ownership rules as the public
component. Input follows Chromium's current focus, including automatic control
changes and focused same/cross-origin frames. Clipboard transfer is not added.
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
Genuine system IME and provider compatibility still require their own evidence.
