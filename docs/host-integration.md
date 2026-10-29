# Host integration boundaries

Keep the viewer an ordinary React component with explicit ownership. Its local
controls share the host document; the remote page is rendered into Canvas. The
supported boundary prevents accidental interference during normal integration.
It does not require a separate document, Shadow DOM or an independent React root.

## Structure and forms

Reusable controls must work inside a host form. Avoid an internal form when an
explicit command is sufficient, and give non-submit buttons `type="button"`.
Confirm local commands explicitly without allowing the browser's implicit form
submission to trigger a host action. Treat composition confirmation separately
from command confirmation; leave native IME processing intact.

Do not depend on invalid nested forms or parser-specific control association.
Keep local address editing distinct from remote input. Native proxy nodes must
remain stable across ordinary updates and composition.

## Styles and stacking

Ship the standalone stylesheet without global resets or unprefixed utilities.
Scope component selectors beneath `.cdpv-root` and use `cdpv-` names for internal
classes. Declare essential component layout in scoped component rules; layered
utilities alone can lose to ordinary unlayered host normalization.

Use the public `className` and `style` props for outer dimensions and documented
`--cdpv-*` variables and `colorScheme` for appearance. Keep host styling scoped to
host components. Internal selectors and DOM structure are not customization APIs;
do not use global SVG/control sizing to theme unrelated components. Do not add
`!important`, a global reset or escalating specificity to compete with the host.

Keep theme mapping in the host adapter and retain generic defaults in the
library. Follow [theme design and ownership](theme-design.md) for semantic roles,
live palette changes and the boundary between host controls and remote pixels.

Establish a local stacking context at the root. Internal z-index values should
order viewer controls without competing with host dialogs or overlays. The host
owns placement and stacking of the viewer as a whole. Keep future floating UI
inside that ownership boundary, or define an explicit portal container contract.

## Input events and host shortcuts

Consume bubbling keyboard and wheel events when the native adapter handles them
for the remote page. Preserve the browser defaults needed for native input and
composition. Local controls handle their own commands; do not install a blanket
event firewall on the root. Pointer release may be observed outside the surface,
so containment must not interrupt an owned release path.

Host capture listeners run before viewer handlers. The host must filter shortcuts
by origin and respect `defaultPrevented` and composition. For example, a native
host shortcut listener can use:

```ts
function onHostKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
    return;
  if (
    event
      .composedPath()
      .some((node) => node instanceof Element && node.matches(".cdpv-root"))
  )
    return;

  // Apply the host's usual editable-control and shortcut checks here.
}
```

Apply the origin filter in capture handlers as well; `defaultPrevented` alone
cannot identify an event that the viewer will handle later. Do not forward local
toolbar or host-field input to CDP. Focus belongs to the active local control or
the explicitly focused remote proxy; releasing remote focus must restore an
owned local control rather than selecting a node with a document-wide query.

## State, context and resources

Each viewer owns its private Store/context and mutable runtime resources. A host
provider must not replace that state. Set UI dependency defaults locally when a
shared dependency provider could otherwise change the viewer unexpectedly. Keep
React and React DOM as host-provided peers; do not create another root just to
reset context.

Use instance references for DOM work. Allocate connections, listeners and timers
only in their committed lifetime, remove matching registrations, and release
only owned resources. Ordinary prop/callback updates, Strict Mode and sibling
unmounts must not reconnect or dispose unrelated work. Imports and server rendering
must not acquire browser resources. See [state boundaries](state-architecture.md)
and [input lifecycle architecture](input-lifecycle.md).

## Regression coverage

Exercise the installed public exports in a realistic React host: an enclosing
form with a working submit control, ordinary normalization styles, local fields
and shortcuts, a sibling overlay and multiple instances. Assert both successful
remote delivery and preserved host behavior. Cover composition guards separately
from ordinary Enter and keep existing focus, pointer-release and geometry checks.

Use focused unit tests for command/state boundaries and owned browser fixtures
for browser default actions, layout and propagation. Synthetic composition is
not proof of physical OS IME behavior. Tests should target normal integration,
without speculative cases involving deliberate internal DOM mutation, targeted
host overrides or capture listeners that intentionally swallow viewer input.
