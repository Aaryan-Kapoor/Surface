# Codex Flowback Bridge

**Status:** Shipped (2026-07)
**Code:** `server/codexBridge.ts` (bridge + ladder layer), `server/agentSessions.ts` (session capture), `bin/codex.ts` (`surface codex`), migration v12 (`agent_links`, `agent_sessions`)
**Tests:** `test/codexBridge.ts` (mock app-server daemon speaking the real wire protocol)

Claude Code gets realtime two-way flow from a background Monitor waiter. Codex
cannot hold one: its background terminals wake on process exit, not on output.
The bridge closes that gap from the *other* side — instead of the agent
listening for Surface, **Surface delivers actions into the codex conversation
itself**, using the codex app-server protocol. Clicks appear in the user's live
TUI as native turns; clicks on dead sessions revive the exact thread that
created the surface, and the exchange is in the transcript the next time the
user runs `codex resume`.

## How a surface knows its codex session

Nobody copies session ids. Codex exports `CODEX_THREAD_ID` to every shell it
runs, so when the agent calls `surface create` (or ask/doc/link/present/sync),
the CLI stamps `agent_session: { kind: "codex", session_id: … }` into the
create request and the server records it in `agent_links` (Claude Code's
`CLAUDE_CODE_SESSION_ID` is captured the same way for future use; the codex
variable wins when both are set because the innermost agent is the author).
Template re-renders re-stamp the link, so `surface sync` at session start
retargets flowback to the newest session. Only the system plane can set an
agent session — a paired device cannot point flowback at someone's session.

## One-time setup

```bash
surface codex setup
```

does three things:

1. **Starts the codex app-server daemon** (`codex app-server daemon start`,
   idempotent). Plain `codex` runs auto-attach to a running daemon — that is
   stock codex behavior, not a Surface patch — which is what makes live
   injection possible. No wrapper command, no `--remote` flags.
2. **Installs a `SessionStart` hook** (`surface codex hook` in
   `~/.codex/hooks.json`, merged non-destructively) that registers each
   session's `{ session_id, pid, cwd, transcript_path }` with the Surface
   service. Codex asks the user to trust the hook on its next start.
3. Prints the consent story (below).

`surface codex status` shows both halves: local (codex version, daemon socket,
hook) and service-side (bridge connectivity, delivery counters).

## The delivery ladder with the codex layer

Between explicit bindings and the inbox (`server/bindings.ts::dispatchAction`):

1. **Live waiter** — unchanged, still wins over everything.
2. **Explicit bindings** — unchanged, consent-gated; registering one is a
   deliberate user choice, so it outranks the automatic layer.
3. **Codex flowback** (`maybeDispatchCodex`), for surfaces with a codex link:
   - **Thread loaded in the daemon** (an attached TUI has it open, live):
     `turn/start` immediately with the action batch. Codex queues the turn
     natively if one is active. No consent needed — this is the
     waiter-equivalent: the session is attached and listening.
   - **Session open in a plain in-process TUI** (registered pid alive, thread
     *not* in the daemon): **held in the inbox.** Resuming the thread in the
     daemon while another process owns the rollout would fork/dual-write it.
     The hook's pid registry is what makes this case detectable.
   - **Session dead:** consent-gated headless wake — `thread/resume` (loads
     the rollout from disk; retried through the "no rollout found" flush
     race), then `turn/start`. Requires the same recorded per-project consent
     as wake bindings (`.surface/config.json → bindings.enabled: true`);
     without it the action stays in the inbox.
4. **Inbox** — unchanged, still catches everything else.

Delivery acks the batch (like a waiter delivery) once `turn/start` is
accepted — but if the handling turn ends `failed` (usage limit, server
error), the batch is un-acked back into the inbox: the agent demonstrably
never processed it, and the inbox is the durable truth. There is no
automatic redelivery — a failing turn must not become a spawn loop. Per
surface, one delivery is in flight at a time: clicks arriving while the
delivered turn runs coalesce into a single follow-up batch on
`turn/completed`. `codex_bridge_status` SSE events (`delivered_live`,
`delivered_wake`, `held_live_tui`, `held_no_consent`, `turn_failed`,
`failed`) narrate the layer to the PWA.

## Approvals: Surface never approves anything

The app-server broadcasts approval requests (`item/commandExecution/
requestApproval`, `item/fileChange/requestApproval`, …) to every connected
client; the first response wins. Bridge policy:

- Turns on threads that were already loaded (user attached): the bridge stays
  **silent** — the user's own TUI shows its native approval prompt.
- Turns the bridge itself started headlessly: **decline**, immediately. A
  dead-session wake runs inside the thread's sandbox with whatever was already
  allowed; it must never gain privileges unattended. The model sees the
  declined approval and adapts (verified live).

## Wire protocol notes (verified against codex 0.144.1)

- Transport: WebSocket over the daemon's unix control socket
  (`$CODEX_HOME/app-server-control/app-server-control.sock`). The client must
  disable `permessage-deflate` (tungstenite's `accept_async` drops the
  connection when the extension is offered).
- Handshake: `initialize` (with `capabilities.experimentalApi: true` for the
  v2 thread/turn API) → `initialized` notification. The server's version is
  parsed from `userAgent` and gated (`>= 0.144.0`), fail-closed to the inbox.
- `turn/start` on a busy thread is accepted and queued by codex itself;
  `turn/steer` exists but is deliberately unused — injecting into the middle
  of an unrelated reasoning chain is how you derail a session.
- A thread cannot be resumed before its first turn is flushed to disk
  ("no rollout found") — the bridge retries with backoff.

## Environment knobs

| Variable | Effect |
|---|---|
| `SURFACE_CODEX_DISABLE=1` | Kill switch: the layer becomes a no-op. |
| `SURFACE_CODEX_SOCKET` | Override the daemon socket path (tests use this). |
| `SURFACE_CODEX_BIN` | Codex binary (default `codex`). |
| `SURFACE_CODEX_AUTOSTART=0` | Never spawn `codex app-server daemon start`. |
| `CODEX_HOME` | Respected for the default socket + hooks.json location. |

## Sandbox and environment reality (verified live)

Daemon-attached sessions execute shell commands **inside the daemon process's
environment**, not the terminal's: per-terminal env vars (`SURFACE_URL`, PATH
tweaks) do not reach the agent's shells. Default setups are unaffected (global
`surface` on PATH, service on :3000); the wake-turn text spells out the
service URL for everything else.

A wake turn runs under the thread's saved sandbox. If that sandbox has
network access disabled, `surface` CLI calls from the woken agent are blocked
and the escalation approval is auto-declined by the bridge (fail-closed, by
design — verified live: the model adapts and reports honestly rather than
fabricating progress). For full flowback on sandboxed threads, enable
workspace network access in the codex config for surface projects.

## Failure modes, honestly

- Daemon not running and autostart disabled/failing → wake path fails →
  actions stay in the inbox (badge, drained at next session start). Nothing
  is lost; latency degrades from seconds to next-session.
- Hook not installed → plain-TUI liveness cannot be detected. Live-attached
  delivery still works (thread visibly loaded in the daemon); dead-session
  wakes still work; the one risky case (plain TUI alive, consent granted,
  wake resumes a rollout another process owns) is why setup installs the hook
  rather than treating it as optional garnish.
- Daemon restarts → the bridge reconnects lazily on the next delivery; no
  reconnect replay, no state to reconcile (the inbox is the durable truth).

## Related

- [delivery-ladder.md](delivery-ladder.md) — the ladder this layer slots into
- [bindings.md](bindings.md) — explicit layer-2 bindings (still available for codex via `codex exec resume`)
- [actions-inbox.md](actions-inbox.md) — the durable fallback
