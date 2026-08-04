# Dashboard redesign — reference shots

Captured from a throwaway server seeded with `surface seed-demos` (the bundled
demo gallery) plus three linked surfaces of awkward shapes: a plain-text deploy
log, an SVG chart, and a markdown doc with a title long enough to truncate.

Headless Chrome over CDP at deviceScaleFactor 2, with
`prefers-color-scheme` emulated per shot and `--blink-settings` forcing the
hover/pointer capabilities per form factor (headless otherwise reports
`hover: none` and flips the desktop shots into the touch layout).

| | dark | light |
|---|---|---|
| Home, desktop 1440×900 | `home-desktop-dark.png` | `home-desktop-light.png` |
| Home, phone 390×844 | `home-phone-dark.png` | `home-phone-light.png` |
| Open surface, desktop | `surface-desktop-dark.png` | `surface-desktop-light.png` |
| Open surface, phone | `surface-phone-dark.png` | `surface-phone-light.png` |

The open-surface shots are the bundled `ask-approval` demo, so the 40px bar is
visible against real surface content.
