# Surface Installation Guide for AI Agents

Read this entire file, then follow the steps. Target: connect agents to a single long-running local Surface service through MCP.

Surface should run like local infrastructure. Agents should not start their own private Surface instance unless the user explicitly asks for a temporary development run.

## Step 0: Read The Repo Protocol

Read `AGENTS.md` at the repo root first. It describes the artifact-first architecture, MCP tool contract, and local conventions.

Companion files:

- `README.md` - user-facing setup and API overview
- `docs/architecture.md` - current architecture details
- `STATUS.md` - compact implementation status

## Step 1: Check For An Existing Surface Service

Before installing anything, check whether Surface is already running.

```bash
curl -fsS http://localhost:3000/surfaces >/dev/null && echo "Surface HTTP service is running"
```

Then check for a systemd user service:

```bash
systemctl --user status surface.service --no-pager
```

If Surface is already running and points to the expected repo/version, do not create another service. Continue to MCP registration.

If Surface is not running, ask the user before installing a service:

> I do not see a running Surface service. Do you want me to install and start a systemd user service for this repo?

Only continue with service setup after the user approves.

## Step 2: Clone And Install

```bash
git clone https://github.com/Aaryan-Kapoor/Surface.git
cd Surface
npm install
```

If the user wants a specific branch:

```bash
git checkout feature/artifact-architecture
npm install
```

## Step 3: Configure Environment

Create `.env` only if the user wants OpenRouter chat proxying or OpenClaw fan-out. Never commit `.env`.

```text
OPENROUTER_API_KEY=...
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_HOOKS_TOKEN=...
SURFACE_WORKSPACE_DIR=/home/<user>/surface
PORT=3000
```

Notes:

- `OPENROUTER_API_KEY` is only needed for `/api/chat`.
- `OPENCLAW_GATEWAY_URL` and `OPENCLAW_HOOKS_TOKEN` are only needed if surface actions should wake an OpenClaw agent.
- `SURFACE_WORKSPACE_DIR` is optional; default is `~/surface`.
- `PORT` is optional; default is `3000`.

## Step 4: Install The Linux User Service

After user approval, install the systemd user service:

```bash
./scripts/install-systemd-user-service.sh
```

Verify:

```bash
systemctl --user status surface.service --no-pager
curl -fsS http://localhost:3000/surfaces
```

Useful commands:

```bash
systemctl --user restart surface.service
systemctl --user stop surface.service
journalctl --user -u surface.service -f
```

If the service should start after login without an active terminal session, the user may need lingering enabled:

```bash
loginctl enable-linger "$USER"
```

Do not run `loginctl enable-linger` without user approval.

## Step 5: Register The MCP Server

The MCP server is a lightweight stdio adapter. It connects to the already-running Surface HTTP service through `SURFACE_URL`; it does not own the Surface service lifecycle.

Add Surface to the agent or OpenClaw MCP config:

```json
{
  "mcpServers": {
    "surface": {
      "command": "npx",
      "args": ["tsx", "/path/to/Surface/server/mcp.ts"],
      "env": {
        "SURFACE_URL": "http://localhost:3000"
      }
    }
  }
}
```

For a fully explicit local command:

```json
{
  "mcpServers": {
    "surface": {
      "command": "node",
      "args": [
        "/path/to/Surface/node_modules/tsx/dist/cli.mjs",
        "/path/to/Surface/server/mcp.ts"
      ],
      "env": {
        "SURFACE_URL": "http://localhost:3000"
      }
    }
  }
}
```

Adjust paths to the actual clone location. Restart the MCP client after editing the config.

## Step 6: Verify MCP Tools

The MCP client should advertise artifact-first tools:

- `artifact_list`
- `artifact_read`
- `artifact_create`
- `artifact_update`
- `artifact_versions`
- `artifact_rollback`
- `artifact_delete`
- `artifact_present_file`
- `surface_list`
- `surface_actions`
- `surface_ack`
- `reply`
- `display_set_theme`
- `display_reset_theme`
- `display_navigate`
- `display_status`
- `display_notify`
- `surface_exec`

It should not advertise legacy creation tools in new flows:

- `surface_create`
- `surface_read`
- `surface_update`
- `surface_delete`
- `artifact_open`

Compatibility handlers may still exist for old clients, but agents should use artifact tools.

## Step 7: Create A Test Artifact

Use MCP `artifact_create` with `mime: "text/html"` and complete HTML content:

```json
{
  "title": "Agent Test Counter",
  "mime": "text/html",
  "content": "<!doctype html><html><body><button id='b'>0</button><script>b.onclick=()=>b.textContent=Number(b.textContent)+1</script></body></html>",
  "metadata": {
    "icon": "HTML",
    "description": "MCP smoke test"
  }
}
```

Then:

1. Call `surface_list` and confirm the new card exists.
2. Call `display_navigate` with the artifact ID.
3. Confirm the browser shows the artifact-backed surface.
4. Use `artifact_update` for durable content changes.
5. Use `surface_exec` only for transient live changes that should not create a new version.

## Step 8: Verify Locally

Run:

```bash
npx tsc --noEmit
npm run test:artifacts
```

Optional OpenRouter E2E:

```bash
npm run test:e2e
```

`test:e2e` requires `OPENROUTER_API_KEY`.

## Operating Rules For Agents

- Treat Surface as a system/user service.
- Check for an existing service before installing.
- Ask the user before creating, enabling, restarting, stopping, or replacing a service.
- Use `artifact_create` for new durable content.
- Use `artifact_update` when modifying the same artifact purpose.
- Use `artifact_present_file` when the user wants to display an existing local file.
- Use `surface_list` before creating replacements.
- Use `display_navigate` to control what the user sees.
- Use `surface_actions`, `surface_ack`, and `reply` for two-way interaction.
- Do not wrap markdown, PDFs, images, video, or audio in HTML unless the user asked for a custom viewer.
- Do not commit `.env`, `surfaces.db*`, local MCP config paths, or workspace artifacts from `~/surface`.

## OpenClaw Notes

There are two separate integrations:

1. **OpenClaw uses Surface MCP tools**: register `server/mcp.ts` in OpenClaw's MCP config.
2. **Surface wakes OpenClaw on user actions**: set `OPENCLAW_GATEWAY_URL` and `OPENCLAW_HOOKS_TOKEN` in Surface's `.env`.

Surface itself should be the long-running service. OpenClaw and other agents connect to it.

## Upgrade

```bash
cd /path/to/Surface
git pull
npm install
npx tsc --noEmit
npm run test:artifacts
systemctl --user restart surface.service
```

Ask before restarting the service if the user has active work on the display.

After upgrading, re-check the MCP tool list. If new artifact tools appear, prefer them over older compatibility tools.
