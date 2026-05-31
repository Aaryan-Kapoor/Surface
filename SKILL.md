---
name: surface
description: Universal display for AI agents. Push HTML or files to the user's screen and react to clicks via the `surface` CLI.
---

# Surface

Surface is the user's universal display. When the user says "surface this", "put X on my display", "show me Y", "render the result", or similar, you use the `surface` CLI to push content. The CLI talks to a local system service (HTTP on `127.0.0.1:3000` by default) — every agent uses the same binary, no per-agent protocol.

`surface <command> --help` is authoritative. The notes below tell you *when* to use each command.

## Discovering state — do this first

Before creating new content, check what is already there:

- `surface list` — every card currently on the display.
- `surface status` — what the user is currently viewing.

**Never create a duplicate.** If a card already exists for the purpose ("Pomodoro", "Today's paper"), update the existing artifact instead.

## Creating content

Pick one based on where the bytes live:

- **`surface link <abs-path> [--entry <relpath>] --title <t>`** — preferred when the file is in your project directory. Surface re-serves the file live from disk; you keep editing it with your normal tools. Use `--entry` when `<abs-path>` is a directory.
- **`surface create <title> --mime <type> --content -`** — ad-hoc HTML or text the user doesn't need to own as a file. Pipe content via stdin.
- **`surface present <abs-path> --title <t>`** — one-shot snapshot of an existing file (PDFs, images, markdown). Surface copies the bytes; don't use this if the file will keep changing.

Stable IDs are good practice: pass `--id <slug>` to `create` for recurring purposes so subsequent updates target the same card.

## Updating

- **Linked artifact:** edit the file in place with your normal `Write`/`Edit` tools, then `surface touch <id>` to broadcast a reload. There is no diff or patch tool — the filesystem is the source of truth.
- **Workspace artifact:** `surface update <id> --content -` (pipe new full content). `--file <path>` and `--metadata <json>` also accepted.
- **Linked artifacts reject `surface update`** with a 409. Use `surface touch` instead.

## Reacting to user clicks

Surfaces can post actions back. Three delivery modes — pick by capability:

- **Block-and-exit (recommended for most agents):** `surface wait --id <id> [--action <name>] [--timeout <seconds>]` blocks until a matching action arrives, prints the action JSON to stdout, ACKs it server-side, and exits 0. Run it in a background subprocess; when it completes, your harness wakes you. No webhook needed. Exits 3 on timeout. Pass `--no-ack` to leave the action in the queue.
- **Pull:** `surface actions [<id>]` returns pending actions, then `surface ack <action-id>` after handling each. Use this when you only want to react when *you* check, not when the user acts.
- **Stream:** `surface stream` writes one JSON line per SSE event to stdout until interrupted. Use this if you want every event (creates, updates, deletes, actions, theme changes), not just the next action.

Respond to a click with `surface reply <id> "your message"` (toast on the surface), `surface exec <id> --js '...'` (live JS poke), or by updating the artifact.

Example background-wait pattern:

```bash
# Agent kicks off a long wait, then continues with other work.
surface wait --id "$ID" --action submit --timeout 3600 > /tmp/click.json &
# ...do other things...
# When the user clicks "submit", surface wait exits 0 and the harness wakes the agent.
```

## Display control

- `surface open <id>` — force the display to show a specific surface. `surface open` with no arg returns to the grid.
- `surface notify "text" [--style success|warning|error|info]` — ephemeral toast.
- `surface theme '<json>'` — set theme. `surface theme reset` to revert. `surface theme` (no arg) reads the current config.

## Runtime patches without a new version

`surface exec <id> --js 'document.title = "hi"'` runs JS inside the surface iframe without creating a new artifact version. Use for live counters, debug pokes, transient updates that shouldn't be a version.

## Conventions

- Don't wrap PDFs, images, audio, video, or markdown in HTML — `surface present` or `surface link` handles them natively.
- Most external sites block iframe embedding via X-Frame-Options or CSP. Use their embed/widget URLs (Spotify `open.spotify.com/embed/`, YouTube `youtube.com/embed/`, etc.).
- For PDFs you must proxy: `<iframe src='/proxy/pdf?url=ENCODED_URL'></iframe>` inside your artifact HTML.
- Surface ships with an OpenRouter chat proxy: surfaces can `fetch('/api/chat', { method: 'POST', body: JSON.stringify({ messages: [...] }) })` when `OPENROUTER_API_KEY` is set in the service env.
- `surface --help` and `surface <cmd> --help` are authoritative for flags.

## Environment

- `SURFACE_URL` — base URL (default `http://127.0.0.1:3000`).
- `SURFACE_TOKEN` — optional static owner bearer token for non-loopback access. Non-loopback clients otherwise pair via `/pair` (one-time token → durable session). Use `surface pair --base-url <url>` to create a user-facing pairing link; use `surface auth pairing …` / `surface auth session …` for lower-level management.
