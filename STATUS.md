# Surface Status

Branch: `feature/artifact-architecture`

## The 2026-06 rebuild (phases 1–4 of `docs/roadmap.md`)

All four roadmap phases are implemented on this branch. Each feature has a spec under `docs/`; this is the one-screen summary.

### Phase 1 — Foundation
- **Fresh-start schema**: one baseline migration (artifact-first; no legacy `surfaces`/`surface_views`/`sandbox_sessions`), with `surface_state`, `surface_bindings`, and `surface_stream_chunks` created up front. A pre-baseline `~/.surface/db.sqlite` is archived to `db.sqlite.bak` at boot — not migrated.
- **Artifacts-only API**: `/surfaces/*` is gone; actions/reply/exec/stream live under `/artifacts/:id/…`; `GET /artifacts` returns full card payloads (one fetch renders the grid).
- **Two-plane trust model**: loopback = `system` (agents, full power); paired displays = `device` (view/click/workspace-CRUD/display control only). `SURFACE_TOKEN` removed; remote agents carry `SURFACE_SESSION` bearers minted via `surface auth session issue --role system`.
- **Project ownership**: every create/link/present stamps `project_root` from the caller's git root; `--agent` is self-reported attribution in `metadata.agent`.
- **Devices**: named at pair time, listed/revoked via `surface devices`, rolling session expiry, per-device presence, and `--on <device>` targeting for open/notify.
- Router split: `server/routes/{auth,artifacts,actions,display,integrations}.ts`.

### Phase 2 — State & Templates
- **Stateful surfaces**: one versioned JSON doc per surface (`surface set/patch/state`), `state_patch` SSE, and the injected `surface.js` runtime (`data-surface-bind`, `data-surface-show`, `Surface.action/onState/onEvent`).
- **Template engine**: project `.surface/templates` → `~/.surface/templates` → built-in; `{{param}}` escaped / `{{{param}}}` raw / markdown params server-rendered; `--template/--param`; re-render with the same id is an idempotent no-op when output is unchanged.
- **Built-ins**: `ask` (context-full questions; server flips answered state), `stream` (+ `surface append`, ANSI/markdown chunks, ring buffer), `video` (youtube-nocookie), `board` (global `board` id materializes on first write; per-section staleness), `doc` (linked repo markdown rendered with TOC + touch reload).
- **Project directory**: `surface init` scaffolds `.surface/` + `SURFACE.md` (incl. the `bindings.enabled` consent slot); `surface sync` reconciles manifests idempotently; `surface sync --export` promotes ad-hoc surfaces.

### Phase 3 — Delivery ladder
- **Layer 1**: `surface wait` drains oldest-pending first, registers as a live waiter (`/stream?wait_for=`), suppresses bindings, shows "agent listening" on the card.
- **Layer 2**: `surface bind --action … --run/--webhook` — argv-safe spawn (action batch as JSON on stdin, cwd = project root, logs under `~/.surface/logs/bindings/`), single-flight + coalescing, webhook retry, `binding_status` SSE (⟳ pill). Per-project kill switch in `.surface/config.json`.
- **Layer 3**: pending badges + live counts on cards; TTL sweep (handled 7d, pending 30d).
- SKILL.md rewritten around the ladder, harness recipes, and the ask-once-per-project wake-binding consent.

### Phase 4 — Polish
- Display slots (renderer/home/overlay) are **artifacts** (`metadata.display_role`, `surface slot`); raw config blobs removed.
- SSE keepalive heartbeat (20s) + reconnecting `surface stream`.
- Single-file CLI: `npm run build:cli` → `dist/surface.mjs` (built automatically by `prepare`; the npm `surface` bin points at it).
- Install state moved to `~/.surface/install-state.json` (no more by-design dirty `INSTALL_FOR_AGENTS.md`).
- `If-Match` preconditions on workspace `PUT` (412 on version mismatch); iframe `sandbox` attribute on surface frames; `@modelcontextprotocol/sdk` removed from default deps.

## Verified

- `npx tsc --noEmit` passes.
- `npm run test:artifacts` — artifacts, linking (incl. symlink-escape regression), state, templates (engine + built-ins), stream chunks, project filters.
- `npm run test:auth` — 35 checks: two-plane roles, pairing lifecycle, device capability split, device registry/revocation, session persistence across restarts.
- `npm run test:startup-access` — pairing URL/QR output helpers.
- Live smoke: binding spawn with stdin batch + coalescing; `surface sync` idempotency; slots end-to-end; single-file CLI against a running server.

## Notes

- The MCP adapter in `archived/` requires `npm install @modelcontextprotocol/sdk` to run; not maintained.
- `test/e2e.ts` (OpenRouter tool-calling loop) needs `OPENROUTER_API_KEY`; endpoints updated to the artifacts API.

---

# Direction (appended 2026-06-12) — handoff plan after the interaction-model research

The umbrella documents live locally in `planning/` (gitignored, this machine only): `planning/EXECUTION.md` (gated long-term plan: product phases 5–8, launch, content pipeline, community, review cadence) and `planning/MARKETING.md` (positioning, pillars, voice, channels). This section holds the research detail and immediate task queue they build on.

Everything below was decided/researched on 2026-06-12 and is the working plan. Commits that session: `30ab969` (SKILL.md full command coverage), `9b0de88` (`wait --follow`), `0026364` (per-harness recipes + re-arm ritual), `e97039f` (`wait --heartbeat`), plus the earlier `a80820c`/`8cce991` (UI revamp, README/banner).

## Strategic position (user-locked)

1. **The market moment.** "HTML is the new markdown" went mainstream May 2026 (Thariq Shihipar/Anthropic post, ~4.4M views in 16h; Karpathy endorsement days later; 274-comment HN thread; Gemini 3 generative UI, MCP Apps as first official MCP extension Jan 2026). The two frictions the ecosystem has NOT solved: (a) **delivery** of agent-generated HTML (`file://` hell, hand-rolled `python -m http.server`, no live reload — see anthropics/claude-code#27792), and (b) **the return channel** — static HTML gives the agent no way to learn what the user clicked or typed. Surface solves both. That is the pitch.
2. **The killer feature is the return channel**, and the PRIMARY interaction model is a persistent/armed action listener inside the agent's own harness session (`surface wait --follow` or one-shot loops) — **not** respawning exited agents. Bindings remain rung 2 (fire only when nothing is listening). User decision, do not re-litigate.
3. The command surface is curated by the **frequency rule**: hot paths get top-level verbs (`ask`, `video`, `doc`); everything else — including every custom template — goes through `create --template`. Minting a template never mints a command.

## Verified per-harness wake mechanics (research 2026-06-12, four subagents, primary sources, mostly confirmed-in-code)

**Universal law: process EXIT is the only wake that works everywhere. Per-line push on output exists in exactly one harness (Claude Code's Monitor tool). Therefore one-shot `surface wait` (exits with the action JSON) is the universal primitive; `--follow` is first-class on Claude Code, a passive bonus on Cline, and the wrong tool on Codex/Windsurf/Gemini.**

| Harness | Verified mechanics | Recipe to document |
|---|---|---|
| Claude Code | Monitor tool = true per-line push (`persistent: true`); Bash `run_in_background` = push on exit. Both verified live in-session (drain, auto-ack, listening persists). | `--follow` armed via Monitor; one-shot via `run_in_background` for single answers. |
| Codex CLI | Background terminals via `exec_command`/`write_stdin` (unified_exec, in Rust core). Empty-stdin `write_stdin` is a long-poll (5s–300s, `background_terminal_max_timeout`) that returns ~150ms after process EXIT but NEVER early on output. Terminals die with the session (`Drop` impl kills all); >10 min reliability shaky (openai/codex#10957); detached sessions don't exist (#3968 open). | One-shot `wait` in a background terminal + empty `write_stdin` long-polls; re-arm per action. Never `--follow`. |
| Gemini CLI | Foreground commands killed after **300s of silence** (`tools.shell.inactivityTimeout`, timer resets on any output). Background output is poll-only (`read_background_output {pid, delay_ms}`) by deliberate design (issue #14845). Push-on-exit exists but needs BOTH `tools.shell.backgroundCompletionBehavior: "inject"` AND `experimental.modelSteering: true` (default false). | Foreground one-shot `surface wait --heartbeat 60` (the heartbeat defeats the silence timer); document the two-setting combo as the async option. |
| Cline | The one harness where `--follow` works passively: unread stdout from running terminals is auto-injected into `environment_details` ("Actively Running Terminals → New Output") on every subsequent model turn. Default tool timeout 30s (300s for compile-like), background hard-kill at 10 min, nothing fires when the task is idle/completed. | Start `--follow` once (it survives the 30s timeout into background; actions surface next turn); one-shot ≤25s loops for blocking moments. |
| Cursor | Poll-only; the blocking tool return is the only wake. ~10-min foreground cap; background log wrapper format churns (changed 3× in two weeks Jan 2026 — never parse it). CLI/shell-mode caps at ~30s. | Foreground one-shot loop with `--timeout` under the cap; "exit 3 = no action yet, re-arm". |
| Windsurf / Devin Desktop | `command_status {CommandId, WaitDurationSeconds: 60}` is a real long-poll that early-returns on EXIT only (never on output). | Non-blocking one-shot (`Blocking:false`, `WaitMsBeforeAsync≈2000`) + `command_status` 60s loop. Avoid `--follow` (fixed 60s latency). |
| Copilot CLI | Background tasks exist (Ctrl+X→b) but completion notifications go to the USER; model is poll-only (`read_agent`). Experimental `/every`/`/after` scheduled prompts re-invoke the model on a cadence. | Blocking one-shot; or `--follow >> ~/.surface/events.jsonl` + an `/every` prompt that tails it. |
| Amp | Poll-only; official pattern is tmux (`capture-pane`); UI "Detach" exists; community toolbox `amp-bg-tasks` for bg polling. True push only from outside: shell out `amp -x '<prompt>'` per event. | Blocking one-shot in-session; tmux pane + capture-pane for follow; offline → binding `--run 'amp -x "…"'`. |
| Aider | Fully synchronous (`run_cmd.py`: pexpect/Popen + wait). No background, no push, ever. | `/run surface wait` one-shot, period. Continuous = external wrapper feeding aider's Python scripting API. |
| OpenClaw | Best non-Claude story. First-class webhook: `POST http://127.0.0.1:18789/hooks/wake`, `Authorization: Bearer <token>`, body `{"text":"<action JSON>","mode":"now"}` = immediate main-session wake (enable `hooks.enabled` + token; `hooks.mappings` can accept raw payloads; `/hooks/agent` for isolated runs). Backgrounded execs push on exit by default (`tools.exec.notifyOnExit: true`). Bg sessions are memory-only, lost on gateway restart (#16356). | Skip the terminal: register a `--webhook` binding at `/hooks/wake`. Fallback: backgrounded one-shot (notifyOnExit wakes on exit). |

Hazard numbers worth keeping exact: Gemini 300s silence kill; Cline 30s/300s tool timeouts + 10-min bg hard-kill; Cursor ~10-min fg cap; Codex 300s poll cap + session-death + ~10-min flakiness; OpenClaw bg lost on restart.

## Next task (ready to execute — was discussed and agreed in shape; ONE open decision)

1. Rewrite the rung-1 harness table in SKILL.md with the verified rows above (short "if you are X → arm with Y" lines; keep the generic decision rule for unlisted harnesses: per-line watchdog → `--follow`; long-poll/blocking → one-shot loop; neither → rungs 2–3).
2. Update the rung-2 bindings recipe table: OpenClaw row gets the verified `/hooks/wake` endpoint shape; add an Amp row (`--run 'amp -x "Handle the Surface action batch on stdin…"'`).
3. Mirror the corrections in `docs/interaction/delivery-ladder.md` (its current Codex claim — "surfaces background-process completion" — is wrong; Codex is long-poll-on-exit, not push).
4. Document `--heartbeat` in SKILL.md (Gemini row) — flag is implemented and committed (`e97039f`), prints `: waiting <ts>` to stderr every N seconds.
5. **OPEN DECISION (ask the user):** timeout exit semantics for loop-style harnesses. Today `wait --timeout` exits 3 with error JSON on stderr. Recommendation: keep exit 3 and document "exit 3 = nothing yet, re-arm" in the loop recipes. Alternative the user may prefer: an opt-in flag (e.g. `--idle-ok`) that exits 0 with `{"event":"timeout"}` on stdout so naive loops look clean. Do not change the default exit-3 contract silently (`ask --wait` shares it).

## After that: the HTML-over-markdown blend-in (direction approved, not yet implemented)

1. **SKILL.md "explanations & reports" section**: when the user asks for an explanation of something substantial, or a long task ends, push a self-contained HTML surface (`create --mime text/html`) instead of printing a markdown wall. Bake in the crystallized report conventions: sidebar TOC, collapsible sections, inline SVG diagrams, print-friendly, no CDNs, single file.
2. **Built-in `report` template** (`templates/report/`): carry the interactive machinery (TOC generation, collapsibles, sortable tables, severity-colored findings) so agents supply only content — this also answers the trend's main counterargument (HTML ≈ 4–8× the tokens of markdown; a template moves boilerplate out of generation). Design the contract before building: probably `params: {title}` + sections delivered as state keys or markdown params, in the monochrome design language.
3. **README**: one new "What it feels like" scenario (an explanation you can actually read — interactive explainer with diagrams instead of scrolling text) and a Why line citing the moment ("Karpathy: 'view the generated file in your browser' — Surface is what that tab should have been").
4. **SKILL recipe**: the two-way tuning-UI pattern — build a slider/knob surface, user fiddles, agent reads `surface state` back (no export buttons).
5. **Do NOT** add a `surface report`/`explain` verb yet (frequency rule: through `create --template report` until proven hot).

## Longer-horizon watch items (not this branch)

- **Second-origin content domain** for surface iframes: SECURITY.md documents the same-origin-by-design trust assumption; the HTML trend's security critique (model-generated JS) raises the eventual priority of this deferred work.
- **MCP Apps / MCP-UI bridge**: their intent-postMessage shape ≈ `Surface.action()`; a compatibility bridge would let MCP-host agents render onto Surface. Separate project.
- Codex detached sessions (openai/codex#3968) — if it ships, Codex listeners stop dying with the session; revisit the Codex recipe.
- Watch which template/command usage gets hot enough to earn verbs by the frequency rule.

## Working conventions (carry-overs that bite)

- Branch `feature/artifact-architecture`; **nothing pushed, no PR** — the user reviews the whole branch at the end. Single-line commit messages, never any AI attribution.
- `test/artifacts.ts` defaults to `SURFACE_URL=http://127.0.0.1:3000` = the user's LIVE display. Always pass an isolated `SURFACE_URL`; boot test servers with `PORT=<n> SURFACE_DATA_DIR=/tmp/...`; kill them via harness TaskStop or `/proc/<pid>/environ` scans (`2>/dev/null`) — never `pkill -f` with a pattern that matches the calling shell (exit 144).
- PWA design language: black void, white signal, circular portholes for content, square controls, ui-monospace metadata. Headless design review: snap chromium + CDP on :9222; screenshots only to a non-hidden `$HOME` dir.
