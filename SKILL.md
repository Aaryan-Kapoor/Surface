---
name: surface
description: Universal display for AI agents. Push live, interactive surfaces to the user's screens, ask questions they can answer from any device, and react to clicks via the `surface` CLI.
---

# Surface

Surface is the user's universal display. When the user says "surface this", "put X on my display", "show me Y", "ask me when it's done", or similar, you use the `surface` CLI. The CLI talks to a local system service (HTTP on `127.0.0.1:3000` by default) — every agent uses the same binary, no per-agent protocol.

`surface <command> --help` is authoritative for flags. The notes below tell you *when* to use each command.

## Session start ritual

1. `surface actions` — drain your inbox: clicks that arrived while you were gone. Handle them (or ack and explain), don't ignore them.
2. If the project has a `SURFACE.md`, read it — it says which surfaces this project maintains and which state keys to update when.
3. `surface list` — see what's already on the display. **Never create a duplicate**; update the existing card.

## Creating content — pick by shape, not by habit

| The content is… | Use |
|---|---|
| A question you need answered | `surface ask` (see below) — not a hand-written form |
| A long-running log / narration | `surface create <t> --id <slug> --template stream`, then `surface append` |
| A YouTube/web video | `surface video <url>` |
| A markdown file in the repo | `surface doc <path> [--toc]` |
| A file in your project you'll keep editing | `surface link <abs-path> [--entry <rel>]` — served live from disk |
| Ad-hoc HTML/interactive UI | `surface create <title> --mime text/html --content -` |
| A one-shot file snapshot (PDF, image) | `surface present <abs-path>` |

Always pass `--agent <your-harness-name>` (e.g. `claude-code`, `codex`, `openclaw`) so the dashboard can attribute your surfaces, and `--id <slug>` for recurring purposes so updates target the same card. Surfaces are automatically owned by the git project you run the CLI from.

**Before building the same UI a second time, make it a template**: `surface template create <name> --from <artifact-id>`, then edit the scaffolded `template.json`. Project templates live in `.surface/templates/` (committed); personal ones in `~/.surface/templates/`. `surface template list` shows what exists — check before hand-writing HTML.

## Live data: state, not HTML rewrites

Never regenerate HTML to change a number. Every surface has a JSON state doc:

```bash
surface set build progress 0.42          # dotted keys ok: surface set build tests.passed 132
surface patch build '{"stage":"deploy","eta_s":90}'
surface state build                      # read it back
```

In your HTML, bind with `data-surface-bind="tests.passed"` / `data-surface-show="deploy.ready"` — the injected `surface.js` runtime re-renders bound elements live on every display. Emit actions from markup with `Surface.action("name", {...})`.

## Asking the user: `surface ask`

The human-in-the-loop primitive. **Context-free questions are worse than useless** — attach what you know:

```bash
surface ask "Ship v2.1 to prod?" --options "ship,hold" --wait --context - <<EOF
### What changes
$(git log --oneline v2.0..HEAD | head -20)
### Test status
132 passed, 0 failed
EOF
```

`--wait` blocks until answered (prints `{choice, text, answered_at, device}`, exit 0; exit 3 on `--timeout`). `--freetext` adds a text input. `--on phone` pushes the question to a specific device. The card flips to answered on every display the moment one answer lands.

## Reacting to clicks: the delivery ladder

1. **Live waiter (default — use this).** Background `surface wait --id <id> [--action <name>]` in your session. When the user clicks, it exits 0 with the action JSON and your harness wakes you; the action is acked on delivery. **Re-arm after handling** — one wait handles one click. While a waiter is connected the card shows "agent listening" and bindings stay suppressed.
2. **Binding (wake-me-when-offline).** `surface bind <id> --action <pattern> --run '<command>'` makes Surface spawn the command when a click arrives and *no* waiter is connected. The command gets the full pending-action batch as JSON on stdin, runs with cwd = the project root, and is argv-tokenized (never shelled). Recipes:

   | Harness | Binding |
   |---|---|
   | Claude Code | `--run 'claude -p --resume <your-session-id> "Read the Surface action batch on stdin and handle it."'` — wakes the session that has the context |
   | Codex CLI | `--run 'codex exec "Handle the Surface action batch on stdin (cwd is the project)."'` |
   | OpenClaw / daemon | `--webhook http://127.0.0.1:18789/hooks/agent` — push straight into the gateway |
   | Anything | `--run './scripts/on-click.sh'` — it's just a command |

   **Consent — ask once per project.** A spawned session costs the user usage/quota. Before registering your first wake-binding in a project, ask: "Want clicks on this to wake me when I'm offline? It costs a headless session per wake." Record the answer in `.surface/config.json → bindings.enabled` (true/false; `surface init` scaffolds it as null = not asked yet). Never re-ask; never auto-bind without a recorded yes.
3. **Inbox (always).** Unhandled clicks stay pending, badge the card, and wait for your next session's `surface actions` drain. Nothing is lost.

Respond to the user with `surface reply <id> "text"` (toast), a state update they can see, or `surface notify`.

## The board: tell the user what you're doing

A shared fleet dashboard lives at id `board` (it materializes on first write):

```bash
surface set board <your-agent-name> '{"status":"PR #42 green, reviewing feedback","project":"myapp","link":"build-status"}'
```

Update your section when you start, finish, or get blocked on significant work — not per keystroke. Key by the same name you pass `--agent`. Set `link` to your most relevant surface so a tap leads somewhere useful. Stale sections dim automatically.

## Project conventions: `.surface/` and `SURFACE.md`

- `surface init` scaffolds `.surface/` (config, manifests, templates) and a starter `SURFACE.md`.
- Surfaces a project considers part of itself get manifests in `.surface/surfaces/*.json` (`surface sync --export <id>` writes one). `surface sync` recreates them on any machine — run it when manifests exist; it's idempotent.
- Keep `SURFACE.md` current the way you keep CLAUDE.md current: what each surface is for, which state keys to update when.
- Definitions belong in the repo; **live values never do** — they live in Surface's DB via `surface set`.

## Display control

- `surface open <id> [--on <device>]` — show a surface (everywhere, or on one named device). No arg returns to the grid.
- `surface notify "text" [--style success|warning|error] [--on <device>]` — toast.
- `surface devices` — the user's paired screens, live state, and what each is viewing.
- `surface theme '<json>'` / `surface theme reset` — display look.
- `surface exec <id> --js '...'` — live JS poke inside a surface iframe (no new version).

## Conventions

- Don't wrap PDFs, images, audio, video, or markdown in HTML — `present`, `link`, and `doc` handle them natively.
- Most external sites block iframes; use embed URLs (`open.spotify.com/embed/...`) or `surface video` for YouTube.
- PDFs from the web need the proxy: `<iframe src='/proxy/pdf?url=ENCODED_URL'>` inside artifact HTML.
- Surfaces should be self-contained (inline CSS/JS, no CDNs) — they render offline and screenshot headlessly.
- `surface --help` and `surface <cmd> --help` are authoritative.

## Environment

- `SURFACE_URL` — base URL (default `http://127.0.0.1:3000`). Loopback needs no credential.
- `SURFACE_SESSION` — session bearer for remote (non-loopback) agents. Mint from the Surface machine: `surface auth session issue --role system --label <where>`.
- Pair a new display for the user: `surface pair --name <device-name>` (prints URL + QR).
