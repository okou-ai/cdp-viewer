# cdp-viewer

A browser-native React viewer for existing Chrome DevTools Protocol browsers.
It provides **view-only streaming, target selection, optional window filtering,
and independent viewers**. Keyboard/IME input, clipboard and vendor adapters are
not yet supported.

The package stays private and is distributed as source from GitHub. No npm
registry publication is planned.

Licensed under the [Apache License 2.0](./LICENSE).

## Try the demo

[Open the browser demo](https://okou-ai.github.io/cdp-viewer/). Paste your own
browser-level CDP WebSocket URL, optionally enter a window ID, then connect.
Add independent panels to view different windows. Draft edits apply only when
you choose **Apply & connect**; reconnect uses the last applied settings.

The demo is view-only and connects directly to your endpoint. Connection details
stay in page memory and are cleared on refresh. An HTTPS page normally needs a
`wss://` endpoint whose server permits the page's Origin. See the
[connection and deployment guide](docs/demo.md) for parameters, network
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
guess a page by title, URL or list position. Reconnect starts a fresh connection.
Changing callbacks does not reconnect. Unmounting releases this viewer's sessions
and connection without closing the remote browser or its tabs.

## API

| Prop                 | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `cdpUrl: string`     | Required browser-level WS(S) endpoint                                     |
| `windowId?: number`  | Optional presentation/selection scope                                     |
| `paused?: boolean`   | Release this viewer's current stream while retaining connection/selection |
| `className`, `style` | Host layout and instance-scoped theme customization                       |
| `onStatusChange`     | Readonly semantic snapshot: status, page targets, selected ID, diagnostic |
| `onError`            | Fixed diagnostic category/message, excluding raw provider payloads        |

Statuses are `connecting`, `streaming`, `paused`, `unavailable`, `disconnected`,
and `error`. Imported types include `CdpViewerProps`, `CdpViewerStyle`,
`ViewerSnapshot`, `ViewerTarget`, `ViewerStatus`, and `ViewerError`.

Each instance has its own socket, request IDs, timers, controller, private ccstate
store/context, Canvas queue, and cleanup. A host `ccstate-react` provider is
independent. Views of the same remote page still share the page's real website
state; **same-target simultaneous screencasts are not guaranteed**.
The required same-browser/different-window case has independent ownership.

The local image uses contain fitting. The viewer does not resize/emulate the
remote viewport. Frames use one active decode and one newest queued frame;
old-generation images are discarded/closed. `document.hidden` and `paused`
release stream work; resuming revalidates and attaches the selected target.
Cleanup cannot cancel a native image decode already in progress, but its result
is discarded and closed. No connection credentials are persisted by the library.

## Styling

Import `cdp-viewer/style.css` once. The package includes committed compiled prefixed Tailwind
utilities and scoped component selectors, without global Preflight. It works in
plain hosts and alongside conflicting unprefixed utility names.

Set instance-specific `--cdpv-background`, `--cdpv-foreground`, `--cdpv-muted`,
`--cdpv-border`, `--cdpv-accent`, or `--cdpv-radius` variables through `style`.
Default height is 28rem; set `style={{ height: "70vh" }}` for host layout.
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
[demo guide](docs/demo.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits follow
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
