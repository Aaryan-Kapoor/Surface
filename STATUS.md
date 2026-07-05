# Surface Status

Surface is artifact-first and CLI-driven. The current implementation is organized around a local Express service, SQLite persistence, a vanilla JS PWA, and the bundled `surface` CLI.

## Current Capabilities

- Artifacts are the only display content model: generated, presented, linked, templated, versioned, rolled back, and soft-deleted.
- The PWA renders artifact cards, live previews, display slots, device presence, themes, and sandboxed artifact iframes.
- `surface.js` provides state bindings, stream bindings, and `Surface.action()` for user-to-agent actions.
- The delivery ladder routes actions through live waiters, consent-gated bindings, then the durable inbox.
- Auth is two-plane: loopback/system sessions for agents, paired device sessions for displays.
- Content is served through a dedicated content origin when configured, with Host/Origin validation on the app plane.
- Built-in templates include ask, stream, video, board, and doc. The report
  template was deliberately removed (2026-07-05, owner decision — do not
  re-add); long-form output goes through `surface doc <file>.md --toc`.

## Verification

The standard local gate is:

```bash
npx tsc --noEmit
npm test
npm audit --audit-level=high
bash scripts/check-leaks.sh
```

`npm test` builds the CLI and runs the isolated regression suites. The OpenRouter e2e loop is opt-in with `SURFACE_TEST_E2E=1` and is skipped by default to avoid touching a live service or requiring credentials.

## Operational Notes

- Data lives in `~/.surface/` unless `SURFACE_DATA_DIR` is set.
- The service is intended to run once as a systemd user service bound to `127.0.0.1`.
- Pre-baseline SQLite databases are archived to `db.sqlite.bak` at boot and are not row-migrated.
- Linked artifacts remain sourced from disk; edit the file and run `surface touch <id>`.
- The archived MCP adapter is not installed by default.

## Source of Truth

- `SKILL.md` is the agent-facing command contract. It is the benchmark-winning
  E5 skill from `surface-skill-bench` (61 lines; kept byte-identical with
  `surface-skill-bench/versions/E5/SKILL.md` and `OPTIMIZED-SKILL.md` — edit
  one, sync all three). Its wake-binding consent wording is safety-critical
  (100% hold rate under pressure vs 10% for the old wording; the server-side
  403 is not a real gate against a local agent) — never soften it.
- `docs/README.md` links the maintained feature docs.
- `SECURITY.md` describes the trust model and remote access boundaries.
- `USECASES.md` lists current product patterns.
