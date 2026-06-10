# `video` — Embedded Video

**Status:** Approved — not yet built (Phase 2)
**Code (current):** none — direct video *files* already render via the artifact shell (`GET /artifacts/:id/view`)

`surface video` puts a video on the user's screen with one line — primarily YouTube and other embeds, which today require the agent to hand-write an iframe embed page every time (two of the original demo surfaces were exactly that boilerplate).

## Usage

```bash
surface video https://www.youtube.com/watch?v=dQw4w9WgXcQ --title "Watch this"
surface video https://youtu.be/abc123 --start 90 --autoplay
```

| Flag | Meaning |
|---|---|
| `--title` | Card title (defaults to fetched title when available, else the URL) |
| `--start <s>` | Start offset in seconds |
| `--autoplay` / `--loop` | Player behavior (autoplay is muted, per browser policy) |
| `--id`, `--agent` | As on `surface create` |

## Behavior

- YouTube URLs (watch/short/youtu.be forms) are normalized and embedded via **`youtube-nocookie.com`** (privacy-enhanced mode); start/autoplay/loop map to embed params.
- Non-YouTube URLs fall back to a generic `<iframe>` embed; **local video file paths are rejected with a pointer to `surface present`**, which already handles real video files through the artifact shell's native `<video>` rendering.
- The player sizes to the viewport with the title as a slim header band.

## Template contract

- **Params:** `url` (url, required), `start` (number), `autoplay` (boolean), `loop` (boolean), `title` (string).
- **State / actions:** none by default — it's a player. (A project can override the built-in to add e.g. a `watched` action; see [overview.md](overview.md#resolution-order).)

## Related

- [doc.md](doc.md) — the other "wrap external content properly" template
- [overview.md](overview.md) — template machinery
