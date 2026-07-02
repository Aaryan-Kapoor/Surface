# Contributing

Surface is a local-first display service for AI agents. Keep changes narrow,
tested, and explicit about trust boundaries.

## Development

```bash
npm ci
npm run dev
npm run cli -- --help
```

Use an isolated data directory when testing manually:

```bash
SURFACE_DATA_DIR="$(mktemp -d)" PORT=33000 SURFACE_CONTENT_PORT=33001 npm run dev
```

## Checks

Run these before opening a pull request:

```bash
npx tsc --noEmit
npm test
npm audit --audit-level=high
```

`test:e2e` is a paid OpenRouter smoke test and is skipped unless
`SURFACE_TEST_E2E=1` is set.

## Security

Do not weaken the two-plane trust model. Loopback/system, paired device, and
content-origin behavior are documented in `SECURITY.md` and
`docs/auth/trust-model.md`.
