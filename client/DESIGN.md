# Surface · Default Chrome

The shell's job is to be forgettable. Every surface an agent ships is a
different design; the chrome around it has to hold all of them without arguing
with any of them. So: previews carry the page, chrome is a hairline and a
caption, and the whole thing derives from two colours.

## Color

Two tokens. Everything else is `color-mix` of the pair, so a theme that swaps
them gets a coherent palette for free.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0a0a0a` | `#f6f6f7` | page |
| `--fg` | `#ffffff` | `#0b0c0e` | primary ink |

### The three planes (rule)

Depth is **tone, not shadow**, and the tones are ranked by importance so the eye
is told where to go. Dark is the scheme this ranking is defined in:

| Plane | Dark | Light | What belongs on it |
|---|---|---|---|
| `--overlay` | `#020202` | `#ffffff` | anything drawn *over* the page — modal panels, the pairing card, the ⌘K finder, toasts, menus, the tray floating on a preview |
| `--bg` | `#0a0a0a` | `#f6f6f7` | the page itself |
| `--interactive` | `#121212` | `#ffffff` | anything the user clicks — cards, inputs, buttons, hover and active states |

**Rules, in order of how easy they are to get wrong:**

1. **Overlays sink, interactive lifts.** An overlay is *darker* than the page and
   a clickable thing is *lighter*. This is deliberately the opposite of the usual
   "higher means lighter" convention: it ranks by attention rather than by
   z-order, so the thing you can act on is always the brightest thing in view.
2. **A control keeps its plane at rest.** A field is `--interactive` before you
   touch it, not only on focus — the focus ring does that job. A control that
   changes tone *and* gains a ring is announcing itself twice.
3. **Nesting re-ranks, it does not accumulate.** A prompt box inside a dialog is
   `--interactive` on an `--overlay` panel: it lifts off its own parent, exactly
   as a card lifts off the page. Never stack two washes to fake a third plane.
4. **Greys stay neutral.** `R == G == B`, always. The set this replaced leaned
   one or two points into blue (`#0a0b0d`, `#131417`) and read as cold slate
   rather than black — a drift that is invisible in a diff and obvious on a
   screen. Guarded in `test:client-render`.
5. **Every dialog is built to one spec.** The pairing card, the tutorial modal
   and the finder are the same object: overlay plane, `18px` radius, `32px 32px
   28px` padding, and the shared eyebrow / title / lede scale (`11.5px` ·
   `23px/620` · `13.5px`). A second dialog style is a bug, not a variant.
6. **Light does not invert.** Going darker than the page in light mode reads as
   a shadow, not a plane, so both planes are white there and separation comes
   from lightness alone.

`--panel-solid` is an alias of `--interactive`, kept because it is the name an
agent theme writes (`glass`).

Derived: `--fg-muted` (62%), `--fg-faint` (40%), `--fg-ghost` (22%), `--panel`,
`--panel-2`, `--panel-solid`, `--line`, `--line-strong`. Each derived token
declares an rgba fallback immediately before its `color-mix` value.

`--ok` (`#34d399` / `#067647`) is the only chroma in the shell, reserved for
liveness — the connection dot, the "live" pill. `--danger` is destructive
actions and the unanswered-action badge. Nothing else is coloured.

Dark is the default; light comes from `prefers-color-scheme`. Agent themes
override `--bg` / `--fg` and win over both.

## Type

System stack. No web font — a display has to render offline and inside the
headless thumbnailer.

- **Sizes:** 17 wordmark / 15 cover title / 13.5 card title / 13 bar title /
  12.5 chips and subtitle / 12 card meta / 11.5 bar meta.
- **Weights:** 400 body, 550 for titles, 620 for the wordmark and hero. Nothing
  heavier.
- **Case:** sentence case everywhere. The only uppercase left is the mono kind
  label on a cover, where it reads as a stamp.
- **Tracking:** negative and proportional to size — `-0.035em` on the hero down
  to `-0.006em` on chips. `0` on anything under 12px.

## Layout

- **Grid header** is sticky, 60px, and holds identity, search and status. It
  grows a rule only once content passes under it.
- **Cards** are a 16:10 preview with a two-line caption. The preview is cropped
  from the top, because surfaces lead with a headline.
- **Column width** is `--card-min` per breakpoint (280 / 250 / 215px, then a
  fixed 2-up under 760px), not one auto-fill floor.
- **The in-surface bar** is 40px. One row. If something can be inferred from
  the grid, it does not belong here.
- **Optical alignment:** pill-shaped controls are pulled out by their own
  padding so their text lines up with the grid edges, not their boxes.
- Radius: 14px cards, 10px inputs and buttons, 8px icon buttons, pill for
  chips and status.

## Interaction

- Card hover: 3px lift, deeper shadow, ring goes from 16% to 34% of `--fg`.
  No tilt, no gleam.
- Transitions are 150–250ms on `--ease-out` / `--ease-swift`. Nothing springs.
- The action tray is hover-revealed. Where hover doesn't exist it gets a `⋯`
  handle in the **caption** — never on the picture.
- `prefers-reduced-motion` removes every animation, transition and the hover
  lift.

## Accessibility

One `:focus-visible` rule: 2px `--fg`, offset 2. Cards are links to the
keyboard. Previews have real alt text. Chips carry `aria-pressed`, the
connection indicator is a `role="status"`.

## What's not here

No starfield, nebula, aurora, grain or comets — retired, and the selectors are
still `display: none` for themes that inject their own. No card tilt. No
gradients or glows in the chrome (covers are the exception, and they are
content, not chrome). No decorative iconography.
