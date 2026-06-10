# `board` — The Multi-Agent Status Board

**Status:** Shipped (2026-06)
**Code:** `templates/board/`, board materialization + section timestamping in `server/routes/artifacts.ts` (`PATCH /artifacts/board/state`)

The board makes Surface itself a **multi-agent dashboard**: one surface where every agent on the system posts its current status into its own section, and the user watches their whole agent fleet at a glance — ambient on the desk monitor, glanceable on the phone. It is human-visible multi-agent coordination, and it requires **no new backend primitive**: the board is just a template + [namespaced state](../state/stateful-surfaces.md) + [agent attribution](../auth/project-ownership.md). That it falls out of three already-justified pieces is the architecture working as intended.

## Usage

A default global board exists with the stable id `board` (created on first write). Agents update their own section via state:

```bash
surface set board claude-code '{"status":"PR #42 green, reviewing feedback","project":"myapp","link":"build-status"}' --agent claude-code
surface set board codex '{"status":"migrating test fixtures","project":"webapp"}' --agent codex
surface set board openclaw '{"status":"inbox triaged · 2 flagged","detail":"see daily-digest"}' --agent openclaw
```

Projects can run their own: `surface create "myapp board" --id myapp-board --template board`.

## Rendering

- **One section per agent label** (the state's top-level keys): label, status line, optional detail, optional `link` to one of that agent's surfaces, the owning project, and a relative timestamp.
- **Staleness dims**: a section that hasn't updated in N minutes (param, default 30) fades, so dead agents read as dead at a glance.
- Sections sort by recency; an empty board explains how to post to it.

## Ambient mode

The board is the natural tenant of a wall-mounted or spare display:

```bash
surface open board --on monitor      # park the desk monitor on the fleet view
```

See [../display/devices.md](../display/devices.md) for targeting.

## Template contract

- **Params:** `title` (string), `stale_after_min` (number, default 30).
- **State:** one object per agent label: `{ status, detail?, project?, link? }` (+ server-stamped `updated_at` per section).
- **Actions:** `open_section` (tapping a section navigates to its `link`, when set).

## Conventions (SKILL.md)

- Update your section when starting, finishing, or getting blocked on significant work — not per keystroke.
- Key by your harness name (same label you pass to `--agent`).
- Link your section to your most relevant live surface so a tap leads somewhere useful.

## Related

- [../state/stateful-surfaces.md](../state/stateful-surfaces.md) — the state mechanism underneath
- [../auth/project-ownership.md](../auth/project-ownership.md) — agent labels
- [../display/devices.md](../display/devices.md) — parking the board on a device
