# Archived

This directory holds code that Surface no longer advertises or installs by default. It is kept for backwards compatibility and reference, not maintained.

## `mcp.ts` — MCP stdio adapter

The canonical agent interface is now the `surface` CLI plus `SKILL.md`. See `../SKILL.md` and `../docs/architecture.md`.

The MCP adapter is preserved here for users with existing MCP-based agent configurations. It still calls the same HTTP API, so functionality is intact, but it is not part of the supported agent contract.

To use the archived adapter:

```bash
# 1. Make sure the Surface service is running on 127.0.0.1:3000
# 2. Point your MCP client at archived/mcp.ts (see .mcp.example.json)
```

`.mcp.example.json` in this directory shows the config shape. Replace `/path/to/Surface` with your clone path.

The adapter does not have its own bin entry anymore. Invoke it directly via `npx tsx archived/mcp.ts`, or wire the absolute path into your MCP client config.

## Why archived?

- MCP requires per-agent registration; the CLI works in any shell.
- SKILL.md is a single discovery document; MCP requires schema parsing per client.
- Channel notifications from MCP duplicate what `surface stream` already provides.

## Restoring

If you want to revive the MCP adapter as a first-class path: move `mcp.ts` back to `server/`, re-add the bin entry (`"surface-mcp": "./server/mcp.ts"`) and `"mcp"` script in `package.json`, restore the include in `tsconfig.json`, and re-document it in `INSTALL_FOR_AGENTS.md`.
