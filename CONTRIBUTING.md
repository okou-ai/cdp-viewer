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

Run formatting, lint, strict types, CSS consistency, library validation builds
and isolated consumer checks for changes. Source exports must install at a full
GitHub SHA with scripts disabled under the consumer's pnpm 10.33.4 baseline. The
fixture generates its lockfile and verifies frozen reinstall; actual consumers
commit that lockfile in their own repository. Use the pushed source SHA, never a
self-referential committed fixture lockfile or private source alias.

After changing styles/classes, run `pnpm css:write` and commit
`styles/viewer.css`; `pnpm css:check` verifies it without rewriting files. Keep
React as a peer and include referenced source/type dependencies. Do not add a
dependency prepare/postinstall build or npm publication workflow.

The PR pipeline owns broad automated checks. Do not run a full local
Vitest suite or start a dev server unless the user explicitly requests it.

Never commit or upload CDP credentials, real browser traces, clipboard contents,
personal page content, local workflow artifacts, or temporary browser profiles.
Test fixtures must own the browsers and targets they mutate. A viewer's unmount
must never close the user's browser or tabs.
