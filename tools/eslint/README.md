# Local ccstate policy

`policy.js` applies error-level architecture checks to production `src/` and
`demo/` code. `policy.test.mjs` exercises the actual repository ESLint config
against valid and invalid virtual production paths. It runs as part of lint in
CI. See [state architecture](../../docs/state-architecture.md) for the ownership
contract and exact capability table.

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

- Diagnostics refer to the existing captured owner and runtime primitives,
  rather than private application signal or detached-promise helpers.
- Signal-graph catches must propagate the caught failure. There is no private
  `throwIfAbort` dependency. Wire/native parser and cleanup catches keep their
  separate protocol contracts.
- The Store-construction rule is enabled here with one definition capability;
  it was registered but not enabled in the inspected Okou Platform config.
- `instance-boundaries.js` adds local factory/scope ownership, view mutation,
  canonical constructor imports, writable-atom returns and suppression checks.
- `policy.js` grants individual capabilities to exact definition files. It does
  not exempt an infrastructure directory from the remaining checks.

Preserve the pinned source and update regression examples when adapting a rule.
These syntax checks supplement behavioral tests and code review; they do not
prove arbitrary interprocedural resource ownership.
