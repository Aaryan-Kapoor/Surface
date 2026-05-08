#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SURFACE_URL = process.env.SURFACE_URL || "http://localhost:3000";
const POLL_INTERVAL = 2000;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${SURFACE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Surface API ${res.status}: ${err}`);
  }
  return res.json();
}

const mcp = new Server(
  { name: "surface", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
    instructions: [
      "Surface is the user's universal display — you own it end-to-end. It's not just a canvas for pushing HTML, it's YOUR display to control.",
      "You have full control: create/update/delete artifacts, execute JS in running surfaces, navigate the display, push notifications, and customize the entire look and feel.",
      "IMPORTANT: Before creating an artifact, ALWAYS call surface_list or artifact_list first to check if one already exists with a matching title or purpose. If it does, use artifact_update to refresh it and display_navigate to open it — never create duplicates.",
      "Artifacts are durable user-owned files or projects. Surfaces are how artifacts are presented in the display. Prefer artifact_present_file for existing local files and artifact_create/artifact_update for new standalone content. Do not wrap markdown, PDFs, images, audio, or video in HTML just to show them.",
      "",
      "== THEMING (display_set_theme) ==",
      "Use 'css' for CSS customization. Target these classes: .surface-card (outer card), .card-preview (thumbnail area), .card-preview-overlay (gradient over preview), .card-preview-icon (icon fallback), .card-body/.card-title/.card-description/.card-time (card content), .grid (card grid), .grid-view (scroll container), .grid-header/.grid-title (header), .surface-nav/.back-btn/.surface-nav-title (surface view nav), .starfield/.star/.nebula (background effects), .empty-state/.empty-prompt/.empty-sub (empty state), .toast (notifications). Use specific selectors — wildcards like [class*=\"card\"] will break previews.",
      "Use 'home' for a widget on the homescreen (full HTML/JS iframe above the grid). Use 'overlay' for persistent content on ALL views (full HTML/JS iframe layer). Use 'order' to reorder cards.",
      "",
      "== CUSTOM RENDERER (display_set_theme → renderer) ==",
      "Set 'renderer' to completely replace the homescreen with your own HTML/CSS/JS. You control everything — layout, animations, effects, how cards look, how they're arranged. CRT TV, 3D carousel, tetris, anything.",
      "Your renderer gets these globals injected automatically:",
      "  window.__surfaces — array of {id, title, metadata (JSON string), created_at, updated_at}",
      "  window.navigate(id) — open a surface fullscreen",
      "  window.navigateHome() — go back to grid",
      "  window.getSurface(id) — fetch full surface data (includes html)",
      "  window.parseMeta(surface) — parse metadata JSON string to object (has .icon, .description)",
      "  window.previewUrl(id) — returns '/surfaces/{id}/html' for iframe preview src",
      "  window.onSurfaceChange({created, updated, deleted}) — SSE live updates, auto-syncs __surfaces",
      "Set renderer to empty string to remove it and go back to default grid.",
      "",
      "== MARKETPLACE ==",
      "There is a built-in marketplace at GET /marketplace with pre-made surfaces, themes, renderers, and overlays.",
      "POST /marketplace/:id/install installs an item — creates a surface or applies a theme/renderer/overlay.",
      "The user can browse it at #/explore in the PWA. When suggesting themes or surfaces, mention the Explore tab.",
      "Available items include: Pomodoro Timer, Analog Clock, Calculator, Breathing Guide, Mini Piano, Color Palette, Habit Tracker, Quick Notes, Weather Station, Stopwatch, plus Cyberpunk Neon/Minimal Light/Deep Forest themes, a Retro Terminal renderer, and a Floating Clock overlay.",
      "",
      "== OPENCLAW INTEGRATION ==",
      "Surface integrates with OpenClaw. When users interact with surfaces (button clicks, form submissions), the action is automatically forwarded to the OpenClaw gateway at POST /hooks/agent if OPENCLAW_GATEWAY_URL and OPENCLAW_HOOKS_TOKEN are set in .env. The OpenClaw agent receives the action as a message and can respond using the Surface HTTP API. This enables real-time push-based two-way communication — the user clicks a button in a surface, OpenClaw's agent wakes up and responds immediately.",
      "",
      "== OTHER TOOLS ==",
      "Use display_navigate to force what's on screen. Use display_status to see what the user is currently viewing.",
      "Use surface_exec to run JS in a live surface — update counters, trigger animations, read DOM state — without replacing HTML.",
      "Use artifact_list before creating new artifacts. Update an existing artifact when the new work has the same purpose. Use stable titles and complete file contents.",
      "Use display_notify for ephemeral messages (info/success/warning/error styles).",
      "Messages arrive as <channel source=\"surface\"> tags when users interact with surfaces.",
      "To embed PDFs: <iframe src='/proxy/pdf?url=ENCODED_URL'></iframe>",
      "Most sites (Spotify, YouTube, Twitter, etc.) block direct iframe embedding. Use their embed/widget URLs instead: Spotify → open.spotify.com/embed/track/ID, YouTube → youtube.com/embed/ID, etc. Never iframe a full website — it will be blocked by X-Frame-Options or CSP.",
      "Surfaces can call LLMs via POST /api/chat — the server proxies to OpenRouter with the API key from .env. Usage: fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'hello'}]})}).then(r=>r.json()). Supports streaming with {stream:true}. Optional model override with {model:'anthropic/claude-sonnet-4'}.",
    ].join("\n"),
  }
);

const ALL_TOOLS = [
  {
    name: "artifact_list",
    description: "List durable artifacts, including file-backed artifacts and HTML surfaces.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "artifact_read",
    description: "Read an artifact's metadata, current version, and file manifest.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "artifact_create",
    description: "Create a durable artifact from complete content or a list of files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        kind: { type: "string", enum: ["file", "html", "project", "external"] },
        mime: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              mime: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
        metadata: { type: "object" },
      },
      required: ["title"],
    },
  },
  {
    name: "artifact_update",
    description: "Create a new immutable version of an existing artifact.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        kind: { type: "string", enum: ["file", "html", "project", "external"] },
        mime: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              mime: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
        metadata: { type: "object" },
        reason: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "artifact_versions",
    description: "List immutable versions for an artifact.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "artifact_rollback",
    description: "Set an artifact's current version to an earlier version number or version ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        version: { type: ["string", "number"] },
      },
      required: ["id", "version"],
    },
  },
  {
    name: "artifact_delete",
    description: "Delete an artifact and its surface view.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "artifact_present_file",
    description: "Present an existing local file in Surface without wrapping it in HTML.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Absolute or relative local file path" },
        title: { type: "string" },
        metadata: { type: "object" },
        copy: { type: "boolean" },
        open: { type: "boolean" },
      },
      required: ["path"],
    },
  },
  {
    name: "artifact_open",
    description: "Navigate the display to an artifact or surface by ID.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "surface_create",
    description: "Create a new surface with HTML/CSS/JS content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Display title" },
        html: { type: "string", description: "Complete HTML content" },
        id: { type: "string", description: "Optional custom ID" },
        metadata: {
          type: "object",
          properties: {
            icon: { type: "string" },
            description: { type: "string" },
          },
        },
      },
      required: ["title", "html"],
    },
  },
  {
    name: "surface_read",
    description: "Read a surface's current HTML content, title, and metadata.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "surface_update",
    description: "Update a surface. Hot-reloads in the user's browser.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        html: { type: "string" },
        metadata: { type: "object", properties: { icon: { type: "string" }, description: { type: "string" } } },
      },
      required: ["id"],
    },
  },
  {
    name: "surface_delete",
    description: "Delete a surface.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "surface_list",
    description: "List all surfaces.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "surface_actions",
    description: "Get pending user actions from surfaces.",
    inputSchema: {
      type: "object" as const,
      properties: { surface_id: { type: "string", description: "Filter to a specific surface" } },
    },
  },
  {
    name: "surface_ack",
    description: "Acknowledge a surface action.",
    inputSchema: {
      type: "object" as const,
      properties: { action_id: { type: "string" } },
      required: ["action_id"],
    },
  },
  {
    name: "reply",
    description: "Send a text reply to a surface (shown as toast notification).",
    inputSchema: {
      type: "object" as const,
      properties: {
        surface_id: { type: "string" },
        text: { type: "string" },
      },
      required: ["surface_id", "text"],
    },
  },
  {
    name: "display_set_theme",
    description: "Customize the entire look and feel of the Surface display. Change colors, background, fonts, card style, or inject raw CSS. Make it phenomenal.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "App title shown in the grid header" },
        background: { type: "string", description: "CSS background value for the body (color, gradient, image url())" },
        starfield: { type: "boolean", description: "Show animated starfield effect" },
        nebula: { type: "boolean", description: "Show ambient nebula effects" },
        nebulaColors: { type: "array", items: { type: "string" }, description: "Two CSS colors for nebula gradients" },
        colors: {
          type: "object",
          description: "Color scheme — all values are CSS colors",
          properties: {
            void: { type: "string", description: "Base background color (--void)" },
            glass: { type: "string", description: "Card/panel background (--glass)" },
            glassBorder: { type: "string", description: "Card border color (--glass-border)" },
            glassGlow: { type: "string", description: "Card glow on hover (--glass-glow)" },
            textPrimary: { type: "string", description: "Primary text color" },
            textSecondary: { type: "string", description: "Secondary text color" },
            textGhost: { type: "string", description: "Muted/ghost text color" },
            accent: { type: "string", description: "Accent highlight color" },
          },
        },
        cardRadius: { type: "string", description: "Card border radius e.g. '20px', '8px', '0'" },
        font: { type: "string", description: "CSS font-family value" },
        css: { type: "string", description: "Raw CSS to inject — maximum customization power. Overrides everything." },
        home: { type: "string", description: "Full HTML/CSS/JS widget on the homescreen above the card grid. Runs in an iframe. Use for clocks, mini-games, dashboards. Set to empty string to remove." },
        overlay: { type: "string", description: "Full HTML/CSS/JS persistent overlay on ALL views. Always visible. Use for floating clocks, status bars. Set to empty string to remove." },
        order: { type: "array", items: { type: "string" }, description: "Array of surface IDs defining card order on the grid. Unlisted surfaces appear after." },
        renderer: { type: "string", description: "Full HTML/CSS/JS that REPLACES the entire homescreen. You get window.__surfaces (array), window.navigate(id), window.parseMeta(s), window.previewUrl(id), window.onSurfaceChange({created,updated,deleted}). Build anything: CRT TV, 3D carousel, tetris grid, solar system. Set to empty string to remove and restore default grid." },
      },
    },
  },
  {
    name: "display_reset_theme",
    description: "Reset the display to default — removes all theme customizations, renderers, overlays, and home widgets. Restores the original starfield void look.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "display_navigate",
    description: "Force the Surface display to show a specific surface or go back to the grid.",
    inputSchema: {
      type: "object" as const,
      properties: {
        surface_id: { type: "string", description: "Surface ID to navigate to. Omit to go to grid." },
      },
    },
  },
  {
    name: "display_status",
    description: "Get the current state of the display: what's showing, viewport size, last activity.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "display_notify",
    description: "Show an ephemeral notification on the Surface display.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Notification text" },
        duration: { type: "number", description: "Duration in ms (default 5000)" },
        style: { type: "string", enum: ["info", "success", "warning", "error"], description: "Notification style" },
      },
      required: ["text"],
    },
  },
  {
    name: "surface_exec",
    description: "Execute JavaScript in a running surface's iframe. Use for real-time updates without replacing HTML — update counters, trigger animations, read DOM state, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Surface ID" },
        js: { type: "string", description: "JavaScript to execute in the surface's context" },
      },
      required: ["id", "js"],
    },
  },
];

const HIDDEN_COMPAT_TOOLS = new Set([
  "artifact_open",
  "surface_create",
  "surface_read",
  "surface_update",
  "surface_delete",
]);

const TOOLS = ALL_TOOLS.filter((tool) => !HIDDEN_COMPAT_TOOLS.has(tool.name));

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = args as Record<string, any>;
  switch (name) {
    case "artifact_list": {
      const r = await api("GET", "/artifacts");
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "artifact_read": {
      const r = await api("GET", `/artifacts/${a.id}`);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "artifact_create": {
      const r = await api("POST", "/artifacts", a);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "artifact_update": {
      const { id, ...rest } = a;
      const r = await api("PUT", `/artifacts/${id}`, rest);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "artifact_versions": {
      const r = await api("GET", `/artifacts/${a.id}/versions`);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "artifact_rollback": {
      const r = await api("POST", `/artifacts/${a.id}/rollback`, { version: a.version });
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "artifact_delete": {
      await api("DELETE", `/artifacts/${a.id}`);
      return { content: [{ type: "text", text: `Deleted artifact ${a.id}` }] };
    }
    case "artifact_present_file": {
      const r = await api("POST", "/artifacts/present-file", a);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "artifact_open": {
      await api("POST", "/display/navigate", { surface_id: a.id });
      return { content: [{ type: "text", text: `Opened artifact ${a.id}` }] };
    }
    case "surface_create": {
      const r = await api("POST", "/surfaces", a);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "surface_read": {
      const r = await api("GET", `/surfaces/${a.id}`);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "surface_update": {
      const { id, ...rest } = a;
      const r = await api("PUT", `/surfaces/${id}`, rest);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "surface_delete": {
      await api("DELETE", `/surfaces/${a.id}`);
      return { content: [{ type: "text", text: `Deleted ${a.id}` }] };
    }
    case "surface_list": {
      const r = await api("GET", "/surfaces");
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "surface_actions": {
      const path = a.surface_id ? `/surfaces/${a.surface_id}/actions` : "/actions";
      const r = await api("GET", path);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "surface_ack": {
      await api("POST", `/actions/${a.action_id}/ack`);
      return { content: [{ type: "text", text: `Acked ${a.action_id}` }] };
    }
    case "reply": {
      await api("POST", `/surfaces/${a.surface_id}/reply`, { text: a.text });
      return { content: [{ type: "text", text: `Reply sent` }] };
    }
    case "display_set_theme": {
      const r = await api("PUT", "/display/config", a);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "display_reset_theme": {
      await api("POST", "/display/reset");
      return { content: [{ type: "text", text: "Theme reset to default" }] };
    }
    case "display_navigate": {
      await api("POST", "/display/navigate", { surface_id: a.surface_id });
      return { content: [{ type: "text", text: `Navigated to ${a.surface_id || "grid"}` }] };
    }
    case "display_status": {
      const r = await api("GET", "/display/status");
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "display_notify": {
      await api("POST", "/display/notify", a);
      return { content: [{ type: "text", text: `Notification sent: ${a.text}` }] };
    }
    case "surface_exec": {
      await api("POST", `/surfaces/${a.id}/exec`, { js: a.js });
      return { content: [{ type: "text", text: `JS executed in surface ${a.id}` }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Channel notifications ──

const knownActionIds = new Set<string>();

async function pollActions() {
  try {
    const actions = (await api("GET", "/actions")) as any[];
    for (const action of actions) {
      if (knownActionIds.has(action.id)) continue;
      knownActionIds.add(action.id);

      let title = action.surface_id;
      try {
        const s = await api("GET", `/surfaces/${action.surface_id}`);
        title = s.title || action.surface_id;
      } catch {}

      let dataStr = "";
      try {
        const d = typeof action.data === "string" ? JSON.parse(action.data) : action.data;
        if (Object.keys(d).length > 0) dataStr = ` with data: ${JSON.stringify(d)}`;
      } catch {}

      // Same pattern as Telegram plugin — fire and forget
      mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `User triggered "${action.action}" on surface "${title}"${dataStr}`,
          meta: {
            surface_id: action.surface_id,
            surface_title: title,
            action_id: action.id,
            action_name: action.action,
            ts: action.created_at,
          },
        },
      });

      await api("POST", `/actions/${action.id}/ack`);
    }
  } catch {}
}

const transport = new StdioServerTransport();
await mcp.connect(transport);

// Send a test notification 3s after connect
setTimeout(() => {
  mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: "Surface channel connected and listening.",
      meta: { surface_id: "_system", ts: new Date().toISOString() },
    },
  });
}, 3000);

setInterval(pollActions, POLL_INTERVAL);
