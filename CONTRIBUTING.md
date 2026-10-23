# Contributing

Use the pnpm version pinned in `package.json`, keep the lockfile committed, and
include behavior tests and documentation in each independently reviewable PR.
Public source/type exports, included files and committed stylesheet must agree in
an independently GitHub-installed consumer. Do not depend on private Okou workspaces.

Follow [the state architecture](docs/state-architecture.md): ordinary React views
read per-instance ccstate projections and invoke commands; resource lifetimes
belong to committed instance lifetimes. Preserve multiple independent viewers
and host-provider isolation. `pnpm lint` includes strict boundary checks and
their positive/negative policy regressions (`pnpm test:lint`). Do not suppress
production lint or type errors, add filename privileges, or exempt infrastructure.
Use ccstate for semantic state and stable bindings; React observation and
commit-lifecycle integration follow one uniform production rule.

See [engineering documentation](docs/README.md) for documentation scope and the
architecture and validation guides. Demo usage and interaction instructions live
alongside the demo.

Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
type(optional-scope): description

Optional body.

Optional footer.
```

Use `feat` for features and `fix` for bug fixes. Other descriptive types such as
`docs`, `chore`, `refactor`, `test`, and `ci` are allowed. Use `!` before the colon
or a `BREAKING CHANGE:` footer for incompatible changes. Keep repository artifacts
in English; prefer consistent lowercase types and concise descriptions.

## Checks

Use `package.json` for the pnpm version and supported Node range, `tsconfig.json`
for strict type settings, and `.github/workflows/ci.yml` for the CI environment.
Run commands from the repository root:

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

Choose checks appropriate to the change; see the [validation strategy](docs/validation.md)
for test boundaries and evidence requirements. The library/declaration build
produces internal validation artifacts; consumers use source exports without `dist/`.

After changing styles/classes, run `pnpm css:write` and commit
`styles/viewer.css`; `pnpm css:check` verifies it without rewriting files. Keep
React as a peer and include referenced source/type dependencies. Do not add a
dependency prepare/postinstall build or npm publication workflow.

The PR pipeline owns broad automated checks. Do not run a full local
Vitest suite or start a dev server unless the user explicitly requests it.
For a focused regression, run an individual file, for example
`pnpm exec vitest run tests/unit/client.test.ts`.

## Consumer verification

`pnpm test:package` independently installs the pushed full GitHub SHA with
lifecycle scripts and automatic peer installation disabled. The consumer baseline
versions live in [scripts/consumer.mjs](scripts/consumer.mjs). The fixture checks
installed source/CSS and inline README file links, host-provided peers, public
types, a production build and bundled SSR without opening a connection. It
generates a lockfile and verifies an offline frozen reinstall; actual consumers
commit their lockfile in their own repository. Use the pushed source SHA, never a
self-referential committed fixture lockfile or private source alias.

`CDP_VIEWER_SOURCE_SHA` and `CDP_VIEWER_SOURCE_REPO` select an explicit immutable
revision; CI uses the PR source SHA/repository rather than its synthetic merge
commit. For unpushed changes, `CDP_VIEWER_CONSUMER_SOURCE=tarball pnpm test:package`
selects supplementary local-pack verification. It does not establish GitHub
installation acceptance; the default never silently falls back to local files.
The receipt in `test-results/package/` records the actual source and lockfile hash.

Browser fixtures reuse the installed consumer, test-owned Chromium windows and
bounded HTTP servers. Install Playwright's matching Chromium or set
`CDP_VIEWER_CHROMIUM` to an existing executable; no dev server or provisioning
service is required.

## Change hygiene

Never commit or upload CDP credentials, real browser traces, clipboard contents,
personal page content, local workflow artifacts, or temporary browser profiles.
Test fixtures must own the browsers and targets they mutate. A viewer's unmount
must never close the user's browser or tabs.
