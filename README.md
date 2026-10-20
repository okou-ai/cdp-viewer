# cdp-viewer

A browser-native React viewer for existing Chrome DevTools Protocol browsers.
This first slice provides **view-only streaming, target selection, optional window
filtering, and independent viewers**. Input/IME, clipboard, vendor adapters, the
GitHub Pages demo, and publication are tracked by [parent issue #1](https://github.com/okou-ai/cdp-viewer/issues/1).

The package is currently private and unpublished. License, npm ownership and
release authority must be settled before publication.

## Try the packed library

Use Node 22.12+ and the pnpm version pinned in `package.json` to build and pack:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
```

Install the resulting tarball in a separate React 19 application. React and React
DOM are peer dependencies. Consumers do not configure ccstate or Tailwind.

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
state; **same-target simultaneous screencasts are not guaranteed by this slice**.
The required same-browser/different-window case has independent ownership.

The local image uses contain fitting. The viewer does not resize/emulate the
remote viewport. Frames use one active decode and one newest queued frame;
old-generation images are discarded/closed. `document.hidden` and `paused`
release stream work; resuming revalidates and attaches the selected target.
Cleanup cannot cancel a native image decode already in progress, but its result
is discarded and closed. No connection credentials are persisted by the library.

## Styling

Import `cdp-viewer/style.css` once. The package ships compiled prefixed Tailwind
utilities and scoped component selectors, without global Preflight. It works in
plain hosts and alongside conflicting unprefixed utility names.

Set instance-specific `--cdpv-background`, `--cdpv-foreground`, `--cdpv-muted`,
`--cdpv-border`, `--cdpv-accent`, or `--cdpv-radius` variables through `style`.
Default height is 28rem; set `style={{ height: "70vh" }}` for host layout.
Canvas decode/paint does not cause a React update for every frame.

## Validation and compatibility

```sh
pnpm build
pnpm format:check
pnpm lint
pnpm check-types
pnpm knip
pnpm test:package
```

Build before type-aware lint: the independent consumer fixture imports the
package's built public declarations, rather than source aliases.

The PR pipeline additionally runs the full unit suite and real-browser fixtures.
Follow repository/user guidance: no full local Vitest run or dev server unless
explicitly requested. Targeted protocol tests may be used for focused debugging.

`pnpm test:package` installs a tarball in a separate temporary consumer with React
19.2, strict public-type checking, host ccstate, a production build and Node import.
Browser tests use that public packed interface, not source aliases. They create
test-owned Chromium windows and a bounded fixture HTTP server; a test-only extension
allows moving an actual tab between windows. Run browser fixtures with an installed
Playwright Chromium, or set `CDP_VIEWER_CHROMIUM` to an existing Chromium executable.
No browser provisioning service or development server is required for fixtures.

Initial automation targets current desktop Chromium. Experimental remote CDP
capabilities, provider Origin/TLS policy and other client browsers must be recorded
before compatibility is claimed. In particular, this slice does not imply a
successful Browser Use or GitHub Pages Origin probe; the hosted demo is P5.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits follow
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
