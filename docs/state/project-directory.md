# The Project Directory: `.surface/` and `SURFACE.md`

**Status:** Approved — not yet built (Phase 2)
**Code (current):** none

Surfaces are [owned by projects](../auth/project-ownership.md), and the project should therefore *contain* its surfaces: their definitions live in a `.surface/` directory committed to the repo, reviewable in PRs, reconstituted on any machine by `surface sync`. This is infrastructure-as-code for UI. Live state **values** stay out of the repo (see [stateful-surfaces.md](stateful-surfaces.md)) — only definitions are versioned.

## Layout

```
myapp/
  .surface/
    config.json          # project-level settings
    surfaces/
      build-status.json  # one manifest per surface
      deploy-panel.json
    templates/
      release-card/      # project-local templates (see ../templates/overview.md)
  SURFACE.md             # display-layer context for agents
```

## Manifests

One JSON file per surface — id, title, template, params, declared state variables, bindings:

```json
{
  "id": "deploy-panel",
  "title": "Deploy panel",
  "template": "ask",
  "params": { "question": "Ship to prod?" },
  "state": {
    "schema": { "stage": "string", "progress": "number" },
    "defaults": { "stage": "idle", "progress": 0 }
  },
  "bindings": [
    { "action": "approve|hold", "run": "claude --resume {session} -p \"Handle the Surface action batch on stdin.\"" }
  ]
}
```

## Commands

- **`surface init`** — scaffolds `.surface/` and a starter `SURFACE.md` in the current project.
- **`surface sync`** — idempotent reconcile of manifests against the running service: creates missing surfaces, updates drifted definitions (title, template, params, declared state schema/defaults, bindings). **Never touches live state values or version history.** Fresh clone + `surface sync` = the project's surfaces exist again.

Surfaces created ad-hoc via `surface create` are *not* required to have manifests; `.surface/` is for the surfaces a project considers part of itself. `surface sync --export <id>` promotes an ad-hoc surface to a manifest.

## `SURFACE.md`

The CLAUDE.md of the display layer: a human/agent-readable note covering what surfaces this project maintains, what each is for, which state variables to update when, and any conventions ("the deploy panel is sacred, don't delete it"). SKILL.md instructs agents to read `SURFACE.md` (when present) at session start, alongside draining `surface actions`.

`surface init` scaffolds it with the manifest list and TODO prompts; agents keep it current the way they keep CLAUDE.md current.

## Git hygiene

- `.surface/` and `SURFACE.md` are **meant to be committed** — that's the point.
- Nothing under `.surface/` is written at runtime by the service; only the CLI (`init`, `sync --export`) and agents edit it. The service never holds a write path into the user's repos beyond what linked artifacts already serve read-only.
- Secrets never belong in manifests (bindings reference commands, not credentials).

## Related

- [../auth/project-ownership.md](../auth/project-ownership.md) — why the project is the owning unit
- [stateful-surfaces.md](stateful-surfaces.md) — the definition/value split
- [../interaction/bindings.md](../interaction/bindings.md) — binding entries in manifests
- [../templates/authoring.md](../templates/authoring.md) — project-local templates
