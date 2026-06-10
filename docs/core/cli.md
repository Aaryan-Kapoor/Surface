# CLI Reference

**Status:** Shipped (2026-06)
**Code:** `bin/surface.ts` (bundled to `dist/surface.mjs`)

`surface` is the single command-line entry point agents use to drive the display. It is a thin client over the [HTTP API](http-api.md): each subcommand maps to one or more HTTP calls against `SURFACE_URL`. Run `surface --help` for the command list and `surface <command> --help` for per-command usage.

## Install / build

The CLI ships as a single bundled file: `npm run build:cli` runs esbuild over `bin/surface.ts` and writes `dist/surface.mjs`; the npm `bin` entry points at it, and the `prepare` hook builds it automatically on `npm install` / `npm link`. The bundle runs with plain `node` — no repo toolchain needed on the machine that invokes it. `npm run cli` still runs straight from source via `tsx`.

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `SURFACE_URL` | `http://127.0.0.1:3000` | Base URL; trailing slash stripped. |
| `SURFACE_SESSION` | _(empty)_ | Session bearer, sent as `Authorization: Bearer <token>`. Needed for non-loopback access; mint one with `surface auth session issue --role system --label <name>`. |

(`SURFACE_TOKEN` is gone — see [../auth/trust-model.md](../auth/trust-model.md). A set variable is ignored; the server logs a warning.)

## Exit codes
- `0` — success (and the matched-action exit of `wait` / answered exit of `ask --wait`).
- `1` — runtime/HTTP error; prints `{"error": ..., "status": ...}` to stderr (`fail`).
- `2` — usage error (missing/invalid arguments; `usage`).
- `3` — `wait --timeout` / `ask --wait --timeout` elapsed with no match.

## Conventions
- Output: strings print raw, everything else as pretty JSON (`out`).
- **stdin** (`-`): `--content -`, `--js -`, `--context -`, `--param k=-`, `append <id> -`, `patch <id> -`, and the `theme -` positional read from stdin (`readStdin`).
- `--metadata` takes a JSON string (`parseMetadata`).
- Durations (`--ttl`) accept `90s`, `5m`, `1h`, `30d`, or a bare number of seconds (`parseDurationSeconds`).
- Boolean flags that take no value: `--help`, `--json`, `--no-ack`, `--no-open`, `--no-qr`, `--include-hidden`, `--freetext`, `--wait`, `--md`, `--toc`, `--autoplay`, `--loop`, `--user`, `--clear` (`BOOLEAN_FLAGS`).
- `--param k=v` may repeat; one value may be `-` to read stdin.
- Every create path (`create`, `link`, `present`, the sugar verbs) stamps `project_root` from the caller's git root (`resolveProjectRoot`) and accepts `--agent <label>` for self-reported attribution (`metadata.agent`).

## Artifact lifecycle

```bash
surface list [--project <root>] [--agent <label>] [--include-hidden]   # GET /artifacts (cards)
surface read <id>                              # GET /artifacts/:id (artifact+version+files)
surface create <title> [--mime t] [--file p|--content s|--content -] [--template <name> --param k=v ...] [--id id] [--agent l] [--metadata json]
surface update <id>  [--title t] [--mime t] [--file p|--content s|--content -] [--metadata json]
surface present <abs-path> [--title t] [--agent l] [--metadata json]   # one-shot copy of a file
surface versions <id>                          # GET /artifacts/:id/versions
surface rollback <id> <version>                # repoint current version (int or version-id)
surface delete <id>                            # DELETE /artifacts/:id (soft delete)
```

- `create`/`update` send `content` (with optional `path`/`mime`) to `POST`/`PUT /artifacts`. With no `--mime`, the server infers it from the path/extension. With `--template`, the server instantiates the template instead (see [../templates/overview.md](../templates/overview.md)).
- `present` resolves the path to absolute and posts to `/artifacts/present-file`; the file is copied into the workspace as a `presented_file` artifact.
- `read` hits the artifact endpoint; `list` returns full surface cards (including `pending_actions` and `listening`), filterable by project root and agent label.

## Linked artifacts

```bash
surface link <abs-path> [--entry relpath] [--title t] [--agent l] [--metadata json] [--no-open]
surface touch <id>                             # broadcast hot-reload after editing on disk
```

`link` resolves the path to absolute, defaults `--title` to the basename, and requires `--entry` when linking a directory (enforced server-side). `--no-open` suppresses the auto-navigate. See [linked-artifacts.md](linked-artifacts.md).

## Surface state

```bash
surface set <id> <dotted.key> <value>          # one-key patch; value parsed as JSON, falls back to string; null deletes
surface patch <id> <json|->                    # deep-merge a JSON patch
surface state <id>                             # read state + state_version
```

`set` builds a nested single-key patch from the dotted path and PATCHes `/artifacts/:id/state`. See [../state/stateful-surfaces.md](../state/stateful-surfaces.md).

## Templates & sugar verbs

```bash
surface ask <question> [--options a,b,c] [--freetext] [--context -|<md>] [--context-file p] [--wait] [--timeout s] [--on <device>] [--id id] [--agent l] [--title t]
surface append <id> [<text>|-] [--md]          # append to a stream surface; - pipes stdin line by line (batched)
surface video <url> [--title t] [--start s] [--autoplay] [--loop] [--id id] [--agent l]
surface doc <path> [--title t] [--toc] [--width narrow|default|wide] [--agent l] [--no-open]
surface template list [--json]
surface template show <name>
surface template create <name> --from <artifact-id> [--user]
```

- `ask --wait` blocks until the answer action arrives and prints `{choice, text, answered_at, device, surface_id}`; on `--timeout` it expires the card (state flips to `expired`) and exits 3. See [../templates/ask.md](../templates/ask.md).
- `append -` streams stdin line by line, batching lines (50 per request / 300 ms flush) so a chatty build log doesn't become one HTTP request per line.
- `video` rejects non-`http(s)` arguments with a pointer to `surface present` for local files.
- `doc` is `surface link` wrapped in the `doc` template.
- `template create --from` promotes an existing surface's HTML into a template scaffold under `<project>/.surface/templates/<name>/` (or `~/.surface/templates/` with `--user`); the agent then edits `template.json` and the `{{param}}` slots. See [../templates/authoring.md](../templates/authoring.md).

## Display control

```bash
surface open [<id>] [--on <device>]            # navigate display(s) to artifact, or grid if omitted
surface exec <id> [--js code|--file path|--js -]   # eval JS inside the surface iframe
surface reply <id> <text...>                   # toast scoped to one surface
surface notify <text...> [--style info|success|warning|error] [--duration ms] [--on <device>]
surface theme [<json>|-|reset]                 # get (no arg) / set (json or -) / reset display theme
surface slot [<renderer|home|overlay> <id>|--clear]   # show or assign display slots
surface status                                 # GET /display/status (per-device presence)
```

`exec` requires one of `--js`/`--file`/`--js -`. `theme` with no positional GETs the config, `reset` resets it, otherwise the positional (or stdin via `-`) is parsed as JSON and PUT. `slot` flips `metadata.display_role` on the named artifact (see [../display/theming.md](../display/theming.md)); `--on` targets a single device by label prefix (see [../display/devices.md](../display/devices.md)).

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

- `stream` connects to `/stream` (or `/artifacts/:id/stream`) and writes one `{event,data}` JSON line per SSE event, reconnecting with exponential backoff on drops (it only gives up on 401/403/404).
- `wait` blocks until a matching event, prints the action, and exits `0`. Defaults to `--event surface_action`; filters by `--id`/`--action`; first drains the pending-actions endpoint (oldest first), then listens on the **global** stream (per-surface streams don't carry `surface_action`), re-polling after each reconnect. The connection registers as a layer-1 **waiter** (`/stream?wait_for=<id|*>`), which suppresses bindings while it lives. Matching actions are auto-acked unless `--no-ack`. `--timeout` exits `3` on expiry. See [../interaction/delivery-ladder.md](../interaction/delivery-ladder.md).

## Bindings (delivery-ladder layer 2)

```bash
surface bind <id> [--action <name|a|b|*>] (--run '<command>' | --webhook <url>) [--cwd dir] [--timeout s]
surface bindings [<id>] [--json]               # list (pattern, kind, enabled, last run/status)
surface unbind <binding-id>
```

The command is argv-tokenized, never shelled; the action batch arrives on stdin as JSON. See [../interaction/bindings.md](../interaction/bindings.md).

## Project directory

```bash
surface init                                   # scaffold .surface/{config.json,surfaces/,templates/} + SURFACE.md
surface sync                                   # reconcile .surface/surfaces/*.json manifests with the service
surface sync --export <id>                     # write a manifest for an existing surface
```

See [../state/project-directory.md](../state/project-directory.md).

## Auth, pairing & devices

```bash
surface pair [--name <device-name>] [--base-url url] [--hosted-url url] [--ttl 5m] [--json] [--no-qr]
surface devices                                # list paired displays (label, last seen, viewing, IP)
surface devices revoke <name-or-id>            # kill a device session (unambiguous label prefix ok)
surface auth pairing create [--ttl 5m] [--label l] [--base-url url]
surface auth pairing list
surface auth pairing revoke <id>
surface auth session issue [--role system|device] [--ttl 30d] [--label l]
surface auth session list
surface auth session revoke <id>
```

`pair` mints a one-time pairing token and prints a human-friendly link plus a terminal QR code (suppress with `--no-qr`, or `--json` for raw output; `printPairingLink`). `--name` becomes the device label. `--hosted-url` wraps the link through a hosted relay. `auth` is the scriptable equivalent over `/api/auth/*`; `auth session issue --role system` is how a remote agent gets its `SURFACE_SESSION` bearer. See [../auth/device-pairing.md](../auth/device-pairing.md).

## Demos (maintenance)

```bash
surface seed-demos                             # link every examples/demos/*.html as a demo surface (idempotent)
surface clear-demos                            # soft-hide (metadata.hidden=true) every metadata.demo===true surface
```

`seed-demos` links each bundled demo (titles from `DEMO_TITLES`), reviving previously hidden ones instead of duplicating. `clear-demos` flips `metadata.hidden` rather than deleting, so demos can be re-seeded.

## Related
- [http-api.md](http-api.md) — the endpoints each command calls
- [events.md](events.md) — what `stream`/`wait` consume
- [linked-artifacts.md](linked-artifacts.md) — `link`/`touch`
- [../templates/overview.md](../templates/overview.md) — templates and the sugar verbs
- [../auth/device-pairing.md](../auth/device-pairing.md) — `pair`/`devices`/`auth`
- [../interaction/actions-inbox.md](../interaction/actions-inbox.md) — `actions`/`ack`
