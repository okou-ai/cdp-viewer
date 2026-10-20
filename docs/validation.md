# Initial viewer validation

Observed on 2026-10-20 with Node 24.22.0, pnpm 12.14.0, Playwright 1.64.1,
Debian Chromium 155.0.8059.79, React 19.2.0, and ccstate/ccstate-react 6.0.0.
The PR checks validate the submitted source SHA separately.

## Local evidence

- Focused `tests/unit/client.test.ts`: 5 passing protocol tests covering reordered
  replies, event/session routing, request timeout/late attach ownership, bounded
  expired requests, disconnect and redacted diagnostics.
- Independent packed consumer: installs the tarball outside this repository,
  compiles strict public types, builds without Tailwind configuration and imports
  the ESM package on Node without opening a browser connection.
- Real-browser fixtures: 3 passing scenarios through the packed public exports.
  Two actual Chromium windows produce distinct JPEG/Canvas pixels. An active
  viewer is unmounted while the other receives newly changed page pixels; the
  remote page remains open. A test-owned extension moves an existing tab into
  the other window; the old scope becomes unavailable and the new scope lists it.
- Unscoped discovery includes pages across actual windows. Destroying the
  selected target clears its selection instead of choosing another page.
- Native WebSocket from an explicitly allowlisted loopback HTTP Origin succeeds.
  A different localhost Origin is rejected and produces a fixed UI diagnostic.
  This validates actual browser-origin policy rather than a Node CDP connection.
- Host ccstate remains interactive. Host button computed styles are unchanged
  when the stylesheet loads, and conflicting unprefixed utility names remain
  unaffected. Native browser frames use JPEG color tolerance in assertions.

The fixture HTTP server and extension are test infrastructure, not a hosted demo
or a local development server. They own the browser profiles and targets they
mutate, and contain no real connection credentials or personal browser content.
The sandbox's existing Chromium executable is selected with
`CDP_VIEWER_CHROMIUM=/usr/bin/chromium`; CI installs its Playwright Chromium.

Knip's optional raw-transfer AST buffer failed allocation in this sandbox. The
dependency check uses Knip's supported non-raw parser, preserving the same
public-entry-aware analysis rather than excluding findings.

## Remaining compatibility boundaries

- Intended Browser Use endpoint: not probed by these fixtures. No provider
  Origin/TLS or hosted-client compatibility claim is made.
- GitHub Pages and Okou Origins: not live deployment evidence; Pages is P5.
- Real Windows/macOS IME and clipboard: P2/P3, outside this view-only slice.
- Other client browsers and remote CDP versions: require their own recorded
  capability probes before being advertised as supported.
- Two simultaneous streams of the same remote target: unverified; different
  windows/targets are the required multi-instance case validated here.

The full unit suite runs in the PR pipeline, following the user's instruction
against a full local Vitest run or local development server.
