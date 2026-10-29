# Theme design and ownership

`cdp-viewer` is a general-purpose library. Okou is its primary host, and the
embedded viewer should read as part of that host's interface. The library still
has to work independently and in other applications. This distinction determines
where theme decisions belong.

## Library and host responsibilities

| Owner            | Responsibility                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer library   | Own local control structure, interaction behavior, accessible focus, public theme variables and independent light/dark defaults. Keep every local surface and state themeable through the public contract. |
| Host integration | Map the host's semantic tokens onto viewer variables, choose appearance policy and ensure the resulting text, surfaces and states have sufficient contrast.                                                |
| Remote website   | Own the pixels streamed into the viewer. A host theme change must not inject styles into the remote page or change its browser/profile settings.                                                           |

Keep Okou token names, palette values and theme selection in Okou's integration
layer. Do not import its design system into this library, add an Okou preset or
detect the host by name or DOM structure. Other hosts use the same public
interface. Chrome can inform familiar browser layout and interactions; exact
Chrome color matching is not the theming requirement.

## Semantic mapping

Use `style` and the documented `--cdpv-*` variables to map semantic roles, rather
than copying a host's current hexadecimal palette or overriding private viewer
selectors. Keep one host adapter responsible for the mapping so host palette
changes have one owner.

Review the mapping across all applicable roles:

- Surfaces: main chrome, tab strip, selected tab, address field, page surround,
  popup/submenu and clipboard recovery.
- Content: primary/muted text, accent and text on a filled action, diagnostics
  text and background.
- States: neutral hover, selected options, focus, primary-action hover, disabled
  and busy controls. A filled primary action must retain a readable filled state
  on hover; a neutral hover wash cannot replace its fill.
- Elevation and shape: popup/loading shadows, outer radius and any other
  documented shape controls available in the installed revision.

Map each role to the corresponding host semantic token, not all roles to one
background or accent. Keep the variable inventory and fallback values in
[API.md](../API.md#theme-contract); this guide defines ownership rather than a
second palette specification. Hosts own contrast for their overrides, including
translucent state layers over their actual surfaces.

## Following a live host theme

Light/dark selection and palette mapping are separate. Omitting `colorScheme`
inherits the host's CSS `color-scheme`; an explicit value follows a host policy
that controls that prop. This selects the viewer's default light/dark palette and
native control appearance. It cannot infer arbitrary host colors.

To follow a host palette, map viewer variables to live host CSS variables, or
update their values through `style` when the host's theme changes. Host classes
and semantic CSS variables should update those mappings naturally; do not take a
one-time computed-color snapshot. A host can change an accent independently of
light/dark mode. The [API example](../API.md#theme-contract) demonstrates the CSS
variable boundary.

Theme changes must repaint local controls, including an already open popup,
without reconnecting, changing the selected target, replacing the canvas/native
input node or disrupting input focus. Do not key/remount the viewer by theme.
Independent viewer instances may use different mappings or explicit appearance
overrides; changing one instance must not mutate a sibling's theme configuration.

## Validation boundary

Verify the installed public component in a host with semantic CSS tokens. Exercise
light/dark and accent changes while the viewer is streaming, with controls and
popups open. Check state colors, readable primary hover, preserved selection,
node/focus continuity and the absence of a replacement connection. Retain default
and independently themed sibling coverage. Host integration also needs its own
app-token verification; a generic fixture does not establish Okou integration or
live-provider compatibility.
