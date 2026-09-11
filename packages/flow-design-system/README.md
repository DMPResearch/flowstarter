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

| Token                   | What it is                                      |
| ----------------------- | ----------------------------------------------- |
| `--fs-glass-bg`         | the standard translucent fill, 0.52 / 0.42      |
| `--fs-glass-bg-strong`  | denser fill, for content over a busy mesh       |
| `--fs-glass-edge`       | the untinted edge colour                        |
| `--fs-glass-highlight`  | the diagonal specular catch-light               |
| `--fs-glass-specular`   | the 1px light line along the top inside edge    |
| `--fs-glass-ink-dim`    | label and note ink on a tinted tile             |
| `--fs-glass-shadow`     | the drop the material casts, tinted indigo      |
| `--fs-glass-blur`       | backdrop blur radius, 28px product-wide         |
| `--fs-glass-saturate`   | backdrop saturation, 180%                       |
| `--fs-glass-refraction` | the gradient the 1px inner border is drawn from |

The fill is deliberately thin. Glass that you cannot see the mesh through is
just a white box, so `--fs-glass-bg` lets roughly half the gradient come back
up through the panel, and the blur and the saturation are what keep the result
legible rather than muddy.

`--fs-glass-ink-dim` exists because text on a tinted, half-transparent tile
needs more weight than the same text on the flat page behind it. Use it for
labels and notes inside glass; use `--fs-ink-dim` everywhere else.

Nine tones, each with four tokens: `--fs-tone-T` (ink), `--fs-tone-T-soft`
(tint wash), `--fs-tone-T-edge` and `--fs-tone-T-glow`. The tones are `accent`
(233), `ok` (152), `info` (205), `warn` (36), `danger` (356), `violet` (268),
`pink` (330), `teal` (182) and `neutral`.

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
dark. The grain is a tiny SVG noise tile laid over the top, which is what stops
gradients this wide from banding on an 8-bit display.

Radii: `--fs-radius-glass` (22px) and `--fs-radius-glass-inner`.

### Classes

| Class                                  | What it does                                                             |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `.fs-glass`                            | the material: fill, blur, specular, refractive edge                      |
| `.fs-glass--strong`                    | swaps in the denser fill                                                 |
| `.fs-glass--card` / `.fs-glass--panel` | the two content paddings                                                 |
| `.fs-glass--chrome`                    | square, opaque-leaning, for a header or sidebar                          |
| `.fs-glass--interactive`               | hover lift and edge brighten, on the spring easing                       |
| `.fs-glass--toned`                     | lets a surface take a tone wash                                          |
| `.fs-glass--plain`                     | keeps the tone in the rim and the ink, drops the wash                    |
| `.fs-glass--control`                   | the material at a button's radius, with no drop of its own               |
| `.fs-glass-tile`                       | a toned tile, with `__label`, `__value`, `__note`, `__icon`              |
| `.fs-tone-text`                        | tone-coloured text outside a tile                                        |
| `.fs-glass-ring`                       | the focus-visible ring                                                   |
| `.fs-mesh-backdrop`                    | the fixed full-bleed mesh, `data-variant`, one of app, landing or editor |

A toned surface reads its tone from `data-tone`, or from `data-palette` when
the caller needs `data-tone` for a meaning of its own. When both are present,
`data-palette` is the one that paints.

`.glass-liquid` is a deprecated alias of `.fs-glass`. It exists so the older
call sites keep working; do not use it in new code.

### Components

- `GlassSurface`: `{ variant: 'card' | 'panel' | 'chrome', tone, interactive, as, className }`.
  The base for every translucent surface.
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
