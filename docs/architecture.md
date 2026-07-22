# Surface Architecture

Surface is a self-hosted, single-user **display service for AI agents** — the first step toward an actual agent-generated UI experience. Agents push content to the user's screens with one CLI line; the user views it on any paired display (laptop, phone, desk monitor); clicks flow back to agents — including agents that aren't running, which Surface wakes. One long-running process owns everything: SQLite, the artifact store, the PWA, SSE fan-out, and display state.

The product thesis: **agent-generated UI doesn't mean agents writing HTML — it means agents composing live, interactive, answerable interfaces from primitives in one line of shell.** Templates, state, actions, and the delivery ladder are those primitives. Static HTML remains the escape hatch.

## Process model

```
 agent plane (loopback, trusted)              display plane (paired, authenticated)
┌─────────────────────────────┐              ┌──────────────────────────────┐
│ Claude Code ─┐              │              │  laptop browser (local)      │
│ Codex        ├─ surface CLI ─┼──► Surface ──┼─► phone          (device)    │
│ OpenClaw     │              │   service    │  desk monitor    (device)    │
│ scripts     ─┘              │   Express+   │       ▲    SSE + HTTP        │
│      ▲                      │   SQLite     │       └── clicks (actions)   │
│      └── spawned by bindings ◄──────────────┘                              │
└─────────────────────────────┘  ~/.surface/ + linked files in user repos
```

- **Service** (`server/`): Express 5 on `127.0.0.1:3000` by default; owns `~/.surface/` (DB, workspace artifacts, thumbnails) and re-serves linked files from the user's repos.
- **CLI** (`bin/surface.ts`): the canonical client for every agent; mirrors the HTTP API.
- **PWA** (`client/`): vanilla JS, no build step; grid of screenshot cards + full-screen surface view.
- **SKILL.md / SURFACE.md / INSTALL_FOR_AGENTS.md**: the agent contract — global, per-project, and bootstrap respectively.

## Core concepts

| Concept | One line | Spec |
|---|---|---|
| **Surface / artifact** | A unit of displayable content: generated HTML, a presented file, or a linked file/dir | [core/artifacts.md](core/artifacts.md) |
| **Linked artifact** | Bytes live in the user's repo; Surface re-serves them; `touch` hot-reloads | [core/linked-artifacts.md](core/linked-artifacts.md) |
| **Project** | The owning unit of surfaces — stamped from git root; agents are labels, not identities | [auth/project-ownership.md](auth/project-ownership.md) |
| **Device** | A paired, named, revocable remote display with restricted powers | [auth/device-pairing.md](auth/device-pairing.md), [auth/trust-model.md](auth/trust-model.md) |
| **Template** | Parameterized reusable surface — `ask`, `stream`, `video`, `board`, `doc`, custom | [templates/overview.md](templates/overview.md) |
| **State** | Per-surface JSON doc; `surface set` patches it; displays re-render live | [state/stateful-surfaces.md](state/stateful-surfaces.md) |
| **Action** | A user interaction flowing back: click, form, answer | [interaction/actions-inbox.md](interaction/actions-inbox.md) |
| **Binding** | Pre-registered command/webhook Surface fires when an action arrives and no agent is listening | [interaction/bindings.md](interaction/bindings.md) |
| **Delivery ladder** | waiter → binding → Codex flowback → inbox: a click is never lost | [interaction/delivery-ladder.md](interaction/delivery-ladder.md) |
| **`.surface/`** | Surface definitions committed in the project; `surface sync` reconciles | [state/project-directory.md](state/project-directory.md) |

## The core loop

```
create:   agent ── surface link/create/ask ──► service ── SSE ──► all displays (<1s)
update:   agent ── surface set/touch/append ─► service ── patch ─► bound elements re-render
react:    user clicks ──► action ──► waiter (live session)
                                  └► binding (spawn/resume agent, e.g. claude -p --resume)
                                  └► Codex flowback (live turn or consented wake)
                                  └► inbox (badge; drained next session)
respond:  agent ── surface reply/set/update ──► user sees the result of their click
```

## Trust boundary (summary)

Two planes ([auth/trust-model.md](auth/trust-model.md)): **loopback = system** (agents; full power; the OS user account is the boundary — agents are attributed, not authenticated, because same-uid processes can't be distinguished) and **paired sessions = device** (displays; view/click only; nothing that touches the filesystem, executes code, or mints credentials). Surface is private to one user; remote auth exists to authenticate that user's own displays, never to share.

## Stack

Express 5, better-sqlite3, native `fetch`, vanilla-JS PWA, no client dependencies. Both entrypoints ship as esbuild bundles (`dist/surface.mjs` for the CLI, `dist/server.mjs` for the server, built by `npm run build` via the `prepare` hook); `tsx` runs the server from source in development. Headless Chrome (optional) for card screenshots. Schema versioned via `PRAGMA user_version` (`server/migrations.ts`).

## Where the detail lives

This file is orientation only. [README.md](README.md) indexes the full tree: `core/` (the engine), `auth/`, `interaction/`, `state/`, `templates/`, `display/`, `operations/`, and [roadmap.md](roadmap.md) for the record of what was decided and why.
