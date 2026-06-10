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
surface link $(pwd)/demo.html --title D   # register a file in your project (live)
surface touch <id>                        # broadcast reload after editing
surface create "Hello" --mime text/html --content -   # ad-hoc HTML from stdin
surface present ./report.pdf              # one-shot file snapshot
surface open <id>                         # force the display to show it
surface notify "deploy finished" --style success
surface theme '{"colors":{"accent":"#ff0080"}}'
surface wait --id <id> --action submit    # block until user clicks; exit 0 with action JSON
surface stream                            # tail SSE events as JSONL
surface pair --base-url http://host:3000  # print a one-time pairing URL + QR
```

Full command reference: `surface --help` and `surface <cmd> --help`. Intent mapping: [`SKILL.md`](SKILL.md).

## Direct HTTP

The CLI is a thin wrapper over an HTTP API on `127.0.0.1:3000`. Same primitives, accessible from anything that can `fetch`:

```
POST   /artifacts             Create workspace artifact
POST   /artifacts/link        Register linked artifact (file lives in caller's repo)
POST   /artifacts/:id/touch   Broadcast reload for linked artifact
POST   /artifacts/present-file  One-shot file presentation
GET    /artifacts             List artifacts
GET    /artifacts/:id         Read artifact
PUT    /artifacts/:id         New version (workspace artifacts only)
DELETE /artifacts/:id         Delete artifact
GET    /artifacts/:id/versions / view / files/* / manifest
POST   /artifacts/:id/rollback   Workspace artifacts only
GET    /surfaces              List display cards
POST   /surfaces/:id/exec     Run JS in surface iframe
POST   /surfaces/:id/actions  Surface posts a user action
POST   /surfaces/:id/reply    Agent sends a toast
GET    /actions               List pending actions
POST   /actions/:id/ack       Acknowledge an action
GET    /stream                Global SSE
GET    /surfaces/:id/stream   Per-surface SSE
GET    /display/status / config
PUT    /display/config        Set theme / renderer / overlay
POST   /display/reset / navigate / notify
```

`PUT /artifacts/:id` and `POST /artifacts/:id/rollback` return `409` for linked artifacts — edit the file on disk and `POST /artifacts/:id/touch` instead.

## Display Control

Agents own the display:

- **Theming** — colors, fonts, backgrounds, starfield/nebula effects, raw CSS injection.
- **Custom renderer** — replace the homescreen with your own HTML/CSS/JS (`window.__surfaces`, `navigate(id)` injected).
- **Overlays** — persistent HTML across all views.
- **Home widgets** — iframe above the card grid.
- **Live JS execution** — `surface exec <id> --js '...'` runs code inside a surface iframe without creating a new version.

## Webhook Fan-Out (optional)

Most agents don't need this. Use `surface wait` (blocking, in a background subprocess) or `surface stream` (long-poll SSE) to react to clicks directly. The webhook is only useful when a separate long-running gateway process wants Surface to POST to it.

Surface can forward user actions to an external agent gateway:

```
SURFACE_WEBHOOK_URL=http://127.0.0.1:18789
SURFACE_WEBHOOK_TOKEN=your-hooks-token
# SURFACE_WEBHOOK_PATH=/hooks/agent   (default)
```

Payload is structured JSON: `{ type: "surface_action", surface_id, surface_title, action, data, created_at }`. `OPENCLAW_GATEWAY_URL` / `OPENCLAW_HOOKS_TOKEN` are accepted as legacy aliases.

## Two-Way Communication

Surfaces can talk back. Inside your surface HTML:

```javascript
parent.postMessage({
  type: 'surface_action',
  action: 'button_clicked',
  data: { button: 'submit', value: 42 }
}, '*');
```

Agents read via `surface actions [<id>]` or push via `surface stream`. Respond with `surface reply <id> <text>`, an artifact update, or `surface exec`.

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full picture. Quick version:

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
