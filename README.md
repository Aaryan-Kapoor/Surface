<div align="center">

<img src="https://raw.githubusercontent.com/Aaryan-Kapoor/Surface/master/video/readme-banner/surface-banner.gif" alt="Markdown → HTML → Surface. An agent's chat folds into a live surface: tests flip as it works, you inject an edge case by touch, and every skill gets a surface." width="100%">

<br>
<br>

**A two-way interaction primitive for AI agents.** Your agent renders live UI
onto every screen you own — and every tap, stroke, and answer lands back in its
context as *intent*, the moment it happens, even if its session ended hours ago.
**State flows out. Actions flow back.**

[Quick start](#quick-start) ·
[The loop](#the-loop) ·
[What you can build](#what-you-can-build) ·
[Clicks come back](#clicks-always-come-back) ·
[CLI](#the-cli) ·
[Docs](docs/README.md)

[![CI](https://github.com/Aaryan-Kapoor/Surface/actions/workflows/ci.yml/badge.svg)](https://github.com/Aaryan-Kapoor/Surface/actions/workflows/ci.yml)
[![Canary](https://github.com/Aaryan-Kapoor/Surface/actions/workflows/canary.yml/badge.svg)](https://github.com/Aaryan-Kapoor/Surface/actions/workflows/canary.yml)
[![npm](https://img.shields.io/npm/v/surface-display)](https://www.npmjs.com/package/surface-display)

</div>

---

## A new primitive, not a new app

Agents have exactly one interaction channel: the text turn. They write, you
read; you write, they read. Anything richer — a chart, a form, a canvas, a
board you both draw on — either collapses back into prose or gets rendered
once and thrown away.

**Markdown → HTML → Surface.**

- **Markdown** gave agents *formatting*. Walls of text you scroll and forget.
- **HTML** gave them *rendering*. Beautiful for a moment, then dead: generated
  once, nowhere to live, no way to talk back.
- **Surface** gives them a *loop*. The same artifact, alive — it stays on your
  screens, updates itself while the agent works, and everything you do to it
  is an input the agent receives.

That's the whole claim, and it's a small one: not a nicer output format, a
**return path**. Once UI is bidirectional the interesting part isn't the
pixels, it's that a category of things an agent simply could not do before
becomes a short prompt.

Mechanically it's unglamorous. One local service on your machine. Your agents
drive it with a `surface` CLI; your phone, tablet, and TV open it in a browser.
Single user, local-first, MIT, no cloud and no account.

## The loop

Every surface carries a versioned JSON state document and an injected runtime
(`surface.js`) — no build step, no bundler, no `postMessage` boilerplate. The
agent writes the HTML once. After that, state goes out and actions come back.

**State out.** Mark any element with `data-surface-bind` and it re-renders on
every screen the instant the agent writes that key. You never regenerate HTML
to change a number.

```html
<b data-surface-bind="tests.passed">0</b> passing
<button onclick="Surface.action('rerun', {suite: 'e2e'})">Re-run e2e</button>
```

```bash
surface set ci tests.passed 214                        # one key
surface patch ci '{"progress":0.92,"stage":"e2e"}'     # many at once, deep-merged
```

**Actions back.** `Surface.action(name, data)` emits a click. The agent reads
them as one JSON line per action, forever:

```bash
surface wait --follow
# {"id":"…","surface_id":"ci","surface_title":"CI","action":"rerun","data":{"suite":"e2e"},"created_at":"…"}
```

For a multi-step interaction, keep the intermediate clicks local with
`Surface.stage(key, value)` and fire one action at the end with
`Surface.commit(name)` — so the agent wakes **once, on your actual intent**,
not once per toggle. State persists across sessions; `surface state <id>` reads
it back. ([docs](docs/state/stateful-surfaces.md))

None of that markup is required. The shortest complete loop is one command: it
puts a question on every screen you own and blocks the agent until you answer,
from wherever you happen to be.

```bash
surface ask "Ship release v2.4.0 to production?" --options ship,hold --wait
# … you tap [ship] on your phone …
# {"choice":"ship","text":null,"answered_at":"…","device":"phone","surface_id":"…"}
```

## What you can build

Surface ships none of these. Each one is a few commands your agent writes on
the spot — which is exactly the point. A primitive you have to extend for every
new idea isn't one.

### A whiteboard you and your agent share

You're deep in a study session with your agent and say *"make a whiteboard."*
It writes a canvas surface and puts it on your tablet. You draw. Strokes stage
locally and commit as one action, so it wakes on the drawing, not on every
pixel:

```html
<canvas id="board"></canvas>
<script>
  const c = document.getElementById("board");
  let n = 0;
  c.addEventListener("pointermove", e => Surface.stage("p" + n++, [e.offsetX, e.offsetY]));
  c.addEventListener("pointerup",   () => Surface.commit("drew"));
</script>
```

Your agent reads back what you drew as data (`surface state board`) and adds
to the board the same way it changes any other value (`surface patch board …`)
— your tablet re-renders live, no reload.

It can also *look* at it. Surface screenshots every surface through headless
Chrome for the dashboard grid, so a real PNG of your board already exists at
`/artifacts/<id>/thumb` ([docs](docs/core/thumbnails.md)). There is no
`surface see <id>` verb wrapping that yet — today the agent fetches that route
itself.

### A Rubik's cube coach that watches every move

*"Teach me to solve this."* The agent builds a cube surface. Here you **want**
a wake per move, so each turn fires its own action instead of staging:

```js
Surface.action("move", { face: "R", dir: "cw" });
```

Its `surface wait --follow` terminal prints one line per turn, so the agent
knows the state of your cube at the moment you turn it, and pushes the next hint
back into the surface with `surface patch cube '{"hint":"now F2"}'`. Not "here
are the twelve steps" — coaching, in step with you.

### UI conjured mid-conversation, then gone

The Iron Man thing — *"Jarvis, open a map and highlight the nearest coffee
shop"* — was never really a rendering problem. Agents write good HTML already.
What they lacked was somewhere to put it and a way to hear you use it. One
command puts a panel built for exactly this task on exactly the screen you're
holding, and one removes it:

```bash
surface create "Coffee" --id coffee --content -   # agent pipes the HTML in
surface open coffee --on phone                    # or every screen at once
surface delete coffee                             # gone when you're done
```

Surfaces are self-contained — inline CSS and JS, no CDNs — so they render
offline and screenshot cleanly.

**The possibilities are the point.** Surface ships no whiteboard, no cube, no
map. It ships the loop that makes all three a short prompt. Ask your agent
for **the Surface tour** to watch working ones get built.

## Quick start

**Node 22+.** Two commands, identical on Linux, macOS, and Windows:

```bash
npm install -g surface-display
surface                    # first run: offers setup → http://127.0.0.1:3000
```

Bare `surface` on a fresh machine walks you through setup interactively; in a
script, `surface service install` does the same thing with no questions. Either
way it registers the native per-user supervisor — a systemd user unit, a
launchd agent, or a Scheduled Task — starts the server, succeeds only once it
answers health checks, and links the Surface skill into your agents' skill
directories (`~/.agents/skills`, `~/.claude/skills`). (There is deliberately no
foreground `serve` command: a supervised service is the only sanctioned way to
run Surface, so nothing ends up squatting the port unnoticed.)

```bash
surface service health     # liveness, version, content plane (exit 0/1)
surface service logs       # same log file on every platform
surface service status|start|stop|restart|uninstall
surface upgrade            # package + skill + service, converged in one command
```

**Extra screens** pair in seconds. `surface pair --name kitchen-tablet` prints
a one-time URL and a QR code; the device names itself, appears in
`surface devices`, is individually revocable, and is targetable with `--on`.

Surface binds `127.0.0.1` and stores everything under `~/.surface/`. Read
[SECURITY.md](SECURITY.md) before exposing it beyond loopback.

<details>
<summary>Hacking on Surface itself</summary>

```bash
git clone https://github.com/Aaryan-Kapoor/Surface.git
cd Surface
npm install        # prepare hook bundles the CLI + server into dist/
npm run dev        # foreground dev server → http://127.0.0.1:3000
npm link           # put the local `surface` CLI on $PATH
```

</details>

## Connect an agent

Surface is not an MCP server and there is nothing to register. The contract is
a CLI plus a skill file, so **any agent that can run a shell command** works
identically. Paste this to yours:

```
Read and follow https://raw.githubusercontent.com/Aaryan-Kapoor/Surface/master/INSTALL_FOR_AGENTS.md
```

It installs the CLI, starts the service, and runs `surface skill install` —
which keeps a canonical [`SKILL.md`](SKILL.md) in your data dir and links it
into `~/.agents/skills/` (the open skills standard: Codex CLI, Cursor, Gemini
CLI, Copilot, Zed, Amp, Goose, OpenCode, Roo, Kilo, Windsurf) and
`~/.claude/skills/` (Claude Code reads only its own directory).

That's the whole integration. [`SKILL.md`](SKILL.md) tells an agent *when* to
reach for each verb; [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) is the
first-run bootstrap, including a guided tour it can narrate to a new user.

## Clicks always come back

The hard problem isn't pushing pixels — it's that **agent lifetimes are shorter
than surface lifetimes**. You tap "regenerate report" at 11pm; the session that
built it ended at 5. A return path that only works while someone is watching
isn't a return path, so Surface resolves every action down a layered ladder
([docs](docs/interaction/delivery-ladder.md)):

1. **Live action terminal** — a backgrounded `surface wait --follow` prints one
   JSON line per click, forever, waking the agent *in the session that has the
   context*. It drains anything that piled up while it was gone the moment it
   connects. While it's attached the card shows **● listening** — free,
   instant, the default. (One-shot `surface wait` exits with the first action
   instead.)
2. **Binding** — nobody listening? Surface spawns a registered command
   (`claude -p --resume …`, a webhook into a daemon) with the pending-action
   batch on stdin. Argv-safe, never shelled, single-flight, rapid clicks
   coalesced into one batch. Because that runs a command on your machine while
   you're away, it is opt-in per project and needs your recorded consent:

   ```bash
   surface bind deploy-panel --action "approve|hold" \
     --run 'claude -p --resume <session-id> "Handle the Surface action batch on stdin."'
   ```

   The card shows **⟳ handling…** while the spawned session works, and the
   click is acknowledged only when it's done.
3. **Codex flowback** — surfaces made by a Codex session remember their thread.
   After a one-time `surface codex setup`, clicks arrive as native turns in the
   live Codex TUI, and consent-gated wakes revive dead threads in place — the
   whole exchange is right there in `codex resume`
   ([docs](docs/interaction/codex.md)).
4. **Inbox** — otherwise the action waits, badges the card, and is drained by
   `surface actions` at the next session start.

Nothing is fire-and-forget. Nothing is lost.

## The CLI

```bash
surface list                              # what's on the display (check before creating!)
surface ask "Ship it?" --options ship,hold --wait      # question on every screen; blocks
surface create "Panel" --content - --id p # ad-hoc interactive HTML from stdin
surface link $(pwd)/demo.html             # serve a file straight out of your repo, live
surface touch <id>                        # broadcast reload after editing it on disk
surface doc ./README.md --toc             # rendered repo markdown, hot-reloading
surface video https://youtu.be/abc123     # YouTube/web embed, one line
surface present ./report.pdf              # one-shot file snapshot
surface create "Build" --id build --template stream    # live log surface…
make 2>&1 | surface append build -        # …pipe a process into it
surface set build progress 0.42           # live state — bound elements re-render
surface patch build '{"stage":"e2e"}'     # …or many keys at once
surface state build                       # read it back
surface open <id> --on phone              # show it (everywhere, or one device)
surface notify "deploy finished" --style success
surface wait --follow                     # persistent terminal: one JSON line per click
surface bind <id> --action approve --run '…'           # clicks wake you when offline
surface actions                           # drain the durable inbox
surface set board claude-code '{"status":"tests green"}'  # shared multi-agent status board
surface devices                           # paired screens, live, what each is viewing
surface slot renderer <id>                # an artifact takes over the whole homescreen
surface theme '{"colors":{"accent":"#ff0080"}}'        # restyle the display
surface sync                              # reconstitute a project's surfaces from .surface/
```

`surface --help` and `surface <cmd> --help` are authoritative; intent mapping
lives in [`SKILL.md`](SKILL.md).

**Templates** keep agents from hand-rolling 200 lines of HTML per update.
`ask`, `stream`, `video`, `board`, and `doc` ship built in, and any one-off
surface is promotable with `surface template create <name> --from <id>`;
project templates override user templates override built-ins
([docs](docs/templates/overview.md)). **Projects own their surfaces**:
`surface init` scaffolds a committable `.surface/` directory plus a
`SURFACE.md`, and `surface sync` reconstitutes everything on a fresh clone
([docs](docs/state/project-directory.md)).

## Trust model

Two planes, and Surface is honest about both. Loopback is the **agent plane**
(`system`): full power, attributed by name tag. Surface trusts every agent that
can reach it as much as it trusts you, because anything with shell access
already has your authority — there is no per-agent sandboxing, and a malicious
agent is out of scope. Remote screens pair into named, revocable **`device`**
sessions that can view, click, and answer but can never write state, touch the
filesystem, execute JS, register bindings, change the display, or mint
credentials ([docs](docs/auth/trust-model.md)). A phone left in a cab can
browse your dashboard; it cannot reach your disk. Everything lives in one
process, one SQLite file, on `127.0.0.1`, under `~/.surface/`. Wake bindings
are the one thing that runs a command while you're away, so an agent must have
your recorded per-project consent before registering one. Full threat model:
[SECURITY.md](SECURITY.md).

The display itself is yours too — colors, fonts, backgrounds, raw CSS, card
order. The homescreen renderer, home widget, and floating overlay are
themselves artifacts (versioned, linkable, roll-back-able) promoted with
`surface slot` ([docs](docs/display/theming.md)).

## Direct HTTP

The CLI is a thin wrapper over a local HTTP API — anything that can `fetch` can
drive the display.

<details>
<summary>Route map</summary>

```
GET    /artifacts             Full card list (one fetch renders a dashboard)
POST   /artifacts             Create workspace artifact (or {template, params})
POST   /artifacts/link        Register linked artifact (file lives in caller's repo)
POST   /artifacts/:id/touch   Broadcast reload for linked artifact
POST   /artifacts/present-file  One-shot file presentation
GET    /artifacts/:id         Read artifact   ·  PUT new version  ·  DELETE
GET    /artifacts/:id/versions / view / files/* / manifest / state / chunks / thumb
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

`PUT /artifacts/:id` and `POST /artifacts/:id/rollback` return `409` for linked
artifacts — edit the file on disk and `POST /artifacts/:id/touch` instead. Full
reference: [docs/core/http-api.md](docs/core/http-api.md).

</details>

## Where to go next

One long-running service (Express 5 + better-sqlite3 + SSE) on
`127.0.0.1:3000`; a vanilla-JS PWA; a single-file CLI. Two artifact kinds:
**workspace** (bytes owned by Surface, linear version history) and **linked**
(bytes stay in your repo, served live from disk).

- [`docs/architecture.md`](docs/architecture.md) — the orientation doc
- [`docs/README.md`](docs/README.md) — one file per feature, all of it
- [`docs/TUTORIAL.md`](docs/TUTORIAL.md) — the first-run walkthrough
- [`USECASES.md`](USECASES.md) — the patterns that pay off first
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the local verification gate

Surface is single-user, local-first software. It is not a multi-tenant SaaS
collaboration backend, and it is not trying to become one. The legacy MCP
adapter is preserved in [`archived/`](archived/); the CLI plus
[`SKILL.md`](SKILL.md) is the canonical contract.

## License

MIT — see [LICENSE](LICENSE).
