# Contributing

Use the pnpm version pinned in `package.json`, keep the lockfile committed, and
include behavior tests and documentation in each independently reviewable PR.
Public API, runtime exports, declarations and built stylesheet must agree in an
independently installed consumer. Do not depend on private Okou workspaces.

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

Build the package before type-aware lint, because the consumer fixture imports
the built public declarations. Run formatting, lint, strict types, package builds and isolated consumer checks
for changes. The PR pipeline owns broad automated checks. Do not run a full local
Vitest suite or start a dev server unless the user explicitly requests it.

Never commit or upload CDP credentials, real browser traces, clipboard contents,
personal page content, local workflow artifacts, or temporary browser profiles.
Test fixtures must own the browsers and targets they mutate. A viewer's unmount
must never close the user's browser or tabs.
