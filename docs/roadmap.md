# Roadmap

The approved build plan. Every feature here has a full spec in this docs tree — this file is the ordering, the scope boundaries, and the acceptance bar. Statuses: each phase ships independently and leaves the system working.

## Recently completed

- Artifact architecture (workspace + linked artifacts, versions), CLI + SKILL.md as the canonical agent contract, MCP archived
- T3-style pairing tokens and sessions
- Cached-screenshot dashboard (headless-Chrome CDP thumbnails) replacing live iframe previews
- **Marketplace removed entirely** (routes, catalog, Explore view, docs)

## Phase 1 — Foundation

One data model, real roles, project ownership, device management.

| Work | Spec |
|---|---|
| Collapse the dual model: migrate legacy `surfaces` rows into artifacts at boot, drop the table; remove `/surfaces/*` API (307 redirects for one release); fold `surface_views` into artifacts (or a SQL view); drop dead schema (`sandbox_sessions`, `pinned`, `thumbnail_path`, `created_by`) | [core/artifacts.md](core/artifacts.md) |
| Split `server/routes.ts` (1.6k lines) into routers: artifacts, display, actions, auth, integrations | — |
| Grid list returns full card payloads (kills the client N+1) | [display/pwa.md](display/pwa.md) |
| `project_root` column + `--agent` label on all create paths; dashboard grouping; `--project`/`--agent` filters | [auth/project-ownership.md](auth/project-ownership.md) |
| Roles `system`/`device` + capability enforcement (incl. restricting `exec` to system); pairing defaults to `device` | [auth/trust-model.md](auth/trust-model.md) |
| Device naming at pair time, `surface devices` list/revoke, rolling session expiry | [auth/device-pairing.md](auth/device-pairing.md) |
| Per-device presence + `--on <device>` targeting for open/notify | [display/devices.md](display/devices.md) |
| `SURFACE_TOKEN` deprecation warning (removal next release) | [auth/trust-model.md](auth/trust-model.md) |

**Done when:** a fresh DB has no legacy tables; a phone pairs with a name, appears in `surface devices`, and cannot exec/link/bind; `surface open x --on phone` moves only the phone; the grid loads with one fetch; all tests pass.

## Phase 2 — State & Templates

The agent-generated UI layer.

| Work | Spec |
|---|---|
| State store, `surface set/patch/state`, `state_patch` SSE, `surface.js` runtime (`data-surface-bind`, `Surface.action`) | [state/stateful-surfaces.md](state/stateful-surfaces.md) |
| Template engine: anatomy, resolution (project → user → built-in), `--template/--param`, `surface template list/show/create` | [templates/overview.md](templates/overview.md), [templates/authoring.md](templates/authoring.md) |
| Built-ins: `ask` (+ `surface ask` sugar), `stream` (+ `surface append`), `video`, `board`, `doc` | [templates/](templates/overview.md) |
| `.surface/` project directory, `SURFACE.md`, `surface init` / `surface sync` | [state/project-directory.md](state/project-directory.md) |

**Done when:** `surface ask … --wait` answered from a phone returns JSON to a blocked script; a piped build log streams live; `surface set` updates a bound element without reload; a fresh clone + `surface sync` recreates a project's surfaces; the board shows two agents' sections with staleness dimming.

## Phase 3 — Delivery Ladder

Clicks reliably reach agents — including agents that aren't running.

| Work | Spec |
|---|---|
| `surface wait` returns oldest-pending first; ack implicit on delivery/reply; waiter presence ("● listening") | [interaction/actions-inbox.md](interaction/actions-inbox.md) |
| Bindings: schema, `--on-action/--run`, `surface bind/bindings/unbind`, command spawn (argv-safe, stdin batch, cwd=project_root, single-flight + coalescing, logs, `binding_status` SSE) and per-surface webhooks with retry | [interaction/bindings.md](interaction/bindings.md) |
| Ladder semantics: waiter suppresses binding; card states (●/⟳/badge); per-project disable | [interaction/delivery-ladder.md](interaction/delivery-ladder.md) |
| Inbox UX: pending badges, header count, session-start drain convention; TTL cleanup (handled 7d, pending 30d) | [interaction/actions-inbox.md](interaction/actions-inbox.md) |
| SKILL.md rewrite: harness recipes (Claude Code `--resume {session} -p`, Codex `exec`, OpenClaw webhook), re-arm discipline, board/SURFACE.md conventions | [interaction/bindings.md](interaction/bindings.md#harness-recipes) |

**Done when:** clicking a surface with no agent alive spawns the bound command with the action batch on stdin and the card shows ⟳ then ✓; five rapid clicks cause one spawn; a waiter connected suppresses the binding; an unhandled overnight click is drained by the next morning's session.

## Phase 4 — Polish & Debt

| Work | Notes |
|---|---|
| SSE keepalive heartbeat (15–30s) + reconnect in `surface stream` | [core/events.md](core/events.md) |
| Sandboxing decision: separate origin (second port) for artifact content + `renderArtifactShell` XSS fix | [operations/security.md](operations/security.md) |
| Single-file CLI build (`esbuild --bundle`) so `surface` installs without the repo toolchain | [core/cli.md](core/cli.md) |
| Install state out of `INSTALL_FOR_AGENTS.md` frontmatter → `~/.surface/install-state.json` (stops the by-design dirty tracked file) | [operations/install.md](operations/install.md) |
| Remove `surfaces.db*` from repo root + gitignore; drop `suspendTheme` dead code; `SURFACE_TOKEN` removal | hygiene |
| Renderer/home/overlay slots: become artifacts or get cut (decide) | [display/theming.md](display/theming.md) |
| If-Match preconditions on workspace `PUT` (concurrency) | [core/artifacts.md](core/artifacts.md) |

## Explicitly out of scope

- **Public sharing / multi-user** — Surface is private, single-user; remote auth exists to authenticate the user's own displays, nothing else.
- **Annotation layer** (select/point feedback on surfaces) — considered, skipped.
- **Marketplace** — removed; not coming back in this form.
- **Per-agent authentication** — impossible on a shared uid; attribution only ([auth/project-ownership.md](auth/project-ownership.md)).
