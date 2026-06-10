# CLI Reference

**Status:** Shipped
**Code:** `bin/surface.ts`

`surface` is the single command-line entry point agents use to drive the display. It is a thin client over the [HTTP API](http-api.md): each subcommand maps to one or more HTTP calls against `SURFACE_URL`. Run `surface --help` for the command list and `surface <command> --help` for per-command usage.

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `SURFACE_URL` | `http://127.0.0.1:3000` | Base URL; trailing slash stripped (`bin/surface.ts:9`). |
| `SURFACE_TOKEN` | _(empty)_ | Sent as `Authorization: Bearer <token>` when set. Needed for non-loopback access (`bin/surface.ts:10,184`). |

## Exit codes
- `0` — success (and the matched-action exit of `wait`).
- `1` — runtime/HTTP error; prints `{"error": ..., "status": ...}` to stderr (`fail`, `bin/surface.ts:237-242`).
- `2` — usage error (missing/invalid arguments; `usage`, `bin/surface.ts:244-247`).
- `3` — `wait --timeout` elapsed with no match (`bin/surface.ts:619-622`).

## Conventions
- Output: strings print raw, everything else as pretty JSON (`out`, `bin/surface.ts:206-210`).
- **stdin** (`-`): `--content -`, `--js -`, and the `theme -` positional read from stdin (`readStdin`, `bin/surface.ts:142-149`).
- `--metadata` takes a JSON string (`parseMetadata`, `bin/surface.ts:172-179`).
- Durations (`--ttl`) accept `90s`, `5m`, `1h`, `30d`, or a bare number of seconds (`parseDurationSeconds`, `bin/surface.ts:162-170`).
- Boolean flags that take no value: `--help`, `--json`, `--no-ack`, `--no-open`, `--no-qr` (`bin/surface.ts:105`).

## Artifact lifecycle

```bash
surface list                                   # GET /surfaces (cards)
surface read <id>                              # GET /artifacts/:id (artifact+version+files)
surface create <title> [--mime t] [--file p|--content s|--content -] [--id id] [--metadata json]
surface update <id>  [--title t] [--mime t] [--file p|--content s|--content -] [--metadata json]
surface present <abs-path> [--title t] [--metadata json]   # one-shot copy of a file
surface versions <id>                          # GET /artifacts/:id/versions
surface rollback <id> <version>                # repoint current version (int or version-id)
surface delete <id>                            # DELETE /artifacts/:id (soft delete)
```

- `create`/`update` send `content` (with optional `path`/`mime`) to `POST`/`PUT /artifacts` (`bin/surface.ts:274-300`). With no `--mime`, the server infers it from the path/extension.
- `present` resolves the path to absolute and posts to `/artifacts/present-file`; the file is copied into the workspace as a `presented_file` artifact (`bin/surface.ts:325-334`).
- `read` hits the artifact endpoint; `list` returns surface cards (denormalized).

## Linked artifacts

```bash
surface link <abs-path> [--entry relpath] [--title t] [--metadata json] [--no-open]
surface touch <id>                             # broadcast hot-reload after editing on disk
```

`link` resolves the path to absolute, defaults `--title` to the basename, and requires `--entry` when linking a directory (enforced server-side). `--no-open` suppresses the auto-navigate. See [linked-artifacts.md](linked-artifacts.md).

## Display control

```bash
surface open [<id>]                            # navigate display to artifact, or grid if omitted
surface exec <id> [--js code|--file path|--js -]   # eval JS inside the surface iframe
surface reply <id> <text...>                   # toast scoped to one surface
surface notify <text...> [--style info|success|warning|error] [--duration ms]
surface theme [<json>|-|reset]                 # get (no arg) / set (json or -) / reset display theme
surface status                                 # GET /display/status (presence)
```

`exec` requires one of `--js`/`--file`/`--js -` (`bin/surface.ts:427-437`). `theme` with no positional GETs the config, `reset` resets it, otherwise the positional (or stdin via `-`) is parsed as JSON and PUT (`bin/surface.ts:471-490`).

## Actions inbox (surface → agent)

```bash
surface actions [<id>]                         # list pending actions (all, or one surface)
surface ack <action-id>                        # mark an action handled
```

See [../interaction/actions-inbox.md](../interaction/actions-inbox.md).

## Streaming & waiting

```bash
surface stream [--id <surface-id>]             # tail SSE as JSONL until interrupted
surface wait [--id <id>] [--action <name>] [--event <name>] [--timeout <seconds>] [--no-ack]
```

- `stream` connects to `/stream` (or `/surfaces/:id/stream`) and writes one `{event,data}` JSON line per SSE event (`bin/surface.ts:647-689`).
- `wait` blocks until a matching event, prints the action, and exits `0` (`bin/surface.ts:496-629`). Defaults to `--event surface_action`; filters by `--id`/`--action`; first polls the pending-actions endpoint, then listens on the **global** stream (per-surface streams don't carry `surface_action`), with reconnect/backoff. Matching actions are auto-acked unless `--no-ack`. `--timeout` exits `3` on expiry. See [../interaction/delivery-ladder.md](../interaction/delivery-ladder.md).

## Auth & pairing

```bash
surface pair [--base-url url] [--hosted-url url] [--ttl 5m] [--label l] [--json] [--no-qr]
surface auth pairing create [--ttl 5m] [--label l] [--base-url url]
surface auth pairing list
surface auth pairing revoke <id>
surface auth session issue [--ttl 30d] [--label l]
surface auth session list
surface auth session revoke <id>
```

`pair` mints a one-time pairing token and prints a human-friendly link plus a terminal QR code (suppress with `--no-qr`, or `--json` for raw output; `bin/surface.ts:631-645`, `printPairingLink` at `212-235`). `--hosted-url` wraps the link through a hosted relay. `auth` is the scriptable equivalent over `/api/auth/*` (`bin/surface.ts:691-742`). See [../auth/device-pairing.md](../auth/device-pairing.md).

## Demos (maintenance)

```bash
surface seed-demos                             # link every examples/demos/*.html as a demo surface (idempotent)
surface clear-demos                            # soft-hide (metadata.hidden=true) every metadata.demo===true surface
```

`seed-demos` links each bundled demo (titles from `DEMO_TITLES`, `bin/surface.ts:87-95`), reviving previously hidden ones instead of duplicating (`bin/surface.ts:357-400`). `clear-demos` flips `metadata.hidden` rather than deleting, so demos can be re-seeded (`bin/surface.ts:402-419`).

## Planned commands
Additional commands (and stateful-surface ergonomics) are tracked in [../roadmap.md](../roadmap.md).

## Related
- [http-api.md](http-api.md) — the endpoints each command calls
- [events.md](events.md) — what `stream`/`wait` consume
- [linked-artifacts.md](linked-artifacts.md) — `link`/`touch`
- [../auth/device-pairing.md](../auth/device-pairing.md) — `pair`/`auth`
- [../interaction/actions-inbox.md](../interaction/actions-inbox.md) — `actions`/`ack`
