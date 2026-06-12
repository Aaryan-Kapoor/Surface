---
name: surface
description: Universal display for AI agents. Push live, interactive surfaces to the user's screens, ask questions they can answer from any device, and react to clicks via the `surface` CLI.
---

# Surface

Surface is the user's universal display. When the user says "surface this", "put X on my display", "show me Y", "ask me when it's done", or similar, you use the `surface` CLI. The CLI talks to a local system service (HTTP on `127.0.0.1:3000` by default) — every agent uses the same binary, no per-agent protocol.

The command set is curated: the hottest paths get top-level verbs (`ask`, `video`, `doc`, `append`); everything else — including **every custom template** — is reached through generic commands (`create --template <name>`). Minting a template never mints a command.

`surface <command> --help` is authoritative for flags. The notes below tell you *when* to use each command.

## Session start ritual

1. `surface actions` — drain your inbox: clicks that arrived while you were gone. Handle each one, then `surface ack <action-id>` (actions delivered through `surface wait` are acked automatically). Don't ignore them.
2. If the project has a `SURFACE.md`, read it — it says which surfaces this project maintains and which state keys to update when.
3. `surface list` — see what's already on the display (`--project <root>` / `--agent <label>` filter; `--include-hidden` reveals hidden cards). **Never create a duplicate**; update the existing card.
4. If the display has interactive surfaces you're responsible for, re-arm your action terminal — background `surface wait --follow` via your harness's mechanism (see the delivery ladder below). Terminals never survive a session restart; the surfaces do.

## Creating content — pick by shape, not by habit

| The content is… | Use |
|---|---|
| A question you need answered | `surface ask` (see below) — not a hand-written form |
| A long-running log / narration | `surface create <t> --id <slug> --template stream`, then `surface append <id> [text\|-] [--md]` |
| A YouTube/web video | `surface video <url> [--start <s>] [--autoplay] [--loop]` |
| A markdown file in the repo | `surface doc <path> [--toc] [--width narrow\|default\|wide]` |
| A file in your project you'll keep editing | `surface link <abs-path> [--entry <rel>]` — served live from disk |
| An instance of any template, built-in or custom | `surface create <t> --template <name> --param k=v …` — check `surface template list` first |
| Ad-hoc HTML/interactive UI | `surface create <title> --mime text/html --content -` |
| A one-shot file snapshot (PDF, image) | `surface present <abs-path>` |

`link` and `doc` navigate every display to the new surface by default — pass `--no-open` to create quietly.

Always pass `--agent <your-harness-name>` (e.g. `claude-code`, `codex`, `openclaw`) so the dashboard can attribute your surfaces, and `--id <slug>` for recurring purposes so updates target the same card. Surfaces are automatically owned by the git project you run the CLI from.

**Templates.** Before building the same UI a second time, promote it: `surface template create <name> --from <artifact-id>` scaffolds `template.json` + `index.html` — then edit the contract (declare params/state/actions, replace hard-coded values with `{{param}}` slots) or the description stays a useless placeholder. Project templates live in `.surface/templates/` (committed, shadow user templates, which shadow built-ins); `--user` writes to `~/.surface/templates/` instead. `surface template list` shows every template with its source; `surface template show <name>` prints the full contract — read it before instantiating a template you didn't write.

## Reading and the artifact lifecycle

- `surface read <id>` — the full record: metadata, current version, file list.
- **Workspace artifacts** (from `create`): `surface update <id> [--title <t>] [--file <p>|--content -]` writes a *new version*. `surface versions <id>` lists history; `surface rollback <id> <version>` restores one. Experiment freely — undo is one command.
- **Linked artifacts** (from `link`/`doc`): the bytes live in your repo. Edit the file on disk, then `surface touch <id>` to broadcast a reload. `update`-with-content and `rollback` return 409 on linked artifacts by design — disk is the source of truth.
- `surface delete <id>` removes a card. Prefer updating an existing card over delete-and-recreate: a stable id keeps state, bindings, and the user's muscle memory.

## Live data: state, not HTML rewrites

Never regenerate HTML to change a number. Every surface has a JSON state doc:

```bash
surface set build progress 0.42          # dotted keys ok: surface set build tests.passed 132
surface patch build '{"stage":"deploy","eta_s":90}'   # deep-merge (or pipe JSON with -)
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

1. **Live action terminal (default — use this).** Keep `surface wait --follow` running as a persistent background process: it prints one compact JSON line per user action (auto-acked on delivery; `--no-ack` to leave them pending) and never exits. It drains the pending inbox on connect and after every reconnect, so clicks from before it started are delivered too. While it's connected the card shows "agent listening" and bindings stay suppressed. Each harness watches background output its own way — arm it with yours:

   | If you are… | Arm the terminal with |
   |---|---|
   | Claude Code | the `Monitor` tool, `persistent: true`, command `surface wait --follow` — each printed line wakes you. (Expecting exactly one answer? Bash `run_in_background` + one-shot `surface wait --id <id>` wakes you when it exits.) |
   | Codex CLI | a backgrounded one-shot `surface wait --id <id>` — you're woken when it exits with the action JSON; **re-arm immediately after handling** |
   | An always-on daemon (OpenClaw, a gateway) | no terminal needed — register a `--webhook` binding (rung 2); you're never offline |
   | Anything else | per-line watchdog available → `wait --follow` and pattern-match stdout on `"action":"`; completion notifications only → one-shot `wait`, re-arm after each; no background support → rely on rungs 2–3 |

   One-shot details: `surface wait --id <id> [--action <name>] [--timeout <s>]` exits 0 with the first matching action (exit 3 on timeout; `--event <name>` waits on any SSE event). The surface is unguarded between exit and re-arm — prefer `--follow` wherever your harness can watch it.

   **The terminal dies with your session — re-arm on return.** A restarted harness never inherits background processes: when the user comes back after ending a session, the surfaces are still live but your terminal is gone and the card has silently stopped showing "listening". That's why re-arming is step 4 of the session start ritual — the inbox drain (step 1) covers everything clicked while you were dead, the fresh terminal covers everything after.
2. **Binding (wake-me-when-offline).** `surface bind <id> --action <pattern> --run '<command>'` makes Surface spawn the command when a click arrives and *no* waiter is connected. The command gets the full pending-action batch as JSON on stdin, runs with cwd = the project root (`--cwd` overrides), and is argv-tokenized (never shelled). Recipes:

   | Harness | Binding |
   |---|---|
   | Claude Code | `--run 'claude -p --resume <your-session-id> "Read the Surface action batch on stdin and handle it."'` — wakes the session that has the context |
   | Codex CLI | `--run 'codex exec "Handle the Surface action batch on stdin (cwd is the project)."'` |
   | OpenClaw / daemon | `--webhook http://127.0.0.1:18789/hooks/agent` — push straight into the gateway |
   | Anything | `--run './scripts/on-click.sh'` — it's just a command |

   `surface bindings [<id>]` lists registered bindings with last-run status and error — check it first when a wake didn't fire. `surface unbind <binding-id>` removes one.

   **Consent — ask once per project.** A spawned session costs the user usage/quota. Before registering your first wake-binding in a project, ask: "Want clicks on this to wake me when I'm offline? It costs a headless session per wake." Record the answer in `.surface/config.json → bindings.enabled` (true/false; `surface init` scaffolds it as null = not asked yet). Never re-ask; never auto-bind without a recorded yes.
3. **Inbox (always).** Unhandled clicks stay pending, badge the card, and wait for your next session's `surface actions` drain (then `surface ack` each). Nothing is lost.

Respond to the user with `surface reply <id> "text"` (toast attributed to that surface), a state update they can see, or `surface notify`.

## Seeing what the user sees

- `surface status` — live presence: which displays are connected right now, what each is viewing, viewport size, last activity. Check it before `ask --on phone` (is the phone awake?) or before deciding whether a notify will even be seen.
- `surface devices` — the user's paired screens and their live state; `surface devices revoke <name>` cuts one off (lost phone, stale tablet).
- `surface stream [--id <id>]` — tail the SSE firehose as JSONL until interrupted (auto-reconnects): `surface_created`/`surface_updated`, `state_patch`, `surface_action`, theme changes. This is the watch-everything primitive under `wait`; pipe it into a loop when you need to react to more than one kind of event.

## The board: tell the user what you're doing

A shared fleet dashboard lives at id `board` (it materializes on first write):

```bash
surface set board <your-agent-name> '{"status":"PR #42 green, reviewing feedback","project":"myapp","link":"build-status"}'
```

Update your section when you start, finish, or get blocked on significant work — not per keystroke. Key by the same name you pass `--agent`. Set `link` to your most relevant surface so a tap leads somewhere useful. Stale sections dim automatically.

## Taking over the screen: slots

The homescreen renderer, the home widget, and the persistent overlay are themselves artifacts — versioned, linkable, rollback-able:

```bash
surface slot                          # show current assignments
surface slot renderer <artifact-id>   # this artifact becomes the whole homescreen
surface slot home <artifact-id>       # widget above the card grid
surface slot overlay <artifact-id>    # persistent layer over everything
surface slot home --clear             # vacate a slot
```

A slot is just `metadata.display_role` on the artifact. Renderer iframes get an injected API (`window.__surfaces`, `navigate(id)`, `onSurfaceChange(...)`) for building custom launchers. Treat slots as the user's space — take over the renderer only when asked.

## Display control

- `surface open <id> [--on <device>]` — show a surface (everywhere, or on one named device). No arg returns to the grid.
- `surface notify "text" [--style info|success|warning|error] [--duration <ms>] [--on <device>]` — ephemeral toast.
- `surface theme '<json>'` / `surface theme -` / `surface theme reset` — colors, fonts, background, raw CSS, card order.
- `surface exec <id> --js '...'` (or `--file <p>` / `--js -`) — live JS poke inside a surface iframe, no new version. Good for one-off effects and debugging a running surface.

## Combinations that work

- **A build you watch from the couch**: `surface create "Build" --id build --template stream`, then `make 2>&1 | surface append build -`, with `surface set build progress 0.92` from a trap or wrapper.
- **Live dev loop**: `surface link $(pwd)/demo.html` once, then edit → `surface touch demo` after each save. The display is your hot-reload target.
- **Reach the user where they are**: `surface status` → if the phone is active, `surface ask "..." --on phone --wait`; otherwise ask everywhere.
- **Wait for another agent**: `surface wait --id board --event state_patch` blocks until someone else updates the board — cheap cross-agent coordination with no extra infrastructure.
- **Risky-change safety net**: `surface update` a workspace surface, show the user, `surface rollback <id> <n>` if they hate it.
- **Not just agents**: cron jobs, git hooks, and CI scripts can call `surface set` / `surface notify` too — a nightly script keeping a dashboard current costs one line.
- **Demo gallery**: `surface seed-demos` links every bundled example as a tutorial surface (idempotent — re-running revives hidden ones); `surface clear-demos` hides everything tagged `metadata.demo`. Use during first-run tours, then clear.

## Project conventions: `.surface/` and `SURFACE.md`

- `surface init` scaffolds `.surface/` (config, manifests, templates) and a starter `SURFACE.md`.
- Surfaces a project considers part of itself get manifests in `.surface/surfaces/*.json` (`surface sync --export <id>` writes one). `surface sync` recreates them on any machine — run it when manifests exist; it's idempotent.
- Keep `SURFACE.md` current the way you keep CLAUDE.md current: what each surface is for, which state keys to update when.
- Definitions belong in the repo; **live values never do** — they live in Surface's DB via `surface set`.

## Conventions

- Don't wrap PDFs, images, audio, video, or markdown in HTML — `present`, `link`, and `doc` handle them natively.
- Most external sites block iframes; use embed URLs (`open.spotify.com/embed/...`) or `surface video` for YouTube.
- PDFs from the web need the proxy: `<iframe src='/proxy/pdf?url=ENCODED_URL'>` inside artifact HTML.
- Surfaces should be self-contained (inline CSS/JS, no CDNs) — they render offline and screenshot headlessly.
- `surface --help` and `surface <cmd> --help` are authoritative.

## Environment & remote access

- `SURFACE_URL` — base URL (default `http://127.0.0.1:3000`). Loopback needs no credential.
- `SURFACE_SESSION` — session bearer for remote (non-loopback) agents. Mint from the Surface machine: `surface auth session issue --role system --label <where>`; audit with `surface auth session list`, cut off with `surface auth session revoke <id>`.
- Pair a new display for the user: `surface pair --name <device-name>` (prints URL + QR). Underneath it's `surface auth pairing create` — `auth pairing list` / `auth pairing revoke <id>` manage outstanding links.
