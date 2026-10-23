# Local ccstate policy

`policy.js` applies error-level architecture checks to production `src/` and
`demo/` code. `policy.test.mjs` exercises the actual repository ESLint config
against valid and invalid virtual production paths. It runs as part of lint in
CI. See [state architecture](../../docs/state-architecture.md) for the ownership
contract; `policy.js` applies it uniformly without filename privileges.

The 20 rules under `ccstate/rules/` and their shared utility are adapted from
`okou-ai/okou` commit `7354b16deac91ae677fa1edbfb82d16c5c6e5504`, specifically
`turbo/packages/eslint-rules/src/ccstate/`. Each file retains that provenance.
They run as local ESM JavaScript using public `@typescript-eslint/utils`.

The selected rules cover command cancellation, const computed arguments,
accessor/Store escape, signal naming, private atoms, nested graph definitions,
module mutation, render effects, raw deferred/cancellation construction and
promise rejection handling. Okou's application routing, request/loadable,
workspace import and tracked-promise helpers are not copied into this library.

Library adaptations:

- Diagnostics refer to captured instance owners rather than private application
  signal or detached-promise helpers. Deferred work and cancellation require
  non-static instance members outside render and commands, in every file.
- Signal-graph catches must propagate the caught failure. There is no private
  `throwIfAbort` dependency. Wire/native parser and cleanup catches keep their
  separate protocol contracts.
- Await ownership follows the typed final `AbortSignal` parameter, including
  names other than `signal`, matching the async-command signature rule.
- Signal suffix violations are diagnostic-only. Rename the symbol and its
  references together in an editor; changing only the declaration can leave
  dangling references or collide with an existing suffixed name.
- Render-effect checks recognize default TSX components and custom hooks.
  Immediately invoked functions inherit their enclosing render or handler
  scope; deferred event callbacks remain valid places for side effects.
- The Store-construction rule requires a private readonly instance field;
  no entry filename receives a construction exception.
- `instance-boundaries.js` adds local factory/scope ownership, view mutation,
  canonical constructor imports, writable-atom returns and suppression checks.
- Signal/model factory scope and command-catch checks use syntax and ownership,
  without model/context filename sets. Real-config cases compare ordinary and
  former exception paths.
- React observation APIs have one source-wide contract. Memo, state, ref and
  effect Hooks are prohibited; ccstate owns semantic state and stable bindings,
  and committed lifecycle bridges own external resource synchronization.
- Do not introduce new filename allowlists, rule-disable overrides, directory
  exemptions or suppressions. Legitimate patterns need a uniform rule with
  representative accepted/rejected cases.

Preserve the pinned source and update regression examples when adapting a rule.
Follow the [rule design and review policy](../../docs/state-architecture.md#rule-design-and-review):
cover ordinary code and likely mistakes with simple checks. Do not grow special
cases solely to defeat intentional bypasses. Resource ownership and multiple
independent viewers also require behavioral tests and code review.
