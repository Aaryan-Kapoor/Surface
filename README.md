<div align="center">

<img src="video/readme-banner/surface-banner.gif" alt="Markdown → HTML → Surface. An agent's chat folds into a live surface: tests flip as it works, you inject an edge case by touch, and every skill gets a surface." width="100%">

<br>
<br>

**The last app.** One self-hosted display that AI agents own end-to-end:
they push UI onto it, you tap it from any screen you own, and the tap finds
its way back to an agent — even one that exited hours ago.

[Quick start](#quick-start) ·
[Connect an agent](#connect-an-agent) ·
[The loop](#the-loop-clicks-always-come-back) ·
[CLI](#the-cli) ·
[HTTP API](#direct-http) ·
[Docs](docs/README.md)

</div>

---

## Give your agent Surface in one line

Paste this to any agent that can run a shell command (Claude Code, Cursor,
Codex CLI, Aider). It reads the install guide and bootstraps itself — no MCP
server, nothing to register:

```
Read and follow https://raw.githubusercontent.com/Aaryan-Kapoor/Surface/master/INSTALL_FOR_AGENTS.md
```

---

## Why

You don't need a weather app, a reading app, a kanban app, a game app. You
need **one display** and an agent that can fill it:

> "Surface me a pomodoro."
> "Put today's paper on my surface."
> "Ask me before shipping — I'll be on my phone."

Agents can already write anything. What they're missing is a *place*: a
persistent screen that outlives the session, follows you to your phone and
TV, and carries your clicks back. Surface is that place. Single user,
single deployment, all data on your machine, MIT-licensed.

**Markdown → HTML → Surface.** First agents answered in markdown — walls
of text you scroll and forget. Then they wrote HTML — beautiful for a
moment, but static: generated once, thrown away, nowhere to live, no way
to talk back. Surface is the natural next step: the same artifact, alive —
it stays on your screens, updates itself as the agent works, and every
tap, drag, and answer flows back to the agent that made it. "Surface" is
a verb now.

## What it feels like

**A question that waits for you.** The agent puts a question on every
screen you own and blocks until you answer — from your desk or your phone:

```bash
surface ask "Ship release v2.4.0 to production?" --options ship,hold --wait
# … you tap [ship] on your phone …
# → {"choice": "ship", "answered_at": "…", "device": "phone"}   exit 0
```

<img src="video/clips/every-screen/every-screen.gif" alt="One ask blooms on desk, phone, and TV; a tap on the phone answers all three and returns JSON to the blocked command." width="100%">

**A build you can watch from the couch.** Pipe any process into a live,
scrolling, ANSI-colored stream surface; update a progress bar with one line:

```bash
surface create "Build" --id build --template stream
make 2>&1 | surface append build -
surface set build progress 0.92
```

**An approval at 11pm, hours after the agent exited.** Register a binding
when you create the surface; when a click arrives and nobody is listening,
Surface revives the exact session that has the context:

```bash
surface bind deploy-panel --action "approve|hold" \
  --run 'claude -p --resume <session-id> "Handle the Surface action batch on stdin."'
```

The card shows **⟳ handling…** while the spawned session works, and the
click is acknowledged when it's done. Nothing is fire-and-forget; nothing
is lost.

<img src="video/clips/revival/revival.gif" alt="At 5:04pm the agent exits leaving a binding; at 11:02pm a tap on approve revives the exact session, which handles the action batch." width="100%">

**A team of agents, one screen of truth.** Every agent on your machine —
interactive sessions, `codex exec` jobs, cron scripts — writes into the
same board; you glance at one display instead of tailing four terminals:

```bash
surface set board claude-code '{"status":"tests green"}'
```

<img src="video/clips/multi-agent/multi-agent.gif" alt="Three agents — claude-code, codex, nightly-cron — each pulse their status into one shared release board." width="100%">

**A file served straight from your repo.** `surface link` a file and the
display renders it live from disk; edit it, `surface touch`, and every
screen catches up instantly — versionless, bundle-less hot reload:

```bash
surface link ./demo.html && $EDITOR demo.html && surface touch demo
```

<img src="video/clips/live-link/live-link.gif" alt="An edit to demo.html in the repo — heading and accent color — goes live on the surface the moment surface touch runs." width="100%">

## Quick start

```bash
git clone https://github.com/Aaryan-Kapoor/Surface.git
cd Surface
npm install
npm run dev        # → http://127.0.0.1:3000
```

For a persistent Linux user service:

```bash
./scripts/install-systemd-user-service.sh
systemctl --user status surface.service --no-pager
```

Put the single-file CLI on your `$PATH` (built automatically on install):

```bash
npm link
surface --help
```

Surface binds to `127.0.0.1` and stores everything under `~/.surface/`.
Read [SECURITY.md](SECURITY.md) before exposing it beyond loopback.

**Extra screens** pair in seconds — `surface pair --name kitchen-tablet`
prints a one-time URL + QR; the device names itself and shows up in
`surface devices`, individually revocable, targetable with `--on`.

## Connect an agent

The agent contract is two files — no MCP servers, no per-agent protocol,
nothing to register. Any agent that can run a shell command (Claude Code,
Cursor, Codex CLI, Aider, a cron script) works identically:

- **[`SKILL.md`](SKILL.md)** — what `surface` does and when to reach for
  each command. Drop it into your agent's skills directory.
- **[`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md)** — the first-run
  bootstrap an agent follows on a new machine, including a guided tour for
  new users.

Tell your agent: *"Read INSTALL_FOR_AGENTS.md and follow it."* That's the
whole integration.

## The CLI

```bash
surface list                              # what's on the display (check before creating!)
surface ask "Ship it?" --options ship,hold --wait      # question on every screen; blocks
surface link $(pwd)/demo.html --title D   # serve a file straight out of your repo, live
surface touch <id>                        # broadcast reload after editing it on disk
surface doc ./README.md --toc             # rendered repo markdown, hot-reloading
surface video https://youtu.be/abc123     # YouTube/web embed, one line
surface create "Build" --id build --template stream    # live log surface…
make 2>&1 | surface append build -        # …pipe a process into it
surface set build progress 0.42           # live state — bound elements re-render
surface present ./report.pdf              # one-shot file snapshot
surface open <id> --on phone              # show it (everywhere, or one device)
surface notify "deploy finished" --style success
surface wait --id <id> --action submit    # block until the user clicks
surface wait --follow                     # persistent terminal: one JSON line per click
surface bind <id> --action approve --run '…'           # clicks wake you when offline
surface set board claude-code '{"status":"tests green"}'  # shared multi-agent status board
surface devices                           # paired screens, live, what each is viewing
surface slot renderer <id>                # an artifact takes over the whole homescreen
surface theme '{"colors":{"accent":"#ff0080"}}'        # restyle the display
surface sync                              # reconstitute a project's surfaces from .surface/
```

`surface --help` and `surface <cmd> --help` are authoritative; intent
mapping lives in [`SKILL.md`](SKILL.md).

## Templates and live state

Agent-built UI doesn't mean 200 lines of hand-rolled HTML per update.
Templates are parameterized surfaces — `ask`, `stream`, `video`, `board`,
`doc` ship built-in, and agents promote any one-off surface into a reusable
template with `surface template create <name> --from <id>`. Project
templates override user templates override built-ins
([docs](docs/templates/overview.md)).

Every surface also carries a versioned JSON state document and an injected
runtime (`surface.js`): elements marked `data-surface-bind` re-render on
`surface set/patch`, and `Surface.action("approve", {...})` emits clicks
without any postMessage boilerplate. Updating a dashboard number is a shell
one-liner, not an HTML rewrite ([docs](docs/state/stateful-surfaces.md)).

Projects own their surfaces: `surface init` scaffolds a committable
`.surface/` directory (manifests, templates, config) plus a `SURFACE.md`,
and `surface sync` reconstitutes everything on a fresh clone
([docs](docs/state/project-directory.md)).

## The display is programmable too

Surface isn't a fixed app that agents post into — **the display itself is
the agent's medium**. The theme, the homescreen renderer, the home widget,
and the persistent overlay are all artifacts: versioned, linkable,
rollback-able, and rewritable by the same CLI that fills the cards. It
doesn't just fill your display; it runs it.

```bash
surface theme '{"colors":{"accent":"#ff0080"},"css":"…"}'   # restyle every screen
surface slot renderer <id>     # an artifact takes over the whole homescreen
surface slot home <id>         # …or the home widget (or `overlay`)
surface open <id> --on tv      # drive what a specific screen is showing
```

Movie night? The agent dims the theme. Standup? It swaps the homescreen
for the team board. Done? `surface slot renderer --clear` and the default
grid is back — every step versioned and reversible
([docs](docs/display/theming.md)).

## The loop: clicks always come back

The hard problem isn't pushing pixels — it's that **agent lifetimes are
shorter than surface lifetimes**. You tap "regenerate report" at 11pm; the
session that built it ended at 5. Surface resolves every action down a
three-layer ladder ([docs](docs/interaction/delivery-ladder.md)):

1. **Live action terminal** — a backgrounded `surface wait --follow` prints
   one JSON line per click, forever, and the harness's background watchdog
   wakes the agent *in the session that has the context*. While it's
   connected the card shows **● listening** — free, instant, the default.
   (One-shot `surface wait` exits with the first action instead.)
2. **Binding** — nobody listening? Surface spawns the registered command
   (`claude -p --resume …`, `codex exec`, a webhook into a daemon) with the
   pending-action batch on stdin. Argv-safe (never a shell), single-flight,
   rapid clicks coalesced into one batch. Opt-in, once per project.
3. **Inbox** — otherwise the action stays pending, badges the card, and is
   drained by `surface actions` at the next session start.

## Yours, all the way down

- **Two trust planes** — loopback is the agent plane (`system`: full
  power, attributed by name tag). Remote displays pair into named,
  revocable `device` sessions that can view, click, and drive the display
  but can never touch the filesystem, execute code, register bindings, or
  mint credentials ([docs](docs/auth/trust-model.md)). A phone left in a
  cab can browse your dashboard; it cannot reach your disk.
- **Self-hosted, no cloud** — one process, one SQLite file, your machine.

## Direct HTTP

The CLI is a thin wrapper over a local HTTP API — anything that can
`fetch` can drive the display.

<details>
<summary>Route map</summary>

```
GET    /artifacts             Full card list (one fetch renders a dashboard)
POST   /artifacts             Create workspace artifact (or {template, params})
POST   /artifacts/link        Register linked artifact (file lives in caller's repo)
POST   /artifacts/:id/touch   Broadcast reload for linked artifact
POST   /artifacts/present-file  One-shot file presentation
GET    /artifacts/:id         Read artifact   ·  PUT new version  ·  DELETE
GET    /artifacts/:id/versions / view / files/* / manifest / state / chunks
PATCH  /artifacts/:id/state   Deep-merge state; broadcasts state_patch
POST   /artifacts/:id/append  Append stream chunks
POST   /artifacts/:id/actions Display posts a user action
POST   /artifacts/:id/reply   Agent sends a toast
POST   /artifacts/:id/exec    Run JS in the surface iframe (system plane)
POST   /artifacts/:id/bindings  Register a wake-me binding (system plane)
GET    /actions               Pending inbox · POST /actions/:id/ack
GET    /stream                Global SSE (?wait_for=<id> registers a waiter)
GET    /artifacts/:id/stream  Per-surface SSE
GET    /display/status /config /slots · PUT /display/config
POST   /display/reset /navigate /notify   (navigate/notify accept {device})
GET    /api/auth/devices      Paired displays · POST /api/auth/devices/revoke
```

`PUT /artifacts/:id` and `POST /artifacts/:id/rollback` return `409` for
linked artifacts — edit the file on disk and `POST /artifacts/:id/touch`
instead. Full reference: [docs/core/http-api.md](docs/core/http-api.md).

</details>

## Architecture

One long-running service (Express 5 + better-sqlite3 + SSE) on
`127.0.0.1:3000`; a vanilla-JS PWA; a single-file CLI. Two artifact kinds:
**workspace** (bytes owned by Surface, linear version history) and
**linked** (bytes stay in your repo, served live from disk). No bundler, no
client dependencies, no cloud.

The full per-feature documentation tree lives in
[`docs/README.md`](docs/README.md) —
[`docs/architecture.md`](docs/architecture.md) is the orientation doc. The
legacy MCP adapter is preserved in [`archived/`](archived/) but the CLI +
`SKILL.md` is the canonical contract.

## License

MIT — see [LICENSE](LICENSE).
