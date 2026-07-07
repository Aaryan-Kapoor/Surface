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

## Releases

Releases are tagged from `master` as `vX.Y.Z` after CI passes.

Before cutting a release:

1. Move relevant `CHANGELOG.md` entries from `Unreleased` into a dated version
   section.
2. Confirm `package.json` has the same version.
3. Run the checks above on a clean checkout.
4. Create and push the tag, then publish a GitHub release using the changelog
   section as release notes.
5. Pushing the `vX.Y.Z` tag triggers the `publish` job in CI: after the full
   matrix (build, tests on Linux/macOS/Windows, service-install smoke on
   macOS/Windows, audit) passes, it publishes `surface-display` to npm with
   provenance. The job requires the tag to match `package.json` and the
   `NPM_TOKEN` repo secret to be set.

## Security

Do not weaken the two-plane trust model. Loopback/system, paired device, and
content-origin behavior are documented in `SECURITY.md` and
`docs/auth/trust-model.md`.
