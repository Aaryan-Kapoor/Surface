# Stateful Surfaces

**Status:** Approved — not yet built (Phase 2)
**Code (current):** none — rides the shipped SSE channel (`server/sse.ts`)

Stateful surfaces split a surface into **template + data** so agents stop regenerating HTML to change a number. Today, updating a progress bar means rewriting the file and calling `touch`. With state, it's one line from anywhere in a script:

```bash
surface set build-status progress 0.42
surface set build-status tests.passed 132
surface patch build-status '{"stage":"deploy","eta_s":90}'
```

The surface re-renders the bound elements in place, live, on every display. This is the foundation that makes templates dynamic, the [board](../templates/board.md) possible, and live dashboards effectively free for agents.

## Model

- **One JSON state document per surface.** `surface patch` deep-merges; `surface set <id> <dotted.key> <value>` is sugar for a single-key patch (values auto-parsed as JSON, falling back to string).
- **Values live in Surface's DB, never in the repo.** A progress bar ticking 50 times a minute must not dirty a working tree or pollute git history. *Definitions* (which variables exist, defaults, types) belong in the project via [`.surface/` manifests](project-directory.md); *values* are runtime display state and live in SQLite.
- **Declared vs ad-hoc keys.** Variables declared in a manifest get type checking and defaults on `surface sync`; undeclared keys are allowed (schema-less by default) so quick hacks stay quick.

## Interface

| Layer | Surface |
|---|---|
| CLI | `surface set <id> <key> <value>`, `surface patch <id> <json\|->`, `surface state <id>` (read) |
| HTTP | `GET /artifacts/:id/state`, `PATCH /artifacts/:id/state` (system plane only for writes — see [../auth/trust-model.md](../auth/trust-model.md)) |
| SSE | `state_patch` event: `{ id, patch, state_version }`; full state is included when a viewer loads, so late joiners don't replay |
| Storage | `surface_state(artifact_id PK, state_json, state_version, updated_at)` — single row per surface, version bumped per patch |

## Rendering: `surface.js`

A tiny runtime auto-injected into artifact and template HTML (no build step, consistent with the vanilla-JS client):

```html
<span data-surface-bind="tests.passed">0</span>
<div data-surface-show="deploy.ready">…</div>     <!-- toggles visibility -->
<progress data-surface-bind="progress" max="1"></progress>
```

For custom rendering: `Surface.state` (current snapshot) and `Surface.onState(patch => …)`. The same runtime provides `Surface.action(name, data)` — a wrapper over the existing postMessage bridge — so templates emit [actions](../interaction/actions-inbox.md) without boilerplate.

Templates declare their bindings in markup, so an agent that writes zero JavaScript still gets live UI.

## Example: build dashboard from a script

```bash
surface create "Build" --id build --template stream &
surface set build stage "compiling"
make 2>&1 | surface append build -
surface set build stage "testing"
npm test && surface set build result pass || surface set build result fail
```

## Rejected alternative: state values in the repo

Considered (`.surface/state.json` as the live store) and rejected: high-frequency runtime values in git mean a permanently dirty tree and meaningless history. The accepted split — **definitions in git, values in the DB** — keeps the project the owner of *what its surfaces are* without making it record *what they currently say*. See [project-directory.md](project-directory.md).

## Related

- [project-directory.md](project-directory.md) — declaring state vars in `.surface/` manifests
- [../templates/overview.md](../templates/overview.md) — templates consume state
- [../core/events.md](../core/events.md) — the SSE channel `state_patch` rides on
