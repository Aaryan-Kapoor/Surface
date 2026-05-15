const app = document.getElementById("app");
let surfaces = [];
let globalSSE = null;
let surfaceSSE = null;
let currentSurfaceId = null;
let displayConfig = {};
let features = { marketplace: false };

// ── postMessage bridge (iframe → server) ──

window.addEventListener("message", (e) => {
  if (!e.data) return;

  // Renderer/overlay/widget navigation
  if (e.data.type === "surface_navigate") {
    if (e.data.surface_id) {
      navigate("/surface/" + e.data.surface_id);
    } else {
      navigate("/");
    }
    return;
  }

  // Surface action bridge (iframe → server)
  if (e.data.type !== "surface_action") return;
  const surfaceId = currentSurfaceId;
  if (!surfaceId) return;

  fetch(`/surfaces/${surfaceId}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: e.data.action,
      data: e.data.data || {},
    }),
  }).catch(() => {});
});

// ── Empty-state cycling suggestions ──
// Shows a rotating list of things the user could ask their agent for.
// Each suggestion "prints in" with the same scan-wipe used elsewhere.

const EMPTY_SUGGESTIONS = [
  "a pomodoro",
  "today's weather",
  "a snake game",
  "a meditation guide",
  "a 7-minute workout",
  "a bill-split calculator",
  "the chord progression to wonderwall",
  "a habit tracker",
  "an ascii art cat",
  "today's headlines",
  "a breathing circle",
  "a flashcard deck for biology",
];

let emptySuggestionT = null;
function cycleEmptySuggestions(root) {
  if (emptySuggestionT) { clearInterval(emptySuggestionT); emptySuggestionT = null; }
  const slot = root.querySelector(".empty-suggestions");
  if (!slot) return;
  let i = Math.floor(Math.random() * EMPTY_SUGGESTIONS.length);
  // Seed first value
  slot.innerHTML = `<span class="empty-suggestion">${EMPTY_SUGGESTIONS[i]}</span>`;
  emptySuggestionT = setInterval(() => {
    if (!document.body.contains(slot)) {
      clearInterval(emptySuggestionT);
      emptySuggestionT = null;
      return;
    }
    i = (i + 1) % EMPTY_SUGGESTIONS.length;
    slot.innerHTML = `<span class="empty-suggestion">${EMPTY_SUGGESTIONS[i]}</span>`;
  }, 3600);
}

// ── Toast notifications ──

function showToast(text, duration = 4000, style = "info") {
  const toast = document.createElement("div");
  toast.className = "toast";
  if (style && style !== "info") toast.classList.add("toast--" + style);
  toast.textContent = text;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast--visible"));
  setTimeout(() => {
    toast.classList.remove("toast--visible");
    toast.addEventListener("transitionend", () => toast.remove());
  }, duration);
}

// ── Theme system ──

function jsonParse(v) {
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

function applyTheme(config) {
  if (!config || Object.keys(config).length === 0) {
    // Reset to defaults
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
    const themeCSS = document.getElementById("theme-css");
    if (themeCSS) themeCSS.remove();
    const overlay = document.getElementById("display-overlay");
    if (overlay) overlay.remove();
    const hw = document.getElementById("home-widget");
    if (hw) hw.remove();
    displayConfig = {};
    return;
  }
  const root = document.documentElement;

  // Normalize stringified fields
  config.colors = jsonParse(config.colors);
  config.nebulaColors = jsonParse(config.nebulaColors);
  config.order = jsonParse(config.order);
  if (typeof config.starfield === "string") config.starfield = config.starfield === "true";
  if (typeof config.nebula === "string") config.nebula = config.nebula === "true";

  // CSS custom properties
  if (config.colors && typeof config.colors === "object") {
    const map = {
      void: "--void",
      glass: "--glass",
      glassBorder: "--glass-border",
      glassGlow: "--glass-glow",
      textPrimary: "--text-primary",
      textSecondary: "--text-secondary",
      textGhost: "--text-ghost",
      accent: "--accent",
    };
    for (const [key, prop] of Object.entries(map)) {
      if (config.colors[key]) root.style.setProperty(prop, config.colors[key]);
    }
  }

  // Background
  if (config.background) {
    document.body.style.background = config.background;
  } else if (config.colors && config.colors.void) {
    document.body.style.background = config.colors.void;
  }

  // Font
  if (config.font) {
    document.body.style.fontFamily = config.font;
  }

  // Card radius
  if (config.cardRadius) {
    root.style.setProperty("--card-radius", config.cardRadius);
  }

  // Starfield — opt-in (default chrome uses .bench instead). Agents
  // turn it on with `starfield: true`. Either explicit `false` or
  // omission keeps it hidden.
  const starfieldOn = config.starfield === true;
  const starfield = document.getElementById("starfield");
  if (starfield) starfield.style.display = starfieldOn ? "" : "none";

  // Nebulae — opt-in.
  const nebulaOn = config.nebula === true;
  document.querySelectorAll(".nebula").forEach((el) => {
    el.style.display = nebulaOn ? "" : "none";
  });
  if (config.nebulaColors && config.nebulaColors.length >= 2) {
    const n1 = document.querySelector(".nebula--1");
    const n2 = document.querySelector(".nebula--2");
    if (n1) n1.style.background = `radial-gradient(circle, ${config.nebulaColors[0]}, transparent 70%)`;
    if (n2) n2.style.background = `radial-gradient(circle, ${config.nebulaColors[1]}, transparent 70%)`;
  }

  // Bench — the default substrate. Hide if the agent opted into the
  // space metaphor instead, so we don't overlay two backgrounds.
  const bench = document.getElementById("bench");
  if (bench) bench.style.display = (starfieldOn || nebulaOn) ? "none" : "";

  // Custom CSS injection — wrapped in @layer theme so shell styles always win
  let customStyle = document.getElementById("theme-css");
  if (config.css) {
    if (!customStyle) {
      customStyle = document.createElement("style");
      customStyle.id = "theme-css";
      document.head.appendChild(customStyle);
    }
    customStyle.textContent = config.css;
  } else if (customStyle) {
    customStyle.remove();
  }

  // Theme color meta tag
  if (config.colors && config.colors.void) {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = config.colors.void;
  }

  // Persistent overlay (across all views)
  renderOverlay(config);

  // Refresh home widget if it changed
  const hw = document.getElementById("home-widget");
  if (hw && config.home) {
    hw.src = "/display/home/html?" + Date.now();
  } else if (hw && !config.home) {
    hw.remove();
  }

  displayConfig = config;
}

function renderOverlay(config) {
  let overlay = document.getElementById("display-overlay");
  if (config.overlay) {
    if (!overlay) {
      overlay = document.createElement("iframe");
      overlay.id = "display-overlay";
      overlay.src = "/display/overlay/html";
      document.body.appendChild(overlay);
    } else {
      overlay.src = "/display/overlay/html?" + Date.now();
    }
  } else if (overlay) {
    overlay.remove();
  }
}

// ── Theme suspend/resume (for Explore view) ──

function suspendTheme() {
  const themeCSS = document.getElementById("theme-css");
  if (themeCSS) themeCSS.disabled = true;
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
  const overlay = document.getElementById("display-overlay");
  if (overlay) overlay.style.display = "none";
}

function resumeTheme() {
  const themeCSS = document.getElementById("theme-css");
  if (themeCSS) themeCSS.disabled = false;
  if (displayConfig && Object.keys(displayConfig).length > 0) {
    applyTheme(displayConfig);
  }
  const overlay = document.getElementById("display-overlay");
  if (overlay) overlay.style.display = "";
}

// ── Presence reporting ──

function reportPresence() {
  const route = getRoute();
  fetch("/display/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      current_view: route.view,
      current_surface_id: route.view === "surface" ? route.id : null,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
    }),
  }).catch(() => {});
}

// ── Routing ──

function navigate(path) {
  window.location.hash = path;
}

function getRoute() {
  const hash = window.location.hash.slice(1) || "/";
  if (hash === "/") return { view: "grid" };
  if (hash === "/explore") return { view: "explore" };
  const match = hash.match(/^\/surface\/(.+)$/);
  if (match) return { view: "surface", id: match[1] };
  return { view: "grid" };
}

window.addEventListener("hashchange", render);

// ── Bench (default substrate: graph paper + drifting sweep) ──
// Themes can opt back into the starfield/nebula via config.starfield/nebula.

function createBench() {
  const el = document.createElement("div");
  el.className = "bench";
  el.id = "bench";
  const sweep = document.createElement("div");
  sweep.className = "bench-sweep";
  el.appendChild(sweep);
  return el;
}

// Briefly perturb the sweep — called whenever the agent pushes
// something via SSE (create/update/delete/theme/notify).
let benchPulseT = 0;
function pulseBench() {
  const bench = document.getElementById("bench");
  if (!bench) return;
  if (Date.now() - benchPulseT < 500) return; // throttle
  benchPulseT = Date.now();
  bench.classList.remove("bench--pulse");
  void bench.offsetWidth; // reflow to restart anim
  bench.classList.add("bench--pulse");
  setTimeout(() => bench.classList.remove("bench--pulse"), 1500);
}

// ── Starfield (3 parallax layers) — opt-in via theme ──

function createStarfield() {
  const el = document.createElement("div");
  el.className = "starfield";
  el.id = "starfield";

  const layers = [
    { class: "star--far", count: 80, parallax: 0.01 },
    { class: "star--mid", count: 40, parallax: 0.025 },
    { class: "star--near", count: 15, parallax: 0.05 },
  ];

  layers.forEach((layer) => {
    const layerEl = document.createElement("div");
    layerEl.className = "star-layer";
    layerEl.dataset.parallax = layer.parallax;
    for (let i = 0; i < layer.count; i++) {
      const star = document.createElement("div");
      star.className = "star " + layer.class;
      star.style.left = Math.random() * 100 + "%";
      star.style.top = Math.random() * 100 + "%";
      star.style.animationDelay = Math.random() * 8 + "s";
      layerEl.appendChild(star);
    }
    el.appendChild(layerEl);
  });

  // Starfield is opt-in. Default chrome uses .bench instead.
  if (displayConfig.starfield !== true) el.style.display = "none";

  return el;
}

function createNebulae() {
  const frag = document.createDocumentFragment();
  const n1 = document.createElement("div");
  n1.className = "nebula nebula--1";
  const n2 = document.createElement("div");
  n2.className = "nebula nebula--2";

  if (displayConfig.nebulaColors && displayConfig.nebulaColors.length >= 2) {
    n1.style.background = `radial-gradient(circle, ${displayConfig.nebulaColors[0]}, transparent 70%)`;
    n2.style.background = `radial-gradient(circle, ${displayConfig.nebulaColors[1]}, transparent 70%)`;
  }

  // Nebulae are opt-in. Default chrome uses .bench instead.
  if (displayConfig.nebula !== true) {
    n1.style.display = "none";
    n2.style.display = "none";
  }

  frag.appendChild(n1);
  frag.appendChild(n2);
  return frag;
}

// ── Parallax on pointer/gyro ──

function initParallax() {
  document.addEventListener("mousemove", (e) => {
    const cx = (e.clientX / window.innerWidth - 0.5) * 2;
    const cy = (e.clientY / window.innerHeight - 0.5) * 2;
    applyParallax(cx, cy);
  });

  if (window.DeviceOrientationEvent) {
    window.addEventListener("deviceorientation", (e) => {
      if (e.gamma === null) return;
      const cx = Math.max(-1, Math.min(1, e.gamma / 30));
      const cy = Math.max(-1, Math.min(1, (e.beta - 45) / 30));
      applyParallax(cx, cy);
    });
  }
}

function applyParallax(cx, cy) {
  const layers = document.querySelectorAll(".star-layer");
  layers.forEach((layer) => {
    const p = parseFloat(layer.dataset.parallax) || 0;
    const x = cx * p * 200;
    const y = cy * p * 200;
    layer.style.transform = `translate(${x}px, ${y}px)`;
  });
}

initParallax();

// ── Helpers ──

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr + "Z").getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  return days + "d ago";
}

function parseMetadata(meta) {
  if (typeof meta === "string") {
    try { return JSON.parse(meta); } catch { return {}; }
  }
  return meta || {};
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function iconForMime(mime) {
  if (mime === "application/pdf") return "PDF";
  if (mime === "text/markdown") return "MD";
  if (mime === "text/html") return "HTML";
  if (mime && mime.startsWith("image/")) return "IMG";
  if (mime && mime.startsWith("video/")) return "VID";
  if (mime && mime.startsWith("audio/")) return "AUD";
  return "\u25C9";
}

function labelForMime(mime) {
  if (mime === "application/pdf") return "PDF";
  if (mime === "text/markdown") return "Markdown";
  if (mime === "text/html") return "HTML";
  if (mime === "image/svg+xml") return "SVG";
  if (mime && mime.startsWith("image/")) return "Image";
  if (mime && mime.startsWith("video/")) return "Video";
  if (mime && mime.startsWith("audio/")) return "Audio";
  if (mime && mime.startsWith("text/")) return "Text";
  return mime || "Artifact";
}

// ── Grid View ──

function renderGrid() {
  if (surfaceSSE) { surfaceSSE.close(); surfaceSSE = null; }
  currentSurfaceId = null;
  resumeTheme();

  // Custom renderer — agent controls entire grid view
  if (displayConfig.renderer) {
    const iframe = document.createElement("iframe");
    iframe.id = "renderer-frame";
    iframe.src = "/display/renderer/html?" + Date.now();
    iframe.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:none;background:transparent;";
    app.innerHTML = "";
    app.appendChild(iframe);
    connectGlobalSSE();
    return;
  }

  const container = document.createElement("div");
  container.appendChild(createBench());
  container.appendChild(createStarfield());
  container.appendChild(createNebulae());

  const gridView = document.createElement("div");
  gridView.className = "grid-view";
  if (surfaces.length > 0) gridView.classList.add("has-cards");

  const title = displayConfig.title || "Surface";
  const header = document.createElement("div");
  header.className = "grid-header";
  const exploreBtn = features.marketplace
    ? `<button class="explore-btn" onclick="navigate('/explore')">Explore</button>`
    : "";
  const count = surfaces.length;
  const countLabel = count === 0 ? "" : `${String(count).padStart(2, "0")} ${count === 1 ? "surface" : "surfaces"}`;
  header.innerHTML = `
    <div class="grid-title-block">
      <div class="grid-title">${escapeHtml(title)}</div>
      <div class="grid-subtitle">your agents' workbench</div>
    </div>
    ${count > 0 ? `<div class="grid-meta">${escapeHtml(countLabel)}</div>` : ""}
    ${exploreBtn}
  `;
  gridView.appendChild(header);

  // Home widget (full HTML/JS iframe on the homescreen)
  if (displayConfig.home) {
    const widget = document.createElement("iframe");
    widget.id = "home-widget";
    widget.className = "home-widget";
    widget.src = "/display/home/html";
    gridView.appendChild(widget);
    // Auto-size: listen for content height
    widget.onload = () => {
      try {
        const h = widget.contentDocument.documentElement.scrollHeight;
        widget.style.height = Math.max(h, 60) + "px";
      } catch { widget.style.height = "200px"; }
    };
  }

  // Sort surfaces by agent-defined order
  if (displayConfig.order && displayConfig.order.length > 0) {
    const orderMap = {};
    displayConfig.order.forEach((id, i) => { orderMap[id] = i; });
    surfaces.sort((a, b) => {
      const ai = orderMap[a.id] !== undefined ? orderMap[a.id] : Infinity;
      const bi = orderMap[b.id] !== undefined ? orderMap[b.id] : Infinity;
      if (ai !== bi) return ai - bi;
      return new Date(b.updated_at) - new Date(a.updated_at);
    });
  }

  if (surfaces.length === 0 && !displayConfig.home) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="empty-glyph" aria-hidden="true"></div>
      <div class="empty-prompt">What should I make?</div>
      <div class="empty-suggestions"><span class="empty-suggestion" id="empty-suggestion">a pomodoro</span></div>
      <div class="empty-sub">tell your agent</div>
    `;
    container.appendChild(empty);
    cycleEmptySuggestions(empty);
  } else {
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.id = "surface-grid";

    surfaces.forEach((s, i) => {
      const card = createCard(s, i);
      grid.appendChild(card);
    });

    gridView.appendChild(grid);
  }

  container.appendChild(gridView);
  app.innerHTML = "";
  app.appendChild(container);

  // Re-apply theme to newly created elements
  applyTheme(displayConfig);

  connectGlobalSSE();
}

function createCard(s, index) {
  const meta = parseMetadata(s.metadata);
  const card = document.createElement("div");
  card.className = "surface-card";
  card.dataset.id = s.id;
  card.style.animationDelay = ((index || 0) * 0.08) + "s";
  card.onclick = () => navigate("/surface/" + s.id);

  // Preview thumbnail
  const preview = document.createElement("div");
  preview.className = "card-preview";
  const previewUrl = s.preview_url || (s.artifact ? `/artifacts/${s.artifact.id}/view?preview=1` : `/surfaces/${s.id}/html`);
  const mime = s.artifact_mime || (s.artifact && s.artifact.mime) || "";
  const shouldUseIframePreview =
    previewUrl &&
    !mime.startsWith("video/") &&
    !mime.startsWith("audio/") &&
    mime !== "application/pdf" &&
    s.artifact_kind !== "project";
  const hasExternalScripts = s.html && (s.html.includes('<script src') || s.html.includes('import('));
  if (shouldUseIframePreview) {
    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-scripts allow-same-origin";
    if (s.html && s.html.length < 8000 && !hasExternalScripts) {
      iframe.srcdoc = s.html;
    } else {
      iframe.src = previewUrl;
    }
    iframe.tabIndex = -1;
    iframe.loading = "lazy";
    preview.appendChild(iframe);
    const overlay = document.createElement("div");
    overlay.className = "card-preview-overlay";
    preview.appendChild(overlay);
  } else {
    const iconEl = document.createElement("div");
    iconEl.className = "card-preview-icon";
    iconEl.textContent = meta.icon || iconForMime(mime);
    preview.appendChild(iconEl);
  }

  // Live pip — surfaces touched in the last 60s wear an orange dot
  if (s.updated_at) {
    const ageMs = Date.now() - new Date(s.updated_at + "Z").getTime();
    if (ageMs < 60000) {
      const live = document.createElement("div");
      live.className = "card-live";
      live.textContent = "live";
      preview.appendChild(live);
    }
  }

  card.appendChild(preview);

  // Card body
  const body = document.createElement("div");
  body.className = "card-body";
  body.innerHTML = `
    <div class="card-body-top">
      ${meta.icon ? `<span class="card-icon">${meta.icon}</span>` : ""}
      <div class="card-title">${escapeHtml(s.title)}</div>
      ${mime ? `<div class="card-badge">${escapeHtml(labelForMime(mime))}</div>` : ""}
    </div>
    ${meta.description ? `<div class="card-description">${escapeHtml(meta.description)}</div>` : ""}
    <div class="card-time">${timeAgo(s.updated_at)}</div>
  `;
  card.appendChild(body);

  return card;
}

// ── Surface View ──

async function renderSurface(id) {
  if (globalSSE) { globalSSE.close(); globalSSE = null; }
  currentSurfaceId = id;
  resumeTheme();

  const res = await fetch("/surfaces/" + id);
  if (!res.ok) { navigate("/"); return; }
  const surface = await res.json();

  const view = document.createElement("div");
  view.className = "surface-view";

  const mime = surface.artifact_mime || (surface.artifact && surface.artifact.mime) || "";
  const mimeLabel = mime ? labelForMime(mime) : "";

  const nav = document.createElement("div");
  nav.className = "surface-nav";
  nav.innerHTML = `
    <button class="back-btn" onclick="location.hash='/'" aria-label="Back">←</button>
    <div class="surface-nav-titlewrap">
      <div class="surface-nav-title">${escapeHtml(surface.title)}</div>
      <div class="surface-nav-meta">
        ${mimeLabel ? `<span>${escapeHtml(mimeLabel)}</span>` : ""}
        ${mimeLabel ? `<span class="surface-nav-meta-dot"></span>` : ""}
        <span>${escapeHtml(timeAgo(surface.updated_at))}</span>
        <span class="surface-nav-meta-dot"></span>
        <span class="surface-nav-live">live</span>
      </div>
    </div>
  `;
  view.appendChild(nav);

  const iframe = document.createElement("iframe");
  iframe.className = "surface-frame";
  iframe.src = surface.view_url || (surface.artifact ? `/artifacts/${surface.artifact.id}/view` : `/surfaces/${surface.id}/html`);
  view.appendChild(iframe);

  app.innerHTML = "";
  app.appendChild(view);

  // SSE for live updates
  surfaceSSE = new EventSource("/surfaces/" + id + "/stream");
  surfaceSSE.addEventListener("surface_updated", (e) => {
    const data = JSON.parse(e.data);
    if (data.html || data.reload || data.version_id) {
      iframe.src = iframe.src.split("?")[0] + "?v=" + Date.now();
      // Visual cue: brief blur-fade on the iframe when the agent
      // re-renders. Couples SSE to motion.
      iframe.classList.remove("refreshing");
      void iframe.offsetWidth;
      iframe.classList.add("refreshing");
    }
    if (data.title) {
      const titleEl = view.querySelector(".surface-nav-title");
      if (titleEl) titleEl.textContent = data.title;
    }
    if (data.updated_at) {
      const metaEl = view.querySelector(".surface-nav-meta");
      if (metaEl) {
        const tsSpan = metaEl.querySelectorAll("span")[mimeLabel ? 2 : 0];
        if (tsSpan) tsSpan.textContent = timeAgo(data.updated_at);
      }
    }
  });
  surfaceSSE.addEventListener("agent_reply", (e) => {
    const data = JSON.parse(e.data);
    showToast(data.text);
  });
  surfaceSSE.addEventListener("surface_exec", (e) => {
    const data = JSON.parse(e.data);
    if (iframe.contentWindow && data.js) {
      try {
        iframe.contentWindow.eval(data.js);
      } catch (err) {
        console.error("[surface_exec]", err);
      }
    }
  });
}

// ── Global SSE ──

function connectGlobalSSE() {
  if (globalSSE) globalSSE.close();
  globalSSE = new EventSource("/stream");

  globalSSE.addEventListener("surface_created", (e) => {
    const data = JSON.parse(e.data);
    pulseBench();
    fetch("/surfaces/" + data.id).then(r => r.json()).then(full => {
      surfaces.unshift(full);
      const grid = document.getElementById("surface-grid");
      if (grid) {
        const card = createCard(full, 0);
        grid.prepend(card);
        const empty = document.querySelector(".empty-state");
        if (empty) {
          if (emptySuggestionT) { clearInterval(emptySuggestionT); emptySuggestionT = null; }
          empty.remove();
        }
        // First card → enable the rail.
        const gv = document.querySelector(".grid-view");
        if (gv) gv.classList.add("has-cards");
        // Update the count meta in the header.
        updateGridMeta();
      } else {
        render();
      }
    });
  });

  globalSSE.addEventListener("surface_updated", (e) => {
    const data = JSON.parse(e.data);
    pulseBench();
    const idx = surfaces.findIndex((s) => s.id === data.id);
    if (idx !== -1) {
      surfaces[idx] = { ...surfaces[idx], ...data };
      const card = document.querySelector(`.surface-card[data-id="${data.id}"]`);
      if (card) {
        const titleEl = card.querySelector(".card-title");
        if (titleEl) titleEl.textContent = data.title || surfaces[idx].title;
        const timeEl = card.querySelector(".card-time");
        if (timeEl) timeEl.textContent = timeAgo(data.updated_at);
        // Add (or refresh) the live pip
        let live = card.querySelector(".card-live");
        if (!live) {
          live = document.createElement("div");
          live.className = "card-live";
          live.textContent = "live";
          const preview = card.querySelector(".card-preview");
          if (preview) preview.appendChild(live);
        }
        // Remove the pip after 60s so it stays meaningful.
        setTimeout(() => {
          const stillThere = card.querySelector(".card-live");
          if (stillThere) stillThere.remove();
        }, 60000);
      }
    }
  });

  globalSSE.addEventListener("surface_deleted", (e) => {
    const data = JSON.parse(e.data);
    pulseBench();
    surfaces = surfaces.filter((s) => s.id !== data.id);
    const card = document.querySelector(`.surface-card[data-id="${data.id}"]`);
    if (card) {
      card.classList.add("removing");
      card.addEventListener("animationend", () => {
        card.remove();
        if (surfaces.length === 0) {
          render();
        } else {
          updateGridMeta();
        }
      });
    }
  });

  // ── Display commands from agent ──

  globalSSE.addEventListener("display_navigate", (e) => {
    const data = JSON.parse(e.data);
    if (data.surface_id) {
      navigate("/surface/" + data.surface_id);
    } else {
      navigate("/");
    }
  });

  globalSSE.addEventListener("display_notify", (e) => {
    const data = JSON.parse(e.data);
    showToast(data.text, data.duration || 5000, data.style || "info");
    pulseBench();
  });

  globalSSE.addEventListener("display_theme", (e) => {
    const prev = displayConfig.renderer;
    const data = JSON.parse(e.data);
    applyTheme(data);
    pulseBench();
    // Re-render if renderer was added/removed/changed
    if ((prev || "") !== (data.renderer || "")) render();
  });
}

// Update the surface-count badge in the grid header without
// re-rendering the whole grid (used after SSE create/delete).
function updateGridMeta() {
  const header = document.querySelector(".grid-header");
  if (!header) return;
  let metaEl = header.querySelector(".grid-meta");
  const n = surfaces.length;
  const label = n === 0 ? "" : `${String(n).padStart(2, "0")} ${n === 1 ? "surface" : "surfaces"}`;
  if (n === 0) {
    if (metaEl) metaEl.remove();
    return;
  }
  if (!metaEl) {
    metaEl = document.createElement("div");
    metaEl.className = "grid-meta";
    const exploreBtn = header.querySelector(".explore-btn");
    if (exploreBtn) header.insertBefore(metaEl, exploreBtn);
    else header.appendChild(metaEl);
  }
  metaEl.textContent = label;
}

// ── Explore View (Marketplace) ──

async function renderExplore() {
  if (surfaceSSE) { surfaceSSE.close(); surfaceSSE = null; }
  if (globalSSE) { globalSSE.close(); globalSSE = null; }
  currentSurfaceId = null;
  suspendTheme();

  const container = document.createElement("div");
  container.appendChild(createBench());
  container.appendChild(createStarfield());
  container.appendChild(createNebulae());

  const view = document.createElement("div");
  view.className = "explore-view";

  // Header
  const header = document.createElement("div");
  header.className = "explore-header";
  header.innerHTML = `
    <button class="back-btn" onclick="navigate('/')" aria-label="Back">←</button>
    <div class="grid-title-block" style="flex:1">
      <div class="grid-title">Explore</div>
      <div class="grid-subtitle">themes, renderers, surfaces</div>
    </div>
  `;
  view.appendChild(header);

  // Category pills
  const cats = document.createElement("div");
  cats.className = "explore-cats";
  const categories = [
    { label: "All", filter: "" },
    { label: "Surfaces", filter: "type=surface" },
    { label: "Themes", filter: "type=theme" },
    { label: "Renderers", filter: "type=renderer" },
    { label: "Overlays", filter: "type=overlay" },
  ];
  categories.forEach((c, i) => {
    const pill = document.createElement("button");
    pill.className = "explore-pill" + (i === 0 ? " active" : "");
    pill.textContent = c.label;
    pill.onclick = () => {
      cats.querySelectorAll(".explore-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      loadMarketplace(c.filter, view.querySelector(".explore-grid"));
    };
    cats.appendChild(pill);
  });
  view.appendChild(cats);

  // Grid
  const grid = document.createElement("div");
  grid.className = "explore-grid";
  view.appendChild(grid);

  container.appendChild(view);
  app.innerHTML = "";
  app.appendChild(container);

  applyTheme(displayConfig);
  await loadMarketplace("", grid);
}

async function loadMarketplace(filter, grid) {
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-ghost);padding:40px;font-size:13px;letter-spacing:2px">Loading...</div>';
  const res = await fetch("/marketplace" + (filter ? "?" + filter : ""));
  const items = await res.json();
  grid.innerHTML = "";

  if (items.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-ghost);padding:40px">Nothing here yet</div>';
    return;
  }

  items.forEach((item, i) => {
    const card = document.createElement("div");
    card.className = "explore-card";
    card.style.animationDelay = (i * 0.06) + "s";

    // Preview
    const preview = document.createElement("div");
    preview.className = "card-preview";
    if (item.type === "surface") {
      const iframe = document.createElement("iframe");
      iframe.sandbox = "allow-scripts";
      iframe.src = "/marketplace/" + item.id + "/preview";
      iframe.tabIndex = -1;
      iframe.loading = "lazy";
      preview.appendChild(iframe);
      const overlay = document.createElement("div");
      overlay.className = "card-preview-overlay";
      preview.appendChild(overlay);
    } else {
      const iconEl = document.createElement("div");
      iconEl.className = "card-preview-icon";
      iconEl.textContent = item.icon || "\u25C9";
      preview.appendChild(iconEl);
    }
    card.appendChild(preview);

    // Body
    const body = document.createElement("div");
    body.className = "card-body";

    const typeBadge = {surface:"",theme:"Theme",renderer:"Renderer",overlay:"Overlay"}[item.type] || "";

    body.innerHTML = `
      ${item.icon ? '<span class="card-icon">' + item.icon + '</span>' : ''}
      <div class="card-title">${escapeHtml(item.title)}</div>
      <div class="card-description">${escapeHtml(item.description)}</div>
      ${typeBadge ? '<div class="explore-badge">' + typeBadge + '</div>' : ''}
    `;

    const installBtn = document.createElement("button");
    installBtn.className = "install-btn";
    installBtn.textContent = item.type === "theme" ? "Apply" : item.type === "renderer" ? "Apply" : item.type === "overlay" ? "Apply" : "Install";
    installBtn.onclick = async (e) => {
      e.stopPropagation();
      installBtn.disabled = true;
      installBtn.textContent = "...";
      const res = await fetch("/marketplace/" + item.id + "/install", { method: "POST" });
      const data = await res.json();
      if (data.action === "exists") {
        installBtn.textContent = "Installed";
        installBtn.classList.add("installed");
      } else if (data.action === "installed") {
        installBtn.textContent = "Installed ✓";
        installBtn.classList.add("installed");
      } else if (data.action === "applied") {
        installBtn.textContent = "Applied ✓";
        installBtn.classList.add("installed");
        // Refresh config for themes/renderers
        const cfg = await fetch("/display/config").then(r => r.json());
        applyTheme(cfg);
        if (data.type === "renderer") {
          setTimeout(() => navigate("/"), 500);
        }
      }
    };
    body.appendChild(installBtn);
    card.appendChild(body);
    grid.appendChild(card);
  });
}

// ── Main Render ──

async function render() {
  const route = getRoute();
  if (route.view === "surface") {
    await renderSurface(route.id);
  } else if (route.view === "explore" && features.marketplace) {
    await renderExplore();
  } else if (route.view === "explore") {
    navigate("/");
    return;
  } else {
    const res = await fetch("/surfaces");
    surfaces = await res.json();
    const full = await Promise.all(
      surfaces.map((s) => fetch("/surfaces/" + s.id).then((r) => r.json()))
    );
    surfaces = full;
    renderGrid();
  }
  reportPresence();
}

// ── Init ──

Promise.all([
  fetch("/display/config").then((r) => r.json()).catch(() => ({})),
  fetch("/display/features").then((r) => r.json()).catch(() => ({ marketplace: false })),
])
  .then(([config, feats]) => {
    features = { marketplace: false, ...feats };
    applyTheme(config);
    return render();
  })
  .catch(() => render());

window.addEventListener("resize", () => reportPresence());
