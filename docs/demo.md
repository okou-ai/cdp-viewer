# Browser demo

The [GitHub Pages demo](https://okou-ai.github.io/cdp-viewer/) uses the same public
`cdp-viewer` component/types and `cdp-viewer/style.css` exports as consumers.
It provides live viewing and selection of existing tabs, with independent panels.
Remote navigation, pointer/keyboard/IME, clipboard and vendor adapters are not
available in this version.

## Connect

1. Obtain a browser-level CDP WebSocket endpoint from a browser you control.
   Provisioning, authentication and endpoint discovery belong to your provider.
2. Paste it into the masked **CDP URL** field. Optionally supply an actual
   **Window ID**. Choose **Connect**.
3. Select an existing page from the viewer's **Page** control. Add another viewer
   to watch a different window independently.

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

## Evidence and limits

The new workflow's first live rollout is required before claiming this demo has
been verified on GitHub Pages. A local production-fixture receipt is labeled
`local-production-fixture`; it is not live Pages evidence. The workflow labels
actual deployed-page receipts `actual-pages-deployment` and checks the source
revision to reject stale deployments. See [validation](validation.md) for
recorded checks and remaining compatibility boundaries.
