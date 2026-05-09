# Surface Installation Guide for AI Agents

Read this entire file, then follow the steps. Target: a working local Surface display plus MCP tools that can create artifact-backed surfaces.

## Step 0: Read The Repo Protocol

Read `AGENTS.md` at the repo root first. It describes the current artifact-first architecture, the MCP tool contract, and local conventions.

If you fetched this file by URL before cloning, the companion files live at:

- `AGENTS.md` - agent operating protocol
- `README.md` - user-facing setup and API overview
- `docs/architecture.md` - current architecture details
- `STATUS.md` - compact implementation status

## Step 1: Clone And Install

```powershell
git clone https://github.com/Aaryan-Kapoor/Surface.git
cd Surface
npm install
```

If the user wants a specific branch, check it out before installing or running:

```powershell
git checkout feature/artifact-architecture
npm install
```

## Step 2: Configure Environment

Create `.env` only if the user wants OpenRouter chat proxying or OpenClaw fan-out. Never commit `.env`.

```text
OPENROUTER_API_KEY=...
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_HOOKS_TOKEN=...
SURFACE_WORKSPACE_DIR=C:\Users\<user>\surface
```

Notes:

- `OPENROUTER_API_KEY` is only needed for `/api/chat`.
- `OPENCLAW_GATEWAY_URL` and `OPENCLAW_HOOKS_TOKEN` are only needed if surface actions should wake an OpenClaw agent.
- `SURFACE_WORKSPACE_DIR` is optional; default is `~/surface`.

## Step 3: Start Surface

```powershell
npm run dev
```

Verify:

- Open `http://localhost:3000`.
- `GET http://localhost:3000/surfaces` should return JSON.
- The PWA grid should load, even if empty.

## Step 4: Register The MCP Server

Add Surface to the agent or OpenClaw MCP config:

```json
{
  "mcpServers": {
    "surface": {
      "command": "npx",
      "args": ["tsx", "D:\\Programming\\Surface\\server\\mcp.ts"],
      "env": {
        "SURFACE_URL": "http://localhost:3000"
      }
    }
  }
}
```

If `npx` resolution is unreliable on Windows, use the local `tsx` entry directly:

```json
{
  "mcpServers": {
    "surface": {
      "command": "node",
      "args": [
        "D:\\Programming\\Surface\\node_modules\\tsx\\dist\\cli.mjs",
        "D:\\Programming\\Surface\\server\\mcp.ts"
      ],
      "env": {
        "SURFACE_URL": "http://localhost:3000"
      }
    }
  }
}
```

Adjust paths to the actual clone location. Restart the MCP client after editing the config.

## Step 5: Verify MCP Tools

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

## Step 6: Create A Test Artifact

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

## Step 7: Verify Locally

Run:

```powershell
npx tsc --noEmit
npm run test:artifacts
```

Optional OpenRouter E2E:

```powershell
npm run test:e2e
```

`test:e2e` requires `OPENROUTER_API_KEY`.

## Operating Rules For Agents

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

For both directions, Surface must be running with `npm run dev`.

## Upgrade

```powershell
cd D:\Programming\Surface
git pull
npm install
npx tsc --noEmit
npm run test:artifacts
```

After upgrading, re-check the MCP tool list. If new artifact tools appear, prefer them over older compatibility tools.
