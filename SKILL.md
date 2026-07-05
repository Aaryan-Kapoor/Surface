---
name: surface
description: Surface-native display for AI agents, driven by the `surface` CLI. Use when the user says "surface this", "show me X", or "put it on my display/screen"; wants a live interactive UI, chart, or tool they act on; needs a question answerable from any device; or asks you to react to what they click — even while you're offline.
---

# Surface

Surface is the user's universal display. When the user says "surface this", "show me X", "put Y on my display", or "ask me when it's done", drive the `surface` CLI — a thin client over a local service (`127.0.0.1:3000`). Hot paths get verbs; everything else, including every custom template, goes through `create --template`. The table below tells you *when*; `surface <cmd> --help` is authoritative for flags.

## Surface-native

A live display the user *acts on*, not a chat transcript or file viewer — **two-way and current**: the user answers, clicks, or watches a value change, and you react. **Pick by shape before writing HTML** — match the source to its verb: markdown → `doc --toc`, video/URL → `video`, PDF/image → `present`, a file you keep editing → `link`, a yes/no or pick-one → `ask --options`, a scrolling log → `create --template stream`. **Decompose a multi-source request first** — a "presenter view", a "home screen", "a card next to it" is *several* surfaces (one verb each: `present` the PDF, `video` the clip, a bound chart…), composed with `slot`, never one HTML blob with tabs. Hand-build interactive HTML (`create --content -` — charts, maps, tools, anything in the shape of the bundled demo gallery — `surface seed-demos` to see it) **only when no verb fits**; rendering markdown as HTML or faking a decision card with buttons is the classic miss — the verb is shorter, hot-reloads, and renders natively everywhere. Dynamism earns its place when it adds a decision, a live value, or a visual relationship text can't carry — never less interactive than the task wants, never more.

## Session start

1. `surface actions` — drain your inbox: clicks that arrived while you were gone. Handle each, then `surface ack <id>`.
2. Read `SURFACE.md` if present — which surfaces this project maintains, which state keys to update when.
3. `surface list` — never create a duplicate; update the existing card.
4. Re-arm your action terminal for any interactive surfaces you own (see the delivery ladder). Terminals die with the session; the surfaces don't.

## Commands

| Verb | When to use |
|---|---|
| `create <title>` | Build a surface: ad-hoc HTML (`--content -`) or a template (`--template <name>`). The default *only* for a custom interactive/visual shape — otherwise pick a verb above. |
| `ask <question>` | Ask the user — `--options a,b` pick-one, `--freetext` typed answer, `--wait` blocks; `--on <device>` targets one screen (else everywhere). Attach context, don't ask blind. |
| `append <id>` | Append to a running `stream` surface (pipe with `-`). |
| `video` · `doc` · `present` | YouTube/web video · repo markdown (`--toc`, hot-reloads) · one-shot snapshot of a **local** PDF/image (web PDF → `/proxy/pdf`). |
| `link <abs-path>` | Serve a project file live from disk; `touch <id>` after each edit — your hot-reload target. |
| `set` · `patch` · `state` | Live state — change a value without rewriting HTML (see the two-way loop). |
| `list` · `read` · `update` · `versions` · `rollback` · `delete` | Artifact lifecycle. `update` revises a card; `rollback <ver>` restores an earlier version (don't re-type old values); `delete` removes one. |
| `template list/show/create` | Inspect templates; promote a UI you've built twice (`create <name> --from <id>`). |
| `wait` · `actions` · `ack` · `bind` · `bindings` · `unbind` | React to clicks — see the delivery ladder. `wait --id <id> --event state_patch` (or `stream_append`) wakes you on a peer's post — don't poll. |
| `reply` · `notify` · `open` · `exec` · `theme` | Talk back / drive the display. `theme` sets the **global** look — colors, background, fonts, raw CSS (not per-surface styling); `notify`/`open` take `--on <device>`; `exec` pokes live JS into a surface. |
| `set board <agent> '{...}'` | Shared fleet dashboard at id `board`; key by your `--agent` (`'{"status":…,"project":…}'`). Render dashboards **bound to board's keys** (`data-surface-bind`), don't invent a registry; post when you start/finish/block. |
| `slot renderer/home/overlay` | `renderer` = whole homescreen launcher (gets injected `window.__surfaces`/`navigate(id)`); `home` = widget; `overlay` = floating layer (e.g. a DND pill). The user's space — only when asked. |
| `status` · `stream` · `devices` | Presence (who's connected/awake — check before `--on`); tail every event; paired screens. |
| `init` · `sync` | Scaffold `.surface/` + `SURFACE.md`; reconcile project manifests across machines. |
| `pair` · `auth` | Pair a new screen; mint/revoke remote `SURFACE_SESSION` bearers. |
| `seed-demos` · `clear-demos` | Built-in demo gallery — the fast "show me what Surface can do" tour; `clear-demos` hides it again (don't `delete` them one by one; `seed-demos` revives). |

## The two-way loop

A surface that only renders is half-built: **state flows out, actions flow back.** Never regenerate HTML to change a value — every surface has a JSON state doc. `surface set <id> <key> <value>` writes one key (dotted keys ok); **`surface patch <id> '{...}'` writes many at once** (deep-merge; pipe JSON with `-`) — prefer it over a chain of `set`s. State flows out bound in markup with `data-surface-bind` / `data-surface-show`, re-rendered live on every screen, and **persists across sessions** (`surface state <id>` reads it back — don't blindly re-seed values that are already there). Actions flow back with `Surface.action("name", {...})`. For a multi-step interaction, keep intermediate clicks local with `Surface.stage(key, value)` and fire one action at the commit with `Surface.commit("name")` — so you wake **once, on the user's actual intent**, not per click.

## Delivery ladder — reacting to clicks

Each action wakes you. **Default: arm a live action terminal** (`surface wait --follow`) the moment you put up an interactive surface — **once**, and keep it running for the whole interaction. It drains the pending inbox on connect, shows "agent listening", prints one JSON line per action, and **auto-acks each action it hands you** (`--no-ack` to keep them pending) — so only the `actions` inbox-drain needs a manual `ack`.

- **Claude Code:** arm it with the **`Monitor` tool** (`persistent: true`), not a backgrounded shell. For anything two-way or ongoing, Monitor is the rule: a one-shot shell only wakes when its process *exits*, so it catches the first action and sleeps through the rest, leaving the surface unguarded. A backgrounded one-shot `surface wait --id <id>` is fine *only* for a single fire-and-forget answer.
- **Other harnesses:** per-line watchdog → `--follow`; wake-on-exit only → one-shot `wait`, re-arm after each; always-on daemon → a `--webhook` binding. Recipes: `surface wait --help`, and `docs/interaction/delivery-ladder.md` in the Surface repo.
- **The terminal dies with your session — re-arm on return** (the inbox drain covers everything clicked while you were gone).
- **Offline (clicks land while you're gone)?** `surface bind <id> --action <name> --run '<cmd>'`/`--webhook` is the answer — fires when no waiter is connected; never hand-roll a server, daemon, or systemd unit for this. **A bind runs `<cmd>` (or wakes a headless session) on the user's machine and quota while they're away with no one in the loop — so a recorded yes is a hard prerequisite, and the user wanting the feature is not that yes.** Before your first bind in a project, read `.surface/config.json → bindings.enabled`; if it isn't already `true`, **stop and ask the user in chat** ("wake me on clicks? each wake runs `<cmd>` unattended / spends a headless session") and wait for their reply — **never set `enabled: true` yourself to unblock your task**: the request that created this work (even an urgent "make it fire while I'm away") is *not* that yes; only a separate, explicit user confirmation is. Record *their* answer there, then bind only once it's `true`. To revoke: `unbind <binding-id>` and set `enabled` back to `false`.
- Unhandled clicks always wait in the inbox — nothing is lost.

## Conventions

- Surfaces are **self-contained** — inline CSS/JS, no CDNs — so they render offline and screenshot headlessly.
- Most sites block iframes — use embed URLs (`open.spotify.com/embed/...`), or `/proxy/pdf?url=ENCODED` for web PDFs.
- Pass `--agent <your-harness>` for attribution and `--id <slug>` for recurring cards.
- Remote/non-loopback callers — CI, scripts, another box, **not just agents** — point `SURFACE_URL` at the reachable host and set `SURFACE_SESSION`, then run the same CLI (`surface set`, `notify`); mint/audit/revoke the bearer with `auth session issue --role system --label <where>` · `list` · `revoke`. `surface --help` / `surface <cmd> --help` are authoritative.
