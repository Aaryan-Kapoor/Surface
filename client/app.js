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
  "Surface me a pomodoro",
  "Put today's weather on my surface",
  "Surface me a snake game",
  "a meditation guide",
  "Surface me a 7-minute workout",
  "a bill-split calculator",
  "Put today's headlines on my surface",
  "the chord progression to wonderwall",
  "Surface me a habit tracker",
  "an ascii art cat",
  "Surface a breathing circle",
  "Put a flashcard deck for biology on my surface",
  "Surface me a kanban board",
  "a recipe for tonight's dinner",
];

// Typewriter cycle: type-in → hold → type-out → next. Letters print at
// 38ms each, hold 2400ms, delete at 24ms each, 250ms pause between.
let emptySuggestionT = null;
function cycleEmptySuggestions(root) {
  if (emptySuggestionT) { clearTimeout(emptySuggestionT); emptySuggestionT = null; }
  const slot = root.querySelector(".empty-suggestion-text");
  if (!slot) return;
  let i = Math.floor(Math.random() * EMPTY_SUGGESTIONS.length);

  const step = (phase, text, charPos) => {
    // Stop when the slot has been removed from the document. We can't
    // use `body.contains(slot)` here because the very first call runs
    // while the container is still detached (renderGrid attaches it
    // a few lines later); `isConnected` would short-circuit then.
    if (!slot.parentNode) return;
    if (phase === "type-in") {
      slot.textContent = text.slice(0, charPos);
      if (charPos < text.length) {
        emptySuggestionT = setTimeout(() => step("type-in", text, charPos + 1), 38 + Math.random() * 24);
      } else {
        emptySuggestionT = setTimeout(() => step("hold", text, charPos), 2400);
      }
    } else if (phase === "hold") {
      emptySuggestionT = setTimeout(() => step("type-out", text, text.length), 0);
    } else if (phase === "type-out") {
      slot.textContent = text.slice(0, charPos);
      if (charPos > 0) {
        emptySuggestionT = setTimeout(() => step("type-out", text, charPos - 1), 24);
      } else {
        i = (i + 1) % EMPTY_SUGGESTIONS.length;
        // Seed the first character of the next suggestion immediately so
        // the line never sits empty between cycles.
        slot.textContent = EMPTY_SUGGESTIONS[i].slice(0, 1);
        emptySuggestionT = setTimeout(() => step("type-in", EMPTY_SUGGESTIONS[i], 2), 120);
      }
    }
  };
  // Seed the first character of the first suggestion immediately too.
  step("type-in", EMPTY_SUGGESTIONS[i], 1);
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

// ── Clipboard helper ──
// async Clipboard API first; falls back to a hidden-textarea +
// document.execCommand("copy") so non-secure contexts still get a real
// auto-copy without forcing the user to ⌘C themselves.

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}

// ── Tutorial modal ──
// The "Take the tour" button on the empty state opens this. It hands
// the user a copy-pasteable prompt that activates their agent's
// tutorial-walkthrough flow (defined in docs/TUTORIAL.md and gated by
// INSTALL_FOR_AGENTS.md). Surface itself does not run the tutorial —
// the agent does — so the modal is intentionally just a prompt + copy.

const TUTORIAL_PROMPT =
  "Walk me through the Surface tutorial in docs/TUTORIAL.md. Update the tutorial state in INSTALL_FOR_AGENTS.md as you progress.";

function showTutorialModal() {
  // Don't double-open
  if (document.getElementById("tutorial-modal")) return;

  const overlay = document.createElement("div");
  overlay.id = "tutorial-modal";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="tutorial-title">
      <button type="button" class="modal-close" aria-label="Close">×</button>
      <div class="modal-eyebrow">Tutorial</div>
      <h2 id="tutorial-title" class="modal-title">Hand this to your agent</h2>
      <p class="modal-lede">Surface doesn't run the tour itself — your agent does. Paste the prompt below into your agent's chat and it will walk you through the five-minute tour.</p>
      <pre class="modal-prompt" id="tutorial-prompt-text">${escapeHtml(TUTORIAL_PROMPT)}</pre>
      <div class="modal-actions">
        <button type="button" class="modal-copy-btn" id="tutorial-copy-btn">
          <span class="modal-copy-glyph" aria-hidden="true"></span>
          Copy prompt
        </button>
      </div>
      <div class="modal-sub">After running, your agent updates <span class="modal-mono">INSTALL_FOR_AGENTS.md</span> so re-runs skip the tour.</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.classList.remove("modal-overlay--visible");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  const copyBtn = overlay.querySelector("#tutorial-copy-btn");
  const setBtnLabel = (label, done) => {
    copyBtn.innerHTML = `<span class="modal-copy-glyph" aria-hidden="true"></span>${escapeHtml(label)}`;
    copyBtn.classList.toggle("modal-copy-btn--done", !!done);
  };
  copyBtn.addEventListener("click", async () => {
    const ok = await copyToClipboard(TUTORIAL_PROMPT);
    setBtnLabel(ok ? "Copied" : "Copy failed", ok);
    setTimeout(() => setBtnLabel("Copy prompt", false), 2200);
  });

  requestAnimationFrame(() => overlay.classList.add("modal-overlay--visible"));
}

// Make available to inline onclick attributes
window.showTutorialModal = showTutorialModal;

// ── Surface-idea portal ──
// A giant white circle on the right of the empty state, cycling
// through evocative one-line surface ideas. Clicking opens a modal
// with a fleshed-out prompt the user can hand to their agent.

// Each idea has a `src` field — URL of a real surface served from
// /demos/ (the server serves the `surfaces/` directory there). The
// portal iframe loads it directly via src; the demos are real, not
// hand-stubbed. Clicking the disc opens the prompt-modal that shows
// the user-voice prompt that produced the surface.

const SURFACE_IDEAS = [
  {
    title: "Yatch Problem · YouTube",
    sub: "ThePrimeTimeagen",
    src: "/demos/yatch-problem.html",
    prompt: "Surface Yatch Problem by ThePrimeTimeagen",
  },
  {
    title: "Never Gonna Give You Up · Spotify",
    sub: "Rick Astley",
    src: "/demos/spotify-rickroll.html",
    prompt: "Surface Never Gonna Give You Up by Rick Astley",
  },
  {
    title: "Apple Park · Google Maps",
    sub: "Cupertino, California",
    src: "/demos/maps-apple-park.html",
    prompt: "Surface Apple Park on Google Maps",
  },
  {
    title: "Thariq · X",
    sub: "@trq212",
    src: "/demos/tweet-trq212.html",
    prompt: "Surface this post from @trq212 on X",
  },
  {
    title: "Pac-Man",
    sub: "1980 · Namco",
    src: "/demos/pacman.html",
    prompt: "Surface a game of Pac-Man",
  },
  {
    title: "Astronaut · 3D",
    sub: "Drag to rotate",
    src: "/demos/3d-astronaut.html",
    prompt: "Surface a rotating 3D astronaut",
  },
  {
    title: "Wind · Windy",
    sub: "Live atmospheric currents",
    src: "/demos/windy-globe.html",
    prompt: "Surface live wind currents on Windy",
  },
];

function mountGallery(root) {
  const portal = root.querySelector(".empty-portal");
  if (!portal) return;
  const track = portal.querySelector(".portal-track");
  if (!track) return;

  const cardHTML = (idea) => `
    <div class="portal-card">
      <div class="portal-disc">
        <iframe class="portal-demo" tabindex="-1" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture; clipboard-write" src="${escapeHtml(idea.src)}"></iframe>
      </div>
      <div class="portal-meta">
        <div class="portal-label">A surface you could make</div>
        <div class="portal-title">${escapeHtml(idea.title)}</div>
        <div class="portal-sub">${escapeHtml(idea.sub)}</div>
        <button type="button" class="portal-prompt" aria-label="Copy prompt">
          <span class="portal-prompt-arrow">›</span>
          <span class="portal-prompt-text">${escapeHtml(idea.prompt)}</span>
        </button>
      </div>
    </div>
  `;

  const cards = SURFACE_IDEAS.map(cardHTML).join("");
  track.innerHTML = cards + cards;

  const doubled = [...SURFACE_IDEAS, ...SURFACE_IDEAS];
  track.querySelectorAll(".portal-prompt").forEach((btn, i) => {
    const prompt = doubled[i].prompt;
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const textEl = btn.querySelector(".portal-prompt-text");
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = prompt;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch {}
        ta.remove();
      }
      const orig = textEl.textContent;
      textEl.textContent = "copied";
      btn.classList.add("portal-prompt--copied");
      setTimeout(() => {
        if (textEl.textContent === "copied") textEl.textContent = orig;
        btn.classList.remove("portal-prompt--copied");
      }, 1100);
    });
  });

  // Revolve via RAF with damped velocity so hover/unhover eases in and out
  // rather than snapping (animation-play-state has no transition).
  let position = 0;
  let velocity = 0;
  let baseSpeed = 0;
  let targetVel = 0;
  let hovering = false;
  let halfHeight = 0;
  let lastTime = 0;
  let manualOverride = false;
  let resumeTimer = null;
  const FULL_CYCLE_MS = 96000;
  const DECAY_PER_SEC = 7;
  const RESUME_DELAY_MS = 2500;

  const scrollbar = root.querySelector(".portal-scrollbar");
  const thumb = root.querySelector(".portal-scrollbar-thumb");
  const rail = root.querySelector(".portal-scrollbar-rail");

  const measure = () => {
    halfHeight = track.scrollHeight / 2;
    baseSpeed = halfHeight > 0 ? -halfHeight / FULL_CYCLE_MS : 0;
    targetVel = hovering ? 0 : baseSpeed;
  };
  setTimeout(measure, 250);
  window.addEventListener("resize", measure);

  const wrap = (p) => {
    if (!halfHeight) return p;
    if (p <= -halfHeight) return p + halfHeight;
    if (p > 0) return p - halfHeight;
    return p;
  };

  const updateThumb = () => {
    if (!scrollbar || !thumb || halfHeight <= 0) return;
    let p = (-position) / halfHeight;
    p = ((p % 1) + 1) % 1;
    const railH = scrollbar.offsetHeight;
    const thumbH = thumb.offsetHeight;
    thumb.style.top = (p * Math.max(0, railH - thumbH)) + "px";
  };

  const scheduleResume = () => {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { manualOverride = false; resumeTimer = null; }, RESUME_DELAY_MS);
  };

  const tick = (now) => {
    if (!track.isConnected) return;
    const dt = lastTime ? Math.min(now - lastTime, 50) : 16;
    lastTime = now;
    if (!manualOverride) {
      const factor = 1 - Math.exp(-DECAY_PER_SEC * dt / 1000);
      velocity += (targetVel - velocity) * factor;
      position += velocity * dt;
      position = wrap(position);
    }
    track.style.transform = `translate3d(0, ${position}px, 0)`;
    updateThumb();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  portal.addEventListener("mouseenter", () => { hovering = true; targetVel = 0; });
  portal.addEventListener("mouseleave", () => { hovering = false; targetVel = baseSpeed; });

  // Scrollbar drag — pointer events so capture works off-thumb too
  let dragging = false;
  let dragStartY = 0;
  let dragStartPos = 0;
  if (thumb) {
    thumb.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();
      thumb.setPointerCapture(e.pointerId);
      dragging = true;
      manualOverride = true;
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      thumb.classList.add("is-dragging");
      document.body.classList.add("is-grabbing-scrollbar");
      dragStartY = e.clientY;
      dragStartPos = position;
      velocity = 0;
    });
    thumb.addEventListener("pointermove", (e) => {
      if (!dragging || !halfHeight) return;
      const railH = scrollbar.offsetHeight;
      const thumbH = thumb.offsetHeight;
      const range = Math.max(1, railH - thumbH);
      const deltaProgress = (e.clientY - dragStartY) / range;
      position = wrap(dragStartPos - deltaProgress * halfHeight);
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try { thumb.releasePointerCapture(e.pointerId); } catch {}
      thumb.classList.remove("is-dragging");
      document.body.classList.remove("is-grabbing-scrollbar");
      scheduleResume();
    };
    thumb.addEventListener("pointerup", endDrag);
    thumb.addEventListener("pointercancel", endDrag);
  }

  // Click on rail to jump-scroll to that position, then continue as a drag
  if (rail) {
    rail.addEventListener("pointerdown", (e) => {
      if (e.target === thumb) return;
      if (!halfHeight) return;
      e.preventDefault();
      manualOverride = true;
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      const rect = scrollbar.getBoundingClientRect();
      const railH = scrollbar.offsetHeight;
      const thumbH = thumb.offsetHeight;
      const range = Math.max(1, railH - thumbH);
      const clicked = Math.max(0, Math.min(range, e.clientY - rect.top - thumbH / 2));
      position = -((clicked / range) * halfHeight);
      velocity = 0;
      dragging = true;
      dragStartY = e.clientY;
      dragStartPos = position;
      thumb.setPointerCapture(e.pointerId);
      thumb.classList.add("is-dragging");
      document.body.classList.add("is-grabbing-scrollbar");
    });
  }
}

function showIdeaModal(idea) {
  if (document.getElementById("idea-modal")) return;

  const overlay = document.createElement("div");
  overlay.id = "idea-modal";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="idea-title">
      <button type="button" class="modal-close" aria-label="Close">×</button>
      <div class="modal-eyebrow">A surface you could make</div>
      <h2 id="idea-title" class="modal-title">${escapeHtml(idea.title)}</h2>
      <p class="modal-lede">${escapeHtml(idea.sub)}</p>
      <pre class="modal-prompt">${escapeHtml(idea.prompt)}</pre>
      <div class="modal-actions">
        <button type="button" class="modal-copy-btn" id="idea-copy-btn">Copy prompt</button>
      </div>
      <div class="modal-sub">Paste into your agent's chat and let it build.</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.classList.remove("modal-overlay--visible");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  const copyBtn = overlay.querySelector("#idea-copy-btn");
  const setBtnLabel = (label, done) => {
    copyBtn.textContent = label;
    copyBtn.classList.toggle("modal-copy-btn--done", !!done);
  };
  copyBtn.addEventListener("click", async () => {
    const ok = await copyToClipboard(idea.prompt);
    setBtnLabel(ok ? "Copied" : "Copy failed", ok);
    setTimeout(() => setBtnLabel("Copy prompt", false), 2200);
  });

  requestAnimationFrame(() => overlay.classList.add("modal-overlay--visible"));
}

window.showIdeaModal = showIdeaModal;

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

  // Cosmic substrate — on by default. An explicit `starfield: false`
  // from a theme hides every cosmic layer (starfield, nebulae, aurora,
  // grain, comets). Themes that want their own background opt out
  // wholesale by passing `starfield: false`.
  const substrateOn = config.starfield !== false;
  const starfield = document.getElementById("starfield");
  if (starfield) starfield.style.display = substrateOn ? "" : "none";
  document.querySelectorAll(".nebula, .aurora, .grain").forEach((el) => {
    el.style.display = substrateOn ? "" : "none";
  });

  // Optional nebula color overrides (back-compat).
  if (config.nebulaColors && config.nebulaColors.length >= 2) {
    const n1 = document.querySelector(".nebula--1");
    const n2 = document.querySelector(".nebula--2");
    if (n1) n1.style.background = `radial-gradient(circle, ${config.nebulaColors[0]}, transparent 70%)`;
    if (n2) n2.style.background = `radial-gradient(circle, ${config.nebulaColors[1]}, transparent 70%)`;
  }

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

// ── Cmd+K / Ctrl+K — quick surface finder ──

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    openSurfaceFinder();
  }
});

function openSurfaceFinder() {
  if (document.getElementById("surface-finder")) return;
  const overlay = document.createElement("div");
  overlay.id = "surface-finder";
  overlay.className = "finder-overlay";
  overlay.innerHTML = `
    <div class="finder-panel" role="dialog" aria-label="Find surface">
      <div class="finder-input-wrap">
        <input class="finder-input" type="text" placeholder="Find a surface..." autocomplete="off" spellcheck="false">
      </div>
      <div class="finder-results" role="listbox"></div>
      <div class="finder-footer">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        <span>esc close</span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("finder-overlay--visible"));

  const input = overlay.querySelector(".finder-input");
  const results = overlay.querySelector(".finder-results");
  let filtered = surfaces.slice();
  let activeIdx = 0;

  const close = () => {
    overlay.classList.remove("finder-overlay--visible");
    setTimeout(() => overlay.remove(), 250);
  };

  const renderResults = () => {
    const q = input.value.trim().toLowerCase();
    filtered = q
      ? surfaces.filter((s) => (s.title || "").toLowerCase().includes(q))
      : surfaces.slice(0, 50);
    activeIdx = 0;
    if (filtered.length === 0) {
      results.innerHTML = `<div class="finder-empty">No surfaces match "${escapeHtml(q)}"</div>`;
      return;
    }
    results.innerHTML = filtered.map((s, i) => {
      const mime = s.artifact_mime || (s.artifact && s.artifact.mime) || "";
      const sub = [];
      if (mime) sub.push(labelForMime(mime));
      const t = timeAgo(s.updated_at);
      if (t) sub.push(t);
      return `
        <div class="finder-result${i === 0 ? ' finder-result--active' : ''}" data-idx="${i}" role="option">
          <div class="finder-result-title">${escapeHtml(s.title)}</div>
          <div class="finder-result-sub">${sub.map(escapeHtml).join(' · ')}</div>
        </div>
      `;
    }).join("");
    results.querySelectorAll(".finder-result").forEach((el, i) => {
      el.addEventListener("mouseenter", () => setActive(i));
      el.addEventListener("click", () => select(i));
    });
  };

  const setActive = (i) => {
    if (filtered.length === 0) return;
    activeIdx = ((i % filtered.length) + filtered.length) % filtered.length;
    const items = results.querySelectorAll(".finder-result");
    items.forEach((el, idx) => el.classList.toggle("finder-result--active", idx === activeIdx));
    if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: "nearest" });
  };

  const select = (i) => {
    const s = filtered[i];
    if (!s) return;
    close();
    navigate("/surface/" + s.id);
  };

  input.addEventListener("input", renderResults);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === "Enter") { e.preventDefault(); select(activeIdx); }
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  renderResults();
  input.focus();
}

// ── Cosmic substrate ──
// One container holds: aurora ribbon, two/three nebulae, three star
// layers (parallax via initParallax), and a positioning surface for
// comets. The container is always inserted; an explicit theme
// `starfield: false` hides everything cosmic via display:none.

function createAurora() {
  const el = document.createElement("div");
  el.className = "aurora";
  el.id = "aurora";
  return el;
}

function createGrain() {
  const el = document.createElement("div");
  el.className = "grain";
  el.id = "grain";
  return el;
}

// Fire one comet at a random angle from offscreen-left across the
// upper third of the canvas. Throttled by `pulseSpace`.
function fireComet() {
  const starfield = document.getElementById("starfield");
  if (!starfield || starfield.style.display === "none") return;
  const c = document.createElement("div");
  c.className = "comet";
  const y = 8 + Math.random() * 38;
  const angle = 12 + Math.random() * 14;
  c.style.setProperty("--cy", y + "%");
  c.style.setProperty("--cx", (-5 - Math.random() * 8) + "%");
  c.style.setProperty("--angle", angle + "deg");
  starfield.appendChild(c);
  setTimeout(() => c.remove(), 1700);
}

// SSE event coupling: aurora pulses, occasionally a comet streaks.
let spacePulseT = 0;
function pulseSpace(opts) {
  const starfield = document.getElementById("starfield");
  if (!starfield) return;
  if (Date.now() - spacePulseT < 450) return; // throttle
  spacePulseT = Date.now();
  starfield.classList.remove("aurora-burst");
  void starfield.offsetWidth; // reflow to restart aurora animation
  starfield.classList.add("aurora-burst");
  setTimeout(() => starfield.classList.remove("aurora-burst"), 1500);
  // Comet on bigger events (creates, theme changes) — not on every tick.
  if (opts && opts.comet) fireComet();
}

// Background comet shower — one streak every 22-52s when the tab is
// visible. The cosmos isn't static, just patient.
let cometShowerT = null;
function startCometShower() {
  if (cometShowerT) clearTimeout(cometShowerT);
  const tick = () => {
    if (document.visibilityState === "visible") fireComet();
    cometShowerT = setTimeout(tick, 22000 + Math.random() * 30000);
  };
  cometShowerT = setTimeout(tick, 6000 + Math.random() * 8000);
}

// ── Starfield (3 parallax layers) — always on, themes opt out ──

function createStarfield() {
  const el = document.createElement("div");
  el.className = "starfield";
  el.id = "starfield";

  // Aurora goes inside so it benefits from the same z=0 stacking +
  // can be color-pulsed by toggling .aurora-burst on the parent.
  el.appendChild(createAurora());

  const layers = [
    { class: "star--far",  count: 110, parallax: 0.008 },
    { class: "star--mid",  count: 55,  parallax: 0.022 },
    { class: "star--near", count: 18,  parallax: 0.048 },
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

  // Cosmic substrate is on by default. Themes that set
  // `starfield: false` hide the whole stack (applyTheme handles it).
  if (displayConfig.starfield === false) el.style.display = "none";

  return el;
}

function createNebulae() {
  const frag = document.createDocumentFragment();
  const n1 = document.createElement("div");
  n1.className = "nebula nebula--1";
  const n2 = document.createElement("div");
  n2.className = "nebula nebula--2";
  const n3 = document.createElement("div");
  n3.className = "nebula nebula--3";

  if (displayConfig.nebulaColors && displayConfig.nebulaColors.length >= 2) {
    n1.style.background = `radial-gradient(circle, ${displayConfig.nebulaColors[0]}, transparent 70%)`;
    n2.style.background = `radial-gradient(circle, ${displayConfig.nebulaColors[1]}, transparent 70%)`;
  }

  if (displayConfig.starfield === false) {
    n1.style.display = "none";
    n2.style.display = "none";
    n3.style.display = "none";
  }

  frag.appendChild(n1);
  frag.appendChild(n2);
  frag.appendChild(n3);
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

// Card tilt-to-pointer — 3D rotateX/Y based on pointer position within
// the card bounds. Clamped to ±3.2deg. Resets on mouseleave.
function bindCardTilt(card) {
  card.addEventListener("mousemove", (e) => {
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;   // -0.5..0.5
    const py = (e.clientY - r.top)  / r.height - 0.5;
    const rx = +(px * 6.4).toFixed(2);  // rotateY
    const ry = +(-py * 4.2).toFixed(2); // rotateX (inverted)
    card.style.setProperty("--rx", rx + "deg");
    card.style.setProperty("--ry", ry + "deg");
    card.classList.add("tilt");
  });
  card.addEventListener("mouseleave", () => {
    card.classList.remove("tilt");
    card.style.setProperty("--rx", "0deg");
    card.style.setProperty("--ry", "0deg");
  });
}

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
  container.appendChild(createStarfield());
  container.appendChild(createNebulae());
  container.appendChild(createGrain());
  startCometShower();

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
      <div class="grid-subtitle">a universal display for your agents</div>
    </div>
    <div class="grid-meta" id="grid-meta">
      ${count > 0 ? `<span class="grid-meta-count">${escapeHtml(countLabel)}</span>` : ""}
      <span class="grid-meta-live">station</span>
    </div>
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
      <div class="empty-text">
        <div class="empty-prompt">What should I make?</div>
        <div class="empty-suggestions">
          <span class="empty-suggestion-arrow">›</span><span class="empty-suggestion-text"></span>
        </div>
        <div class="empty-sub">tell your agent</div>
        <button type="button" class="empty-tour-btn" onclick="showTutorialModal()">Start Tutorial</button>
      </div>
      <div class="empty-portal" id="empty-portal">
        <div class="portal-gallery">
          <div class="portal-track"></div>
        </div>
      </div>
      <div class="portal-scrollbar" aria-hidden="true">
        <div class="portal-scrollbar-rail"></div>
        <div class="portal-scrollbar-thumb"></div>
      </div>
    `;
    container.appendChild(empty);
    cycleEmptySuggestions(empty);
    mountGallery(empty);
  } else {
    const toolbar = createGridToolbar();
    gridView.appendChild(toolbar);

    const grid = document.createElement("div");
    grid.className = "grid";
    grid.id = "surface-grid";
    gridView.appendChild(grid);
    paintGrid(grid);
  }

  container.appendChild(gridView);
  app.innerHTML = "";
  app.appendChild(container);

  // Re-apply theme to newly created elements
  applyTheme(displayConfig);

  connectGlobalSSE();
}

// ── Grid filter / sort state ──

let gridQuery = "";
let gridSort = "newest";
let gridFilter = "all";

const FILTER_GROUPS = [
  { id: "all",   label: "All",   match: () => true },
  { id: "html",  label: "HTML",  match: (m) => m === "text/html" || m === "" },
  { id: "video", label: "Video", match: (m) => m.startsWith("video/") },
  { id: "audio", label: "Audio", match: (m) => m.startsWith("audio/") },
  { id: "image", label: "Image", match: (m) => m.startsWith("image/") },
  { id: "other", label: "Other", match: (m) => !(m === "text/html" || m === "" || m.startsWith("video/") || m.startsWith("audio/") || m.startsWith("image/")) },
];

function createGridToolbar() {
  const bar = document.createElement("div");
  bar.className = "grid-toolbar";
  bar.innerHTML = `
    <div class="grid-toolbar-left">
      <input type="text" class="grid-search" placeholder="Search…" value="${escapeHtml(gridQuery)}" spellcheck="false" autocomplete="off">
      ${FILTER_GROUPS.map((f) => `
        <button type="button" class="grid-chip${f.id === gridFilter ? " grid-chip--active" : ""}" data-filter="${f.id}">${escapeHtml(f.label)}</button>
      `).join("")}
    </div>
    <select class="grid-sort" aria-label="Sort">
      <option value="newest"${gridSort === "newest" ? " selected" : ""}>Newest</option>
      <option value="oldest"${gridSort === "oldest" ? " selected" : ""}>Oldest</option>
      <option value="az"${gridSort === "az" ? " selected" : ""}>A–Z</option>
      <option value="za"${gridSort === "za" ? " selected" : ""}>Z–A</option>
    </select>
  `;
  const search = bar.querySelector(".grid-search");
  search.addEventListener("input", () => { gridQuery = search.value; paintGrid(); });
  bar.querySelectorAll(".grid-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      gridFilter = btn.dataset.filter;
      bar.querySelectorAll(".grid-chip").forEach((b) => b.classList.toggle("grid-chip--active", b === btn));
      paintGrid();
    });
  });
  bar.querySelector(".grid-sort").addEventListener("change", (e) => { gridSort = e.target.value; paintGrid(); });
  return bar;
}

function applyGridFilters(list) {
  const q = gridQuery.trim().toLowerCase();
  const matcher = (FILTER_GROUPS.find((f) => f.id === gridFilter) || FILTER_GROUPS[0]).match;
  let out = list.filter((s) => {
    const mime = s.artifact_mime || (s.artifact && s.artifact.mime) || "";
    if (!matcher(mime)) return false;
    if (q && !(s.title || "").toLowerCase().includes(q)) return false;
    return true;
  });
  const ts = (s) => new Date((s.updated_at || s.created_at || "1970-01-01") + "Z").getTime();
  const cmp = {
    newest: (a, b) => ts(b) - ts(a),
    oldest: (a, b) => ts(a) - ts(b),
    az:     (a, b) => (a.title || "").localeCompare(b.title || ""),
    za:     (a, b) => (b.title || "").localeCompare(a.title || ""),
  }[gridSort] || (() => 0);
  out.sort(cmp);
  return out;
}

function paintGrid(target) {
  const grid = target || document.getElementById("surface-grid");
  if (!grid) return;
  const visible = applyGridFilters(surfaces);
  grid.innerHTML = "";
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "grid-empty";
    empty.textContent = gridQuery ? `No surfaces match “${gridQuery}”` : "No surfaces in this filter";
    grid.appendChild(empty);
    return;
  }
  visible.forEach((s, i) => grid.appendChild(createCard(s, i)));
  updateGridMeta();
}

function createCard(s, index) {
  const meta = parseMetadata(s.metadata);
  const card = document.createElement("div");
  card.className = "surface-card";
  card.dataset.id = s.id;
  card.style.setProperty("--card-delay", ((index || 0) * 0.08) + "s");
  card.style.setProperty("--bob-delay", (-(Math.random() * 7)).toFixed(2) + "s");
  card.onclick = () => navigate("/surface/" + s.id);

  const disc = document.createElement("div");
  disc.className = "card-disc";

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
    iframe.className = "card-frame";
    iframe.sandbox = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";
    iframe.allow = "autoplay; encrypted-media; picture-in-picture; clipboard-write";
    if (s.html && s.html.length < 8000 && !hasExternalScripts) {
      iframe.srcdoc = s.html;
    } else {
      iframe.src = previewUrl;
    }
    iframe.tabIndex = -1;
    iframe.loading = "lazy";
    disc.appendChild(iframe);
  } else {
    const iconEl = document.createElement("div");
    iconEl.className = "card-disc-icon";
    iconEl.textContent = meta.icon || iconForMime(mime);
    disc.appendChild(iconEl);
  }

  if (s.updated_at) {
    const ageMs = Date.now() - new Date(s.updated_at + "Z").getTime();
    if (ageMs < 60000) {
      const live = document.createElement("div");
      live.className = "card-live";
      live.textContent = "live";
      disc.appendChild(live);
    }
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.innerHTML = `
    <button type="button" class="card-action" data-action="copy" title="Copy link" aria-label="Copy link">${ICON_COPY}</button>
    <button type="button" class="card-action" data-action="rename" title="Rename" aria-label="Rename">${ICON_PENCIL}</button>
    <button type="button" class="card-action card-action--danger" data-action="delete" title="Delete" aria-label="Delete">${ICON_X}</button>
  `;
  actions.addEventListener("click", (e) => e.stopPropagation());
  actions.querySelector('[data-action="copy"]').addEventListener("click", async () => {
    const ok = await copyToClipboard(location.origin + "/surface/" + s.id);
    if (ok) showToast("Link copied");
  });
  actions.querySelector('[data-action="rename"]').addEventListener("click", () => {
    startRename(card, s.id);
  });
  actions.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    if (!confirm(`Delete "${s.title}"?`)) return;
    const res = await fetch("/artifacts/" + s.id, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || "Failed to delete", 3000, "error");
    }
  });
  disc.appendChild(actions);
  card.appendChild(disc);

  const body = document.createElement("div");
  body.className = "card-body";
  const subParts = [];
  if (mime) subParts.push(labelForMime(mime));
  const t = timeAgo(s.updated_at);
  if (t) subParts.push(t);
  body.innerHTML = `
    <div class="card-title">${escapeHtml(s.title)}</div>
    <div class="card-sub">${subParts.map(escapeHtml).join(" · ")}</div>
  `;
  card.appendChild(body);

  return card;
}

const ICON_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_PENCIL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

function startRename(card, id) {
  const titleEl = card.querySelector(".card-title");
  if (!titleEl || titleEl.tagName === "INPUT") return;
  const originalTitle = titleEl.textContent;
  const input = document.createElement("input");
  input.className = "card-title";
  input.type = "text";
  input.value = originalTitle;
  input.maxLength = 200;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finalize = (newText) => {
    if (settled) return;
    settled = true;
    const span = document.createElement("div");
    span.className = "card-title";
    span.textContent = newText;
    input.replaceWith(span);
  };
  const save = async () => {
    const newTitle = input.value.trim();
    if (!newTitle || newTitle === originalTitle) {
      finalize(originalTitle);
      return;
    }
    finalize(newTitle);
    const res = await fetch("/artifacts/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle }),
    });
    if (!res.ok) {
      showToast("Failed to rename", 3000, "error");
      const span = card.querySelector(".card-title");
      if (span) span.textContent = originalTitle;
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    else if (e.key === "Escape") { e.preventDefault(); finalize(originalTitle); }
  });
  input.addEventListener("blur", save);
  input.addEventListener("click", (e) => e.stopPropagation());
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

  // Connection state → "STATION" indicator in the grid header.
  const setOnline = (on) => {
    const meta = document.getElementById("grid-meta");
    if (meta) meta.classList.toggle("online", on);
  };
  globalSSE.addEventListener("open", () => setOnline(true));
  globalSSE.onopen = () => setOnline(true);
  globalSSE.onerror = () => setOnline(false);
  // EventSource is open as soon as it's instantiated and the
  // browser has the connection — set online optimistically.
  setTimeout(() => {
    if (globalSSE && globalSSE.readyState === 1) setOnline(true);
  }, 200);

  globalSSE.addEventListener("surface_created", (e) => {
    const data = JSON.parse(e.data);
    pulseSpace({ comet: true });
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
    pulseSpace();
    const idx = surfaces.findIndex((s) => s.id === data.id);
    // A flip to metadata.hidden = true (e.g. via `surface clear-demos`) is the
    // signal to remove the card from view without deleting the artifact.
    let nextMeta = {};
    try { nextMeta = typeof data.metadata === "string" ? JSON.parse(data.metadata) : (data.metadata || {}); } catch {}
    const becameHidden = nextMeta && nextMeta.hidden === true;
    if (becameHidden) {
      if (idx !== -1) surfaces.splice(idx, 1);
      const card = document.querySelector(`.surface-card[data-id="${data.id}"]`);
      if (card) {
        card.classList.add("removing");
        card.addEventListener("animationend", () => {
          card.remove();
          updateGridMeta();
          if (surfaces.length === 0) render();
        }, { once: true });
        setTimeout(() => { if (card.isConnected) { card.remove(); updateGridMeta(); if (surfaces.length === 0) render(); } }, 600);
      }
      return;
    }
    // Un-hide path: surface_updated arrives for a row we don't have in view.
    // Re-fetch and treat it like a fresh creation so the card reappears.
    if (idx === -1) {
      fetch("/surfaces/" + data.id).then((r) => r.ok ? r.json() : null).then((full) => {
        if (!full) return;
        surfaces.unshift(full);
        if (document.querySelector(".empty-state")) { render(); return; }
        const grid = document.getElementById("surface-grid");
        if (grid && !grid.querySelector(`.surface-card[data-id="${full.id}"]`)) {
          grid.prepend(createCard(full, 0));
          updateGridMeta();
        }
      });
      return;
    }
    if (idx !== -1) {
      surfaces[idx] = { ...surfaces[idx], ...data };
      const card = document.querySelector(`.surface-card[data-id="${data.id}"]`);
      if (card) {
        const titleEl = card.querySelector(".card-title");
        if (titleEl) titleEl.textContent = data.title || surfaces[idx].title;
        const subEl = card.querySelector(".card-sub");
        if (subEl) {
          const mime = data.artifact_mime || surfaces[idx].artifact_mime || "";
          const parts = [];
          if (mime) parts.push(labelForMime(mime));
          const t = timeAgo(data.updated_at);
          if (t) parts.push(t);
          subEl.textContent = parts.join(" · ");
        }
        let live = card.querySelector(".card-live");
        if (!live) {
          live = document.createElement("div");
          live.className = "card-live";
          live.textContent = "live";
          const disc = card.querySelector(".card-disc");
          if (disc) disc.appendChild(live);
        }
        setTimeout(() => {
          const stillThere = card.querySelector(".card-live");
          if (stillThere) stillThere.remove();
        }, 60000);
      }
    }
  });

  globalSSE.addEventListener("surface_deleted", (e) => {
    const data = JSON.parse(e.data);
    pulseSpace();
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
    pulseSpace();
  });

  globalSSE.addEventListener("display_theme", (e) => {
    const prev = displayConfig.renderer;
    const data = JSON.parse(e.data);
    applyTheme(data);
    pulseSpace();
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
  container.appendChild(createStarfield());
  container.appendChild(createNebulae());
  container.appendChild(createGrain());

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
    bindCardTilt(card);

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
