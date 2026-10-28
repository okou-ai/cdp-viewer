# Engineering documentation

This directory holds coding principles, architecture and validation methods.
Consumer props, configuration, extensions and theming live in the
[API reference](../API.md).

- [State and React boundaries](state-architecture.md): state ownership, view
  boundaries and practical lint policy.
- [Input lifecycle architecture](input-lifecycle.md): component responsibilities,
  asynchronous ownership and resource cleanup.
- [Display architecture](display-architecture.md): synchronization policy, shared
  geometry authority, causal presentation and bounded recovery.
- [Host integration boundaries](host-integration.md): forms, scoped styles,
  stacking, event cooperation and independent component ownership.
- [Validation strategy](validation.md): test boundaries, deterministic checks and
  evidence requirements.
- [Adjacent executor assessment](executor-assessment.md): matched interaction
  measurements, ownership and adoption evidence boundaries.

Describe responsibilities, dependency direction, design decisions and stable
invariants. Keep concrete feature behavior in implementation and regression
tests. User instructions belong alongside the feature, such as the
[demo guide](../demo/README.md) and [interaction guide](../demo/interaction.md).

Keep dated test results, benchmark samples, environment inventories and delivery
receipts in pull requests, issues or CI artifacts. They are evidence for a
particular revision, not permanent engineering rules. Do not duplicate mutable
configuration or implementation details in prose.
