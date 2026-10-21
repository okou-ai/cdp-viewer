# cdp-viewer

A browser-native React viewer for existing Chrome DevTools Protocol browsers.
It provides **live streaming, target selection, optional window filtering,
and independent viewers**. Viewers are read-only by default. Enable `interactive`
for mouse, keyboard, native text composition, remote navigation and tab creation/closure. Clipboard
transfer and vendor adapters are not yet supported. Genuine macOS/Windows IME
validation remains pending; see the [interaction support matrix](demo/interaction.md).

The package stays private and is distributed as source from GitHub. No npm
registry publication is planned.

Licensed under the [Apache License 2.0](./LICENSE).

## Try the demo

[Open the browser demo](https://okou-ai.github.io/cdp-viewer/). Paste your own
browser-level CDP WebSocket URL, optionally enter a window ID, then connect.
Add independent panels to view different windows. Draft edits apply only when
you choose **Apply & connect**; reconnect uses the last applied settings.

The demo enables interaction: click the live page to use your mouse and keyboard,
or use its address and history controls. Press **F8** to release remote keyboard
focus. Clipboard transfer remains unsupported; genuine
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
      <CdpViewer cdpUrl={cdpUrl} />
      <CdpViewer cdpUrl={cdpUrl} windowId={42} />
    </>
  );
}
```

Use actual window IDs from your provisioned browser; `42` is illustrative.

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
target events and every two seconds plus lookup latency to detect external moves.
Queries are serialized/coalesced; scoped lookup failure clears unverified targets.
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
| `colorScheme?: "light" \| "dark" \| "system"` | Optional host-controlled appearance; omitted inherits the host CSS color-scheme  |
| `className`, `style`                          | Host layout and instance-scoped theme customization                              |
| `onStatusChange`                              | Readonly semantic snapshot: status, page targets, selected ID, diagnostic        |
| `onError`                                     | Fixed diagnostic category/message, excluding raw provider payloads               |

Statuses are `connecting`, `streaming`, `paused`, `unavailable`, `disconnected`,
and `error`. Imported types include `CdpViewerProps`, `CdpViewerStyle`,
`ViewerSnapshot`, `ViewerTarget`, `ViewerStatus`, `ViewerNavigation` and `ViewerError`.
Snapshots may include `navigation` (current remote address and available back/forward
actions), or `null` when unavailable. Remote page addresses can contain sensitive
data; do not log or persist snapshots indiscriminately.

```tsx
<CdpViewer cdpUrl={cdpUrl} interactive />
```

Click the remote image to focus its native input proxy. Local toolbar and host
fields retain their own input. **F8** releases remote keyboard focus to the selected
tab. Keyboard input follows Chromium's current focus, including automatic
focus changes and focused frames. Composition stays in a stable local textarea
and sends committed text once through CDP; candidate confirmation is distinct
from a later remote Enter. Optional caret metadata does not block input.
The tab strip scrolls horizontally and supports explicit tab selection. Tabs show
website icons discovered through CDP from the remote page's declarations and
conventional favicon path. Images load through the remote browser, including its
applicable credentials and network policy. Background icons update without
activating their tabs. Selection follows page declarations and image sizes;
Chrome's internal history/cache choice can differ on pages with multiple icons.
Missing images or unsupported optional CDP capabilities use the generic icon.
Icon discovery pauses with the viewer and does not gate streaming or input.

Interactive viewers add new/close actions. The new-tab button stays compact and shows a
spinner while creation is in progress. Enter in the address bar navigates to an absolute
HTTP(S) address. The navigation toolbar supports reload and
available history. See [interaction behavior and limits](demo/interaction.md).

Each instance has its own socket, request IDs, timers, controller, private ccstate
store/context, Canvas queue, and cleanup. A host `ccstate-react` provider is
independent. Views of the same remote page still share the page's real website
state; **same-target simultaneous screencasts are not guaranteed**.
The required same-browser/different-window case has independent ownership.

The local image uses contain fitting. The viewer does not resize/emulate the
remote viewport. Frames use one active decode and one newest queued frame;
old-generation images are discarded/closed. `document.hidden`, `paused`, and an
offscreen viewer (when IntersectionObserver is available) release stream work;
resuming revalidates and attaches the selected target. Re-entering the viewport
does not override explicit pause or whole-document invisibility.
Cleanup cannot cancel a native image decode already in progress, but its result
is discarded and closed. No connection credentials are persisted by the library.

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
