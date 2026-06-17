# Surface Documentation

One file per feature, organized by concern. Every doc opens with a status line. As of 2026-06 **everything here is Shipped** — all four roadmap phases are built, and each doc describes the code as it runs today, with file references. (The earlier statuses — *Partially shipped*, *Approved — not yet built* — are gone; the [roadmap](roadmap.md) is kept as the record of what was decided and why.)

**New here (human or agent)?** Read in this order: [architecture.md](architecture.md) → [core/artifacts.md](core/artifacts.md) → [core/cli.md](core/cli.md) → [roadmap.md](roadmap.md). Then drill into whatever you're touching.

## Top level

| Doc | What |
|---|---|
| [architecture.md](architecture.md) | Orientation: process model, core concepts, the loop, trust summary |
| [roadmap.md](roadmap.md) | The build plan as decided and shipped — phases, scope, acceptance criteria, non-goals |
| [TUTORIAL.md](TUTORIAL.md) | 7-step first-run walkthrough an agent narrates to the user |

## core/ — the shipped engine

| Doc | What |
|---|---|
| [core/artifacts.md](core/artifacts.md) | Data model: artifacts, versions, files, storage kinds, state/stream/binding tables |
| [core/linked-artifacts.md](core/linked-artifacts.md) | Files living in user repos, served live; `link` + `touch` hot reload |
| [core/cli.md](core/cli.md) | Complete `surface` command reference |
| [core/http-api.md](core/http-api.md) | Complete HTTP route reference + auth resolution order |
| [core/events.md](core/events.md) | SSE event catalog and consumers |
| [core/thumbnails.md](core/thumbnails.md) | Headless-Chrome screenshot pipeline for dashboard cards |

## auth/ — who may do what

| Doc | What |
|---|---|
| [auth/trust-model.md](auth/trust-model.md) | The two planes: system (loopback agents) vs device (paired displays); capability matrix; `SURFACE_TOKEN` removal |
| [auth/device-pairing.md](auth/device-pairing.md) | Pairing tokens → named, revocable device sessions |
| [auth/project-ownership.md](auth/project-ownership.md) | Surfaces belong to git projects; agents are self-reported labels |

## interaction/ — clicks reaching agents

| Doc | What |
|---|---|
| [interaction/actions-inbox.md](interaction/actions-inbox.md) | The action queue, ack semantics, durable inbox, TTL |
| [interaction/delivery-ladder.md](interaction/delivery-ladder.md) | waiter → binding → inbox: how a click finds (or starts) an agent |
| [interaction/bindings.md](interaction/bindings.md) | Commands/webhooks Surface fires on actions; harness recipes (Claude Code, Codex, OpenClaw) |

## state/ — live data instead of HTML rewrites

| Doc | What |
|---|---|
| [state/stateful-surfaces.md](state/stateful-surfaces.md) | Per-surface JSON state, `surface set/patch`, `surface.js` bindings |
| [state/project-directory.md](state/project-directory.md) | `.surface/` manifests + `SURFACE.md` in the repo; `surface init/sync` |

## templates/ — reusable dynamic UI

| Doc | What |
|---|---|
| [templates/overview.md](templates/overview.md) | Anatomy, resolution order, instantiation, built-ins table |
| [templates/authoring.md](templates/authoring.md) | Making templates (agents should); promote-from-surface |
| [templates/ask.md](templates/ask.md) | Context-full questions answerable from any display |
| [templates/stream.md](templates/stream.md) | Append-only live logs/narration |
| [templates/video.md](templates/video.md) | YouTube/embeds in one line |
| [templates/board.md](templates/board.md) | The multi-agent status board |
| [templates/doc.md](templates/doc.md) | Repo markdown files, rendered, hot-reloading |

## display/ — what the user sees

| Doc | What |
|---|---|
| [display/pwa.md](display/pwa.md) | The dashboard web app: grid, detail view, finder, toasts |
| [display/theming.md](display/theming.md) | Theme config, renderer/home/overlay slots |
| [display/devices.md](display/devices.md) | Per-device presence and `--on <device>` targeting |

## operations/ — running it

| Doc | What |
|---|---|
| [operations/install.md](operations/install.md) | Service install, env vars, startup pairing, demo seeding |
| [operations/security.md](operations/security.md) | Threat model summary; defers to `SECURITY.md` |
| [operations/development.md](operations/development.md) | Repo layout, stack, tests, conventions |

## Agent contract files (repo root)

`SKILL.md` (when/how to use the CLI — the doc agents copy into their skill dirs), `INSTALL_FOR_AGENTS.md` (bootstrap flow), `SECURITY.md` (full threat model), `USECASES.md` (vision/ideas).
