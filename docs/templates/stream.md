# `stream` — Append-Only Live Surfaces

**Status:** Approved — not yet built (Phase 2)
**Code (current):** none

A `stream` surface is a live scrollback: agents append lines or markdown blocks and every display renders them as they arrive. It captures the most common shape of agent output — a stream — which static HTML serves worst. Build logs, long research narration, overnight job progress: watchable from the phone, from bed.

## Usage

```bash
surface create "Build log" --id build-log --template stream

# pipe a process (line-buffered)
make 2>&1 | surface append build-log -

# or append discrete entries
surface append build-log --md "### ✅ compile finished — 42s"
surface append build-log "warning: 3 deprecated calls"
```

## Behavior

- Each append becomes a **chunk** (`text` or `md`). Text chunks render monospace with basic ANSI color converted to HTML; `--md` chunks render as markdown (headers, code fences, links).
- The viewer autoscrolls, pauses when the user scrolls up (with a "↓ live" resume pill), and shows a chunk timestamp gutter.
- Storage: `surface_stream_chunks(artifact_id, seq, kind, content, created_at)`, capped as a ring buffer (default 2000 chunks per surface, configurable per surface) — old chunks drop, the surface never grows unbounded.
- Transport: `stream_append` SSE event `{ id, seq, chunk }`; viewers joining late fetch the current buffer, then follow.
- Streams compose with [state](../state/stateful-surfaces.md): the stream template reserves a `status` header band (`surface set build-log status "stage 2/5"`).

## Examples

**CI from the couch:**

```bash
surface create "Nightly" --id nightly --template stream
./nightly.sh 2>&1 | surface append nightly -
surface notify "Nightly finished" 
```

**Agent narration:** an agent running a long multi-step task appends a markdown line per step — the user glances at the wall monitor instead of asking "how's it going?".

## Related

- [../state/stateful-surfaces.md](../state/stateful-surfaces.md) — the status band
- [overview.md](overview.md) — template machinery
- [../core/events.md](../core/events.md) — SSE transport
