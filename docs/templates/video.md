# `video` — Embedded Video, with a clock

**Status:** Shipped (2026-06); playhead, ask bar and markers added 2026-08
**Code:** `templates/video/`, `bin/surface.ts` (`video`), the two server folds in `server/routes/actions.ts` and `server/routes/artifacts.ts`; direct video *files* also render via the artifact shell (`GET /artifacts/:id/view`)

`surface video` puts a video on the user's screen with one line. It is also the
one surface where *where the viewer is* is a real question, so it answers it:
questions typed under the player arrive with the second they were asked at, and
the agent can pin or drive the playhead in return.

## Usage

```bash
surface video https://youtu.be/DWcqbPm_Rn4?t=195 --title "Watch this"
surface video https://youtu.be/abc123 --start 90 --autoplay
```

| Flag | Meaning |
|---|---|
| `--title` | Card title (defaults to the URL) |
| `--start <s>` | Start offset. A `?t=` / `?start=` already on the URL is used when this is 0 |
| `--autoplay` / `--loop` | Player behavior (autoplay is muted, per browser policy) |
| `--id`, `--agent` | As on `surface create` |

## Behavior

- YouTube URLs (watch/shorts/youtu.be forms) are normalized and embedded via
  **`youtube-nocookie.com`**; start/autoplay/loop map to embed params.
- **Direct media URLs** (`.mp4`, `.webm`, `.ogv`, `.m4v`, `.mov`) render as a real
  `<video>` element, so the playhead is exact. Local *paths* are still rejected
  with a pointer to `surface present`.
- Anything else falls back to a generic `<iframe>`. Such a page is opaque to us:
  the playhead stays `null` rather than claiming second zero.
- An ask bar sits under the player unless `chat=false`.

## The clock

A surface **cannot write its own state** — `PATCH /artifacts/:id/state` is
system-plane only — so the playhead rides on the actions the page already sends
and the server folds it into `state.playhead` on the way past. There is
deliberately **no heartbeat**: a tick a second would be an inbox row a second,
waking every waiter on the machine to report that nothing happened.

For YouTube the page subscribes to the embed over `postMessage` with
`enablejsapi=1` — no third-party script is loaded.

**Surface → agent** (all carry `{ t, duration, playing, video_id, url }`):

| Action | When |
|---|---|
| `ask` | the viewer typed a question; adds `text`, and appends a `user` turn to `thread` |
| `seek` | they clicked a marker or a turn's timestamp; adds `to` and `from` |
| `ended` | playback reached the end |

**Agent → surface:**

```bash
surface patch <id> '{"reply":"…"}'                       # appended as an agent turn
surface patch <id> '{"reply":{"text":"…","t":236}}'      # anchored to a moment
surface patch <id> '{"markers":[{"t":236,"label":"the payoff"}]}'
surface patch <id> '{"seek_to":{"t":236,"nonce":1}}'     # bump the nonce to replay a jump
```

`reply` is a verb, not a value: the server consumes it and appends the turn, so
two answers can never clobber each other's array, and it never lingers in state
to be rendered twice.

## Getting the transcript

```bash
surface video transcript <url|video-id> [--lang en] [--at <sec>] [--window <sec>] [--block <sec>] [--json]
```

`--at` is the one that matters: hand it the `t` from an `ask` action and you get
only the passage around that second, which is what you need to answer. `--window`
widens it (default 45s either side), `--block` sets how coarsely cues are
stitched (default 30s).

The transcript is deliberately **not** stored in the surface: it is large, it is
the agent's data, and template HTML bakes in at create time, so it would be stale
by the second viewing. The surface says *which video and which second*; this
command turns that into words.

### How it fetches, and why that matters

It asks InnerTube's player endpoint using a **mobile client context**, then reads
the `json3` caption track. Three findings are baked into that choice, all
measured rather than assumed:

1. **The obvious route is a trap.** Scraping `captionTracks[].baseUrl` out of the
   watch page yields a signed URL that returns **HTTP 200 with a zero-byte body**.
   An agent checking the status code believes it worked and then answers from
   nothing. This command treats an empty body as a failure, always.
2. **The client context is load-bearing.** `WEB` and `MWEB` answer `UNPLAYABLE`
   for a signed-out caller and `TVHTML5` errors outright; `IOS` and `ANDROID`
   still serve. That is why those two are tried, in that order.
3. **`json3` is clean; WebVTT is not.** Events carrying `aAppend` are
   rolling-window continuations holding a bare newline — drop them and the cues
   are non-overlapping with no deduplication heuristic at all. On a 22-minute
   video: 1347 events in, 674 cues out, zero repeats. The same video's WebVTT
   parsed naively gives 2018 lines of which 1344 are repeats.

**This is a moving target.** YouTube closes these routes one at a time — that is
why `yt-dlp` exists and updates constantly. If `yt-dlp` is on `PATH` it is used
as a fallback; if neither works the command exits non-zero with a message saying
so. It will never print an empty transcript and call it success.

Human-authored subtitles are preferred over auto-generated ones where both exist.
The header line says which you got: an auto-generated track has almost no
punctuation and mangles proper nouns, so hedge direct quotes from one.

## Template contract

- **Params:** `url` (url, required), `start` (number), `autoplay` (boolean),
  `loop` (boolean), `title` (string), `chat` (boolean, default true),
  `placeholder` (string), plus the tour rail's `tour_step` / `tour_next` / `tour_id`.
- **State:** `thread` (array, server-appended, capped at 200 turns), `playhead`
  (object), `markers` (array), `seek_to` (object), `note` (string).
- **Actions:** `ask`, `seek`, `ended`, `next`.

## Related

- [doc.md](doc.md) — the other "wrap external content properly" template
- [overview.md](overview.md) — template machinery
- [../interaction/delivery-ladder.md](../interaction/delivery-ladder.md) — why an
  `ask` is an ordinary action, and why there is no heartbeat
