# @flowstarter/flow-design-system

Shared tokens and components for every Flowstarter surface. Apps consume this
package as raw TypeScript and CSS source; their own bundler compiles it, so
there is no build step here.

- `src/styles/brand.css` is the single source of truth for `--fs-*` tokens.
- `src/styles/index.css` holds the utility classes built on those tokens.
- `src/components/**` holds the components. Import them from the package root,
  or deep from `@flowstarter/flow-design-system/components/<path>` when a React
  Server Component needs to avoid the client components in the barrel.

## Liquid glass

One translucent material, used everywhere. It is a blurred and saturated
backdrop under a specular catch-light and a 1px refractive edge that is
brightest at the top-left, sitting on a slow gradient mesh so the blur has
something to refract. Corners are concentric: a tile nested inside a panel uses
the inner radius so the two curves stay parallel.

**The rule: no hand-rolled glass.** If a surface needs a translucent fill, a
`backdrop-filter` or a gradient border, it uses `GlassSurface`, `StatTile` or
`MeshBackdrop`. A component that writes its own `rgba()` and `blur()` is a
component that will drift out of the system the next time the brand moves.

### Tokens

Material, in `:root` and again under `.dark`:

| Token                   | What it is                                        |
| ----------------------- | ------------------------------------------------- |
| `--fs-glass-bg`         | the standard translucent fill, 0.52 / 0.42        |
| `--fs-glass-bg-strong`  | denser fill, for content over a busy mesh         |
| `--fs-glass-edge`       | the untinted edge colour                          |
| `--fs-glass-highlight`  | the diagonal specular catch-light                 |
| `--fs-glass-specular`   | the 1px light line along the top inside edge      |
| `--fs-glass-ink-dim`    | label and note ink on a tinted tile               |
| `--fs-glass-shadow`     | the drop the material casts, tinted indigo        |
| `--fs-glass-blur`       | backdrop blur radius, set per level by the ladder |
| `--fs-glass-saturate`   | backdrop saturation, 180% light / 172% dark       |
| `--fs-glass-brightness` | 1.03 light, 0.86 dark: frosted versus smoked      |
| `--fs-glass-refraction` | the gradient the 1px inner border is drawn from   |

**The elevation ladder.** One material at five thicknesses. A 44px pill and a
600px modal cannot share a blur radius: at 28px the blur reaches further than
the pill is tall, so it averages to flat frosted plastic, while the modal needs
more than 28px to cut the page off rather than sit on it. Blur, fill and drop
all scale with the surface, and a level is chosen with a variant, never by hand.

| Level     | blur | fill                    | drop    | for                        |
| --------- | ---- | ----------------------- | ------- | -------------------------- |
| `control` | 12px | `--fs-glass-bg-control` | none    | a button or a pill         |
| `chrome`  | 18px | `--fs-chrome-bg`        | a rule  | a header or a sidebar      |
| `card`    | 24px | `--fs-glass-bg`         | card    | a single object            |
| `panel`   | 30px | `--fs-glass-bg-panel`   | panel   | a container for cards      |
| `overlay` | 44px | `--fs-glass-bg-overlay` | overlay | a modal, a banner, a toast |

The panel is the one inversion worth knowing: it is the thickest blur and the
_thinnest_ fill. That is deliberate. It makes a card laid on a panel the
brighter of the two, so the stack reads as depth instead of as two rectangles
in the same paint.

Dark glass is smoked, not grey. A pane that only darkens its fill reads as a
grey card, so `--fs-glass-brightness` pulls the backdrop down while the
saturation stays up; drop the saturation as well and the pane goes muddy, which
is the grey card again by another route. The rim and the catch-light are both
brighter in dark than in light, because with the fill that thin the lit edge is
most of what tells you a pane is there.

The fill is deliberately thin. Glass that you cannot see the mesh through is
just a white box, so `--fs-glass-bg` lets roughly half the gradient come back
up through the panel, and the blur and the saturation are what keep the result
legible rather than muddy.

`--fs-glass-ink-dim` exists because text on a tinted, half-transparent tile
needs more weight than the same text on the flat page behind it. Use it for
labels and notes inside glass; use `--fs-ink-dim` everywhere else.

Nine tones, each with five tokens: `--fs-tone-T` (ink), `--fs-tone-T-soft`
(the default wash), `--fs-tone-T-emphasis` (the loud wash), `--fs-tone-T-edge`
and `--fs-tone-T-glow`. The tones are `accent` (233), `ok` (152), `info` (205),
`warn` (36), `danger` (356), `violet` (268), `pink` (330), `teal` (182) and
`neutral`.

**A grid of tiles is not a colour chart.** Five tiles each filled with their own
colour is a picture of the palette, not a dashboard: everything shouts, so
nothing is heard. The default tile is therefore neutral glass, and the tone
survives in three quiet places — the value ink, the icon chip and a thin rim at
0.35 alpha. `--fs-tone-T-soft` is a whisper (0.10 light, 0.12 dark) that fades
out within the first corner.

One tile at a time may be loud. `<StatTile emphasis>` and the
`.fs-glass-tile--emphasis` class swap in `--fs-tone-T-emphasis` across the whole
tile and add the bloom underneath. `data-tone="attention"` gets the same
treatment without asking. Use it for the thing the reader has to act on; a page
where every tile asks for emphasis has none.

Ink lightness is set per mode so that the value on a tile clears 4.5:1 against
its own wash, composited over the glass, the mesh and the page. Run
`node scripts/check-tone-contrast.mjs` after changing any tone or moving any
blob. It parses the `--fs-mesh` gradient stack, samples it across a 1440x900
viewport, and checks every tone over both the brightest and the darkest point
it finds, because the glass is thin enough that where a tile sits on the
gradient changes how readable it is. It exits non-zero below AA.

`node scripts/check-ink-contrast.mjs` is its companion, for the other half of
the problem: the marketing pages put plain body and heading copy straight onto
the mesh with no tile under it. It checks the `--ls-*` inks in landing.css over
the same two extremes, bare and through the glass. Both scripts share the
gradient maths in `scripts/lib/mesh-colour.mjs`, so a blob only has to move in
one place for both to follow.

Mesh: `--fs-mesh-1` to `--fs-mesh-4`, the composed `--fs-mesh` radial stack,
`--fs-mesh-opacity`, and `--fs-mesh-grain` with `--fs-mesh-grain-opacity`.
Four large overlapping blobs, each wide enough to cross most of the viewport:
indigo, pink, teal and warm amber in light; indigo, violet, teal and magenta in
dark.

The landing variant overrides `--fs-mesh-1..4` on
`.fs-mesh-backdrop[data-variant='landing']`: one soft indigo bloom behind the
hero card, a whisper top-left, a faint tint low on the page, and no pink or
amber at all. Marketing is the one place a visitor has not asked to be, so the
headline and the hero card have to win before the background gets a turn. Note
that the variant dimmer in index.css multiplies these alphas — landing runs at
0.45 of the master and the app at 0.88, so the product of the two dials is what
you actually see. The grain is a tiny SVG noise tile laid over the top, which is what stops
gradients this wide from banding on an 8-bit display.

Radii: `--fs-radius-glass` (22px), then one 8px step in per level of nesting.
The rule is one subtraction: a child's radius is its parent's radius minus the
gap between the two edges. `--fs-radius-glass-inner` (14px) is a tile 8px inside
a panel; `--fs-radius-glass-flush` (6px) is a strip or a chip 8px inside that
tile. A free-standing control is nested in nothing, so it takes
`--fs-radius-control` (12px) or `--fs-radius-control-sm` (8px) instead.

**Controls: one height, one ring.** A button, a text field and a pill on the
same row are the same object doing different jobs, so they share a height, a
radius and a focus ring. They had drifted to five heights (52, 48, 40, 38 and
32px) with three different focus mechanisms at widths 1, 2 and 3px. Everything
now reads `--fs-control-h` (44px), `--fs-control-h-sm` (36px) and
`--fs-control-h-xs` (28px), and the one ring is `--fs-focus-ring-width` /
`-offset` / `-color`. `--fs-btn-h` and `--fs-input-h` are aliases of
`--fs-control-h`, which is why a send button now matches the field beside it.

Put `.fs-control` on anything a reader clicks or types into to get that box;
`.fs-control--sm`, `--xs`, `--square` and `--field` are the variations. The
material, if the control wants one, is a separate `.fs-glass .fs-glass--control`
alongside.

`.fs-numeric` is tabular figures, for any number a reader compares against
another number or watches tick.

### Classes

| Class                                  | What it does                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `.fs-glass`                            | the material: fill, blur, specular, refractive edge                                     |
| `.fs-glass--strong`                    | swaps in the denser fill                                                                |
| `.fs-glass--overlay`                   | near-opaque fill for banners and toasts floating over unblurred content                 |
| `.fs-glass--card` / `.fs-glass--panel` | the two content levels: blur, fill, drop and padding                                    |
| `.fs-glass--chrome`                    | square, opaque-leaning, for a header or sidebar                                         |
| `.fs-control`                          | the shared control box: height, padding, radius (`--sm`, `--xs`, `--square`, `--field`) |
| `.fs-focus-ring`                       | the one focus-visible ring, for anything that is not a glass surface                    |
| `.fs-numeric`                          | tabular figures                                                                         |
| `.fs-pill`                             | the tinted status shape, with `__dot` and `__icon`                                      |
| `.fs-glass--interactive`               | hover lift and edge brighten, on the spring easing                                      |
| `.fs-glass--toned`                     | lets a surface take a tone wash                                                         |
| `.fs-glass--plain`                     | keeps the tone in the rim and the ink, drops the wash                                   |
| `.fs-glass--control`                   | the material at a button's radius, with no drop of its own                              |
| `.fs-glass-tile`                       | a toned tile, with `__label`, `__value`, `__note`, `__icon`                             |
| `.fs-tone-text`                        | tone-coloured text outside a tile                                                       |
| `.fs-glass-ring`                       | the focus-visible ring                                                                  |
| `.fs-mesh-backdrop`                    | the fixed full-bleed mesh, `data-variant`, one of app, landing or editor                |

A toned surface reads its tone from `data-tone`, or from `data-palette` when
the caller needs `data-tone` for a meaning of its own. When both are present,
`data-palette` is the one that paints.

`.glass-liquid` is a deprecated alias of `.fs-glass`. It exists so the older
call sites keep working; do not use it in new code.

### Components

- `GlassSurface`: `{ variant: 'control' | 'chrome' | 'card' | 'panel' | 'overlay', tone, interactive, as, className }`.
  The base for every translucent surface. The variant is the rung of the
  elevation ladder; the blur, fill and drop that go with it are decided once, in
  the tokens. There is deliberately no `blur` or `background` prop.
- `Pill`: `{ tone, size, emphasis, dot, icon, as }`. The small tinted shape that
  labels a row. Same discipline as the tiles: tone-coloured ink on a whisper of
  wash inside a thin rim, never a block of solid colour, so a table with a pill
  on every row stays a table rather than becoming a bar chart. `dot` is off by
  default, because a coloured dot in front of a coloured word says it twice.
- `StatTile`: `{ label, value, note, tone, icon, href, linkComponent }`. One
  number on tinted glass: an eyebrow label, a large tabular-nums value and a
  line of plain English. `linkComponent` takes the app's own router link, so
  this package stays framework-free. The link and the static tile render the
  same body; only the wrapper element changes.
- `MeshBackdrop`: `{ variant: 'app' | 'landing' | 'editor' }`. The gradient
  field the glass refracts. Fixed, decorative, painted at z-index 0 so a layout
  can lift its content to z-index 10 over it. It replaces `FlowBackground`
  wherever glass is the material — the client dashboard, and every marketing
  page — because `FlowBackground` paints an opaque base of its own, so
  whichever of the two ends up on top hides the other. `FlowBackground` still
  draws the orbs and line work for admin and the auth pages.

`GlassCard`, `GlassPanel` and `StatCard` are thin wrappers kept for existing
call sites. New code should use `GlassSurface` and `StatTile` directly.

### Motion

Transitions use `--fs-ease-spring` and the `--fs-dur-*` durations. The mesh
drifts on a 42 second loop. Both the drift and the hover lift stop under
`prefers-reduced-motion: reduce`.
