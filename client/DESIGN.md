# Surface · Default Chrome

Pure black, pure white, system sans, hairline rules. Hierarchy is luminance, not weight.

## Color

| Token | Value | Use |
|---|---|---|
| `--bg` | `#000000` | every surface |
| `--fg` | `#ffffff` | primary text, active state |
| `--fg-muted` | `rgba(255,255,255,0.5)` | secondary text, labels |
| `--fg-faint` | `rgba(255,255,255,0.3)` | tertiary, decoration |
| `--hairline` | `rgba(255,255,255,0.18)` | resting borders, grid rules |
| `--hairline-strong` | `rgba(255,255,255,0.42)` | interactive borders |

No gradients, no glows, no shadows, no chroma. Themes may override `--bg` and `--fg`; everything else is built from them.

## Type

System stack: `-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif`. No web font load.

- **Weights:** 400 default, 500 for the four spots that need slight emphasis (card title, modal title, nav title, copy CTA). Nothing heavier.
- **Case:** sentence case everywhere. No uppercase.
- **Tracking:** `0` everywhere except `-0.02em` on the 56px hero and `-0.01em` on the 24px modal title.
- **Sizes:** 56 / 24 / 16 / 15 / 14 / 13 / 12 / 11.

Hierarchy is conveyed by **luminance** (100 → 50 → 30 % alpha), not weight.

## Layout

- Empty state is **left-aligned**, anchored to an 80px left margin, vertically centered.
- Grid header is left-aligned to the same gutter.
- Cards are rectangular, no radius, separated by **1px hairline rules** rendered as grid-gap fill — one continuous line between siblings, never duplicated borders.
- Interactive borders (button, modal, back-btn) are 1px solid at `--hairline-strong` alpha.

## Interaction

- Hover on a card: background lifts to `rgba(255,255,255,0.04)`. No transform.
- Hover on a bordered button: inverts to white fill, black ink, border → white.
- Transitions are 150ms linear. No easing curves, no spring.

## What's not here

No substrate (starfield, aurora, nebulae, grain, comets are all `display: none`). No empty-state glyph. No card preview color-grade. No card gleam, tilt, or materialize. No shimmer, breathe, pulse. No box-shadow. No backdrop-filter. No border-radius.

`.surface-card`, `.modal-panel`, `.empty-tour-btn`, `.toast` — every container is a black rectangle with a 1px white-alpha border.

## Themes

`--bg` and `--fg` are the only tokens an agent should override. Everything else is derived. `starfield: false` is a no-op (there is no starfield).
