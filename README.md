# cdp-viewer

A browser-native React viewer for existing Chrome DevTools Protocol browsers.
Stream live pages, switch tabs and optionally filter by window. Each viewer owns
its connection and state, so different windows can be viewed independently.

Viewers are read-only by default. Enable `interactive` for mouse, keyboard,
native text input, plain-text clipboard transfer, navigation and tab creation/closure.
Optional extensions can follow vendor activation events.

## Try the demo

[Open the browser demo](https://okou-ai.github.io/cdp-viewer/) and connect a
browser-level CDP WebSocket endpoint you control. The demo enables interaction
and supports multiple independently configured panels.
See the [demo guide](https://github.com/okou-ai/cdp-viewer/blob/main/demo/README.md)
for connection settings and controls.

## Install

The package is distributed as GitHub source; no npm publication is planned.
In a React 19 application with a TS/TSX-capable bundler, install a verified full
40-character commit SHA:

```sh
pnpm add "github:okou-ai/cdp-viewer#<full-40-character-commit-sha>"
```

Commit the dependency and resolved lockfile together. Upgrade or roll back both
to a verified revision; do not depend on a moving branch.

React and React DOM are host-provided peers. No viewer install-time build,
host ccstate provider or Tailwind configuration is required. Source SSR needs a
TSX-capable toolchain; importing/server-rendering the viewer opens no connection.

## Quick start

```tsx
import { CdpViewer } from "cdp-viewer";
import "cdp-viewer/style.css";

export function BrowserView({ cdpUrl }: { cdpUrl: string }) {
  return <CdpViewer cdpUrl={cdpUrl} style={{ height: "70vh" }} />;
}
```

Add `interactive` to enable remote control. Pass a real browser-owned `windowId`
to show one window; omit it to list pages across windows. For concurrent windows
of the same browser, use the same `cdpUrl` with a different `windowId` per viewer.

For composed toolbars, page overlays and floating tabs, see
[host presentation](https://github.com/okou-ai/cdp-viewer/blob/main/API.md#host-presentation).

## Requirements and limits

- Supply a resolved **browser-level** `ws://` or `wss://` endpoint. The host owns
  browser provisioning, authentication and endpoint discovery. Native WebSocket
  cannot add arbitrary auth headers.
- HTTPS hosts normally require `wss://`, a trusted certificate and an endpoint
  that permits the host's Origin. A working Node connection does not prove
  browser access.
- Client mounting requires modern native browser APIs; see the
  [runtime requirements](https://github.com/okou-ai/cdp-viewer/blob/main/API.md#runtime-requirements).
- Window filtering is presentation scope, **not an authorization boundary**.
  Website state remains shared; simultaneous screencasts of the same tab are
  not guaranteed. Unmounting a viewer does not close remote tabs or the browser.
- Initial automation targets desktop Chromium. Genuine macOS/Windows IME,
  other client browsers and live provider compatibility require separate
  validation; see the
  [interaction support matrix](https://github.com/okou-ai/cdp-viewer/blob/main/demo/interaction.md#support-and-evidence-matrix).

## Documentation

| Guide                                                                                        | Contents                                                   |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [API reference](https://github.com/okou-ai/cdp-viewer/blob/main/API.md)                      | Props, configuration, lifecycle, extensions and theming    |
| [Demo guide](https://github.com/okou-ai/cdp-viewer/blob/main/demo/README.md)                 | Playground controls, tabs, recovery and deployment         |
| [Interaction guide](https://github.com/okou-ai/cdp-viewer/blob/main/demo/interaction.md)     | Focus, keyboard, clipboard, composition and support limits |
| [Host integration](https://github.com/okou-ai/cdp-viewer/blob/main/docs/host-integration.md) | Forms, shortcuts, styles and embedding boundaries          |
| [Engineering docs](https://github.com/okou-ai/cdp-viewer/blob/main/docs/README.md)           | Architecture and validation methods                        |
| [Contributing](https://github.com/okou-ai/cdp-viewer/blob/main/CONTRIBUTING.md)              | Developer setup and checks                                 |

Guide links follow `main`. For documentation matching an installed revision,
browse the repository at the full commit SHA in your lockfile.

Licensed under [Apache-2.0](./LICENSE).
