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
| `--bg` | `#0a0b0d` | `#f6f6f7` | page |
| `--fg` | `#ffffff` | `#0b0c0e` | primary ink |

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
