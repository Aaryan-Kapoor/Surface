#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SURFACE_URL = process.env.SURFACE_URL || "http://localhost:3000";
const POLL_INTERVAL = 2000;

const WIDGET_CATALOG_DOC = `Surface widgets catalog (for kind='widgets' surfaces).

Spec shape:
  { root: <node>, state?: {...}, timers?: [{every: <ms>, while?: <path>, do: [<op>, ...]}] }

Each node is { type: <Component>, children?: [...], ...props }.
  - String props starting with "$.path" are resolved against state at render time.
  - "$$literal" escapes (becomes "$literal").
  - A node can set "when": "$.flag" to render conditionally.

Ops (usable in onClick, onSubmit, timers.do):
  {op:"set",    path, value}     — state[path] = value
  {op:"inc",    path, by?, max?} — increment (default by=1)
  {op:"dec",    path, by?, min?} — decrement
  {op:"toggle", path}             — flip boolean
  {op:"push",   path, value}     — array append
  {op:"remove", path, index?|value} — array remove
  {op:"post",   action, data?}   — send a surface_action to the agent

Components:
  Stack     { direction: 'vertical'|'horizontal', gap, align, justify, padding, children }
  Card      { radius, padding, children }
  Text      { value, size: xs|sm|md|lg|xl|2xl|3xl, weight, color, muted, align, tracking, as }
  Button    { label, variant: 'solid'|'ghost'|'accent', color, disabled, onClick: [<op>...] }
  Input     { type, placeholder, value, bind: <path>, onSubmit: [<op>...] }
  Checkbox  { label, value, bind: <path> }
  Image     { src, alt, width, height, fit, radius }
  ProgressBar  { value, max, color, thickness }
  ProgressRing { value, max, color, size, thickness, label }
  List      { items: <array or $.path>, item: <template node>, gap }  — in the template, use "$item" to bind to the current item and "$index" for its position
  Spacer    { size, grow }
  Box       { style, class, children }  — escape hatch for light styling

Example (Pomodoro):
  {
    root: {type:"Stack", direction:"vertical", align:"center", gap:24, children:[
      {type:"Text", value:"$.label", size:"sm", muted:true, tracking:"4px"},
      {type:"ProgressRing", value:"$.remaining", max:"$.total", label:"$.display", color:"$.color"},
      {type:"Stack", direction:"horizontal", gap:12, children:[
        {type:"Button", label:"$.startLabel", onClick:[
          {op:"toggle", path:"running"},
          {op:"set", path:"startLabel", value:"Running…"}
        ]},
        {type:"Button", variant:"ghost", label:"Reset", onClick:[
          {op:"set", path:"remaining", value:1500},
          {op:"set", path:"running", value:false},
          {op:"set", path:"display", value:"25:00"},
          {op:"set", path:"startLabel", value:"Start"}
        ]}
      ]}
    ]},
    state: {remaining:1500, total:1500, display:"25:00", running:false, label:"FOCUS", color:"#ff6b6b", startLabel:"Start"},
    timers: [{every:1000, while:"running", do:[{op:"dec", path:"remaining", min:0}]}]
  }

When to pick kind='widgets' vs kind='html':
  - Use widgets for timers, trackers, forms, lists, dashboards, status readouts.
  - Use html for games, canvas/WebGL, custom typography, exotic layouts.
  - Prefer widgets — spec updates preserve running state automatically.
`;

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
      "You have full control: create/update/delete surfaces, execute JS in running surfaces, navigate the display, push notifications, and customize the entire look and feel.",
      "IMPORTANT: Before creating a surface, ALWAYS call surface_list first to check if one already exists with a matching title or purpose. If it does, use surface_update or surface_edit to refresh it and display_navigate to open it — never create duplicates.",
      "",
      "== TWO SURFACE KINDS: pick the right one ==",
      "1. kind='widgets' (PREFER THIS FIRST). A declarative JSON spec composed from a trusted catalog (Stack, Card, Text, Button, Input, Checkbox, Image, ProgressBar, ProgressRing, List, Spacer, Box). Cheap to author, cheap to update, state survives updates automatically (a Pomodoro timer keeps ticking while you push new specs). Use for timers, trackers, forms, lists, dashboards, status views, settings panels, chat UIs. Call display_widget_catalog once for the full reference.",
      "2. kind='html' (default, escape hatch). Full HTML/CSS/JS. Use when you need canvas, WebGL, exotic typography, games, or a specific visual effect that widgets can't express.",
      "",
      "== EDITING HTML SURFACES — USE surface_edit, NOT surface_update ==",
      "For kind='html' surfaces, prefer surface_edit over surface_update for anything short of a full rewrite. surface_edit takes a list of find/replace edits (same shape as the Edit/str_replace tools). The client morphs the DOM in place: running timers, canvas state, scroll position, focus, and uncontrolled input values all survive. surface_update reloads the iframe and wipes state.",
      "Every edit's old_string must match exactly once. If ambiguous, include more surrounding context or pass replace_all=true.",
      "surface_revisions lists history; surface_restore rolls back.",
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
      "Use display_notify for ephemeral messages (info/success/warning/error styles).",
      "Messages arrive as <channel source=\"surface\"> tags when users interact with surfaces.",
      "To embed PDFs: <iframe src='/proxy/pdf?url=ENCODED_URL'></iframe>",
      "Most sites (Spotify, YouTube, Twitter, etc.) block direct iframe embedding. Use their embed/widget URLs instead: Spotify → open.spotify.com/embed/track/ID, YouTube → youtube.com/embed/ID, etc. Never iframe a full website — it will be blocked by X-Frame-Options or CSP.",
      "Surfaces can call LLMs via POST /api/chat — the server proxies to OpenRouter with the API key from .env. Usage: fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'hello'}]})}).then(r=>r.json()). Supports streaming with {stream:true}. Optional model override with {model:'anthropic/claude-sonnet-4'}.",
    ].join("\n"),
  }
);

const TOOLS = [
  {
    name: "surface_create",
    description: "Create a new surface. Two kinds are supported:\n" +
      "  kind='html' (default) — pass `html` with complete HTML/CSS/JS. Use when you need full freedom (games, canvas, WebGL, complex layouts, custom typography).\n" +
      "  kind='widgets' — pass `spec` with a declarative JSON tree using trusted components (Stack, Card, Text, Button, Input, Checkbox, Image, ProgressBar, ProgressRing, List, Spacer, Box). Prefer this for timers, forms, lists, dashboards, status views — it's cheaper in tokens, safer, and state survives agent-pushed updates automatically.\n" +
      "Before creating, call surface_list to check for an existing surface you should surface_update or surface_edit instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Display title" },
        kind: {
          type: "string",
          enum: ["html", "widgets"],
          description: "Surface kind. Default 'html'.",
        },
        html: { type: "string", description: "Complete HTML content (required when kind='html')." },
        spec: {
          type: "object",
          description:
            "Widgets spec (required when kind='widgets'). Shape: {root: <node>, state?: {...}, timers?: [...]}. " +
            "Each node is {type: <ComponentName>, children?: [...], ...props}. Bindings: any string prop starting with '$.path' resolves against state. " +
            "Ops for onClick / timers: {op:'set'|'inc'|'dec'|'toggle'|'push'|'remove'|'post', path, value?, by?, min?, max?, action?, data?}. " +
            "Call display_widget_catalog for the full component reference.",
        },
        id: { type: "string", description: "Optional custom ID" },
        metadata: {
          type: "object",
          properties: {
            icon: { type: "string" },
            description: { type: "string" },
          },
        },
      },
      required: ["title"],
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
    description:
      "Update a surface by REPLACING its content. For kind='html' surfaces, strongly prefer surface_edit (cheaper, preserves state). For kind='widgets', pass `spec` to push a new declarative tree — the runtime diffs state against the new spec and preserves existing state values, so a Pomodoro mid-countdown keeps ticking.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        html: { type: "string", description: "New HTML (for kind='html' surfaces)." },
        spec: { type: "object", description: "New widgets spec (for kind='widgets' surfaces)." },
        kind: { type: "string", enum: ["html", "widgets"] },
        metadata: { type: "object", properties: { icon: { type: "string" }, description: { type: "string" } } },
      },
      required: ["id"],
    },
  },
  {
    name: "surface_edit",
    description: "Apply precise find/replace edits to a surface's HTML. Preferred over surface_update for targeted changes: edits are cheap in tokens and the client morphs the DOM in place, so running timers, form state, scroll position, and event handlers on unchanged elements survive. Each edit's old_string must match exactly once unless replace_all=true. HTML-kind surfaces only — use surface_update for widgets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Surface ID" },
        edits: {
          type: "array",
          description: "Ordered edits applied sequentially. Each edit sees the result of previous edits.",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string", description: "Exact substring to replace (include enough context to be unique)" },
              new_string: { type: "string", description: "Replacement text" },
              replace_all: { type: "boolean", description: "If true, replace every occurrence instead of requiring uniqueness. Default false." },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["id", "edits"],
    },
  },
  {
    name: "surface_revisions",
    description: "List the revision history for a surface. Returns the most recent N revisions with their edit_kind (create/update/edit/restore) and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        limit: { type: "number", description: "Max revisions to return (default 50, max 200)" },
      },
      required: ["id"],
    },
  },
  {
    name: "surface_restore",
    description: "Restore a surface to a past revision. Creates a new revision (doesn't rewrite history).",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        revision: { type: "number" },
      },
      required: ["id", "revision"],
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
    name: "display_widget_catalog",
    description: "Return the full component catalog (names, props, ops) for kind='widgets' surfaces. Call this once per session before authoring widgets specs.",
    inputSchema: { type: "object" as const, properties: {} },
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

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = args as Record<string, any>;
  switch (name) {
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
    case "surface_edit": {
      const r = await api("PATCH", `/surfaces/${a.id}`, { edits: a.edits });
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "surface_revisions": {
      const qs = a.limit ? `?limit=${encodeURIComponent(a.limit)}` : "";
      const r = await api("GET", `/surfaces/${a.id}/revisions${qs}`);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "surface_restore": {
      const r = await api("POST", `/surfaces/${a.id}/revisions/${a.revision}/restore`);
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
    case "display_widget_catalog": {
      return {
        content: [
          { type: "text", text: WIDGET_CATALOG_DOC },
        ],
      };
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
