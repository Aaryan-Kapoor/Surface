# Surface

**The last app.** A universal display that AI agents own end-to-end.

Instead of installing a weather app, a reading app, a game app — you have one Surface. Agents decide what goes on it.

> "Surface me a game."
> "Put today's paper on my surface."
> "Make my surface look cyberpunk."

Single deployment, single user. Self-hosted. Open source. Agents push content via a single shared CLI — no per-agent protocol.

## Quick Start

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

Make the `surface` CLI available on `$PATH`:

```bash
npm link
surface --help
```

Surface binds to `127.0.0.1` by default and stores all data under `~/.surface/`. See [SECURITY.md](SECURITY.md) before exposing it beyond loopback.

## Connect an Agent

The agent contract is two files:

- **[`SKILL.md`](SKILL.md)** — what `surface` does, when to use each command. Copy this into your agent's skills directory.
- **[`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md)** — first-time bootstrap routine, including a tutorial flow for new users.

Tell your agent: *"Read INSTALL_FOR_AGENTS.md and follow it."* Any agent that can run a shell command (Claude Code, Cursor, Codex CLI, Aider, custom scripts) works the same way.

## CLI

```bash
surface list                              # what's already on the display
surface ask "Ship to prod?" --options ship,hold --wait   # question on every screen; blocks for the answer
surface link $(pwd)/demo.html --title D   # register a file in your project (live)
surface touch <id>                        # broadcast reload after editing
surface doc ./README.md --toc             # rendered repo markdown, hot-reloading
surface video https://youtu.be/abc123     # YouTube/web embed, one line
surface create "Build" --id build --template stream      # live log surface…
make 2>&1 | surface append build -        # …pipe a process into it
surface set build progress 0.42           # live state — bound elements re-render
surface present ./report.pdf              # one-shot file snapshot
surface open <id> --on phone              # show it (everywhere, or one device)
surface notify "deploy finished" --style success
surface wait --id <id> --action submit    # block until user clicks; exit 0 with action JSON
surface bind <id> --action approve --run 'claude -p --resume <session> "…"'   # clicks wake you when offline
surface devices                           # paired screens, live state, what each is viewing
surface pair --name kitchen-tablet        # one-time pairing URL + QR for a new display
```

Full command reference: `surface --help` and `surface <cmd> --help`. Intent mapping: [`SKILL.md`](SKILL.md).

## Templates: dynamic UI in one line

Agent-generated UI doesn't mean agents writing 200 lines of HTML. Templates are parameterized, reusable surfaces — `ask`, `stream`, `video`, `board` (the multi-agent status dashboard), `doc` ship built-in; agents promote their own one-off surfaces into templates with `surface template create <name> --from <id>`. Projects override user templates override built-ins. See [`docs/templates/overview.md`](docs/templates/overview.md).

Every surface also carries a live JSON state doc (`surface set/patch`) and the injected `surface.js` runtime (`data-surface-bind`, `Surface.action()`) — updating a progress bar is one shell line, not an HTML rewrite.

## Direct HTTP

The CLI is a thin wrapper over an HTTP API on `127.0.0.1:3000`. Same primitives, accessible from anything that can `fetch`:

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

`PUT /artifacts/:id` and `POST /artifacts/:id/rollback` return `409` for linked artifacts — edit the file on disk and `POST /artifacts/:id/touch` instead.

## Reacting to clicks: the delivery ladder

A click is never lost ([`docs/interaction/delivery-ladder.md`](docs/interaction/delivery-ladder.md)):

1. **Live waiter** — a backgrounded `surface wait` exits with the action JSON and the harness wakes the agent *in the session that has the context*.
2. **Binding** — no waiter connected? Surface spawns the registered command (`claude -p --resume …`, `codex exec`, a webhook into a daemon) with the pending-action batch on stdin. Argv-safe, single-flight, coalesced.
3. **Inbox** — otherwise the action stays pending, badges the card, and is drained at the next session start (`surface actions`).

Surfaces emit actions with the injected runtime — `Surface.action("approve", {env: "prod"})` — no postMessage boilerplate.

## Display Control

Agents own the display:

- **Theming** — colors, fonts, backgrounds, starfield/nebula effects, raw CSS injection.
- **Slots are artifacts** — the custom homescreen renderer, home widget, and persistent overlay are ordinary artifacts marked with `metadata.display_role` (`surface slot renderer <id>`): versioned, linkable, rollback-able.
- **Per-device targeting** — `surface open/notify --on <device>` moves one named screen; `surface devices` shows the fleet.
- **Live JS execution** — `surface exec <id> --js '...'` runs code inside a surface iframe without creating a new version.

## Auth: two planes

Loopback is the agent plane (`system` role — same machine, same uid, full power). Remote displays pair via one-time tokens into named, revocable `device` sessions that can view, click, and control the display but never touch the filesystem, execute code, or mint credentials. Remote *agents* carry a system bearer minted with `surface auth session issue --role system`. See [`docs/auth/trust-model.md`](docs/auth/trust-model.md).

## Architecture

See [`docs/README.md`](docs/README.md) for the full per-feature documentation tree ([`docs/architecture.md`](docs/architecture.md) is the orientation doc). Quick version:

- One long-running service (Express 5 + better-sqlite3 + SSE) on `127.0.0.1:3000`.
- All data under `~/.surface/` (`db.sqlite` + `artifacts/`).
- Vanilla JS PWA, hash routing, sandboxed iframes.
- Two artifact types: **workspace** (bytes owned by Surface, versioned) and **linked** (bytes in agent's project, served live from disk, no versioning).
- CLI + `SKILL.md` as the canonical agent contract. MCP adapter lives in `archived/` for legacy users.

## MCP (archived)

Surface previously shipped an MCP stdio adapter. It now lives in [`archived/mcp.ts`](archived/) for backwards compatibility. New installs should use the CLI + `SKILL.md` path. See `archived/README.md`.

## Stack

- Express 5 + SQLite (better-sqlite3)
- SSE for live updates
- Vanilla JS PWA
- `tsx` for dev, service, and CLI runtime
- No bundler. No client-side dependencies.

## License

MIT — see [LICENSE](LICENSE).
