# Changelog

All notable changes to Surface are recorded here.

## Unreleased

- Replaced `SKILL.md` with the benchmark-optimized skill (61 lines, ⅓ the size):
  matches the old skill on shape/primitive choice and hardens the wake-binding
  consent gate (100% hold rate under pressure vs 10% for the old wording).
- Removed the `report` built-in template and its docs.
- Fixed `surface wait --id <id> --event state_patch|stream_append`: state events
  carry the surface id as `id`, so the `--id` filter never matched and the wait
  hung forever; non-action event payloads now pass through un-enveloped and
  undeduplicated.

## 0.1.0 - 2026-07-02

- Added CI, aggregate tests, and community templates.
- Hardened loopback trust, bindings consent, outbound proxying, and artifact
  file serving.
- Added the built CLI package entrypoint, release metadata, and install docs
  for agent-first Surface setup.
