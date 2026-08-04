const app = document.getElementById("app");
let surfaces = [];
let globalSSE = null;
let currentSurfaceId = null;
let displayConfig = {};
let renderFailed = false;
const surfaceHostSubscribers = new Map();
// Display slots are artifacts (metadata.display_role) — ids resolved by the
// server at GET /display/slots.
let displaySlots = { renderer: null, home: null, overlay: null };
// Origin that device-authored surfaces are embedded from (the untrusted content
// plane). Set at boot from /display/config; empty = same origin.
let contentOrigin = "";

// Where a surface's view iframe loads from. Device-authored content must never
// run on the trusted app origin (its JS would inherit system), so it is embedded
// from the content origin; system content loads same-origin. Returns null when a
// device surface has no content origin available, so the caller fails closed with
// a placeholder instead of silently falling back to the trusted origin.
function surfaceFrameSrc(fromDevicePlane, contentOrigin, viewPath) {
  if (fromDevicePlane) return contentOrigin ? contentOrigin + viewPath : null;
  return viewPath;
}

function versionSurfaceViewPath(viewPath, version) {
  const separator = viewPath.includes("?") ? "&" : "?";
  return viewPath + separator + "v=" + encodeURIComponent(String(version));
}

function shouldRenderSurfaceCreated(routeView, hasGrid) {
  return routeView === "grid" && !hasGrid;
}

function surfaceEventId(data) {
  return data && (data.surface_id || data.id);
}

function publishSurfaceHostEvent(name, data) {
  const id = surfaceEventId(data);
  if (!id) return;
  const subscribers = surfaceHostSubscribers.get(id);
  if (!subscribers) return;
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(name, data);
    } catch {
      subscribers.delete(subscriber);
    }
  }
  if (subscribers.size === 0) surfaceHostSubscribers.delete(id);
}

// Same-origin surface iframes share the PWA's global SSE stream. Cross-origin
// device content cannot access this function and retains its own content-plane
// stream, preserving the trust boundary while avoiding three app-origin
// EventSource connections for every open Surface.
window.__surfaceHostSubscribe = (surfaceId, subscriber) => {
  if (typeof subscriber !== "function") return () => {};
  let subscribers = surfaceHostSubscribers.get(surfaceId);
  if (!subscribers) {
    subscribers = new Set();
    surfaceHostSubscribers.set(surfaceId, subscribers);
  }
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) surfaceHostSubscribers.delete(surfaceId);
  };
};

async function refreshSlots() {
  try {
    const next = await fetch("/display/slots").then((r) => r.json());
    const changed = ["renderer", "home", "overlay"].filter((k) => displaySlots[k] !== next[k]);
    displaySlots = next;
    if (changed.includes("overlay")) renderOverlay();
    if (changed.includes("renderer") || changed.includes("home")) render();
    return changed.length > 0;
  } catch {
    return false;
  }
}

// A surface event may have promoted/demoted a slot artifact.
function maybeRefreshSlots(cardOrId) {
  const id = typeof cardOrId === "string" ? cardOrId : cardOrId && cardOrId.id;
  const meta = typeof cardOrId === "object" ? parseMetadata(cardOrId.metadata) : {};
  const isSlotNow = meta && meta.display_role;
  const wasSlot = id && (displaySlots.renderer === id || displaySlots.home === id || displaySlots.overlay === id);
  if (isSlotNow || wasSlot) refreshSlots();
}

// ── postMessage bridge (iframe → server) ──

window.addEventListener("message", (e) => {
  if (!e.data) return;
  // Only honor messages from our own (app) origin. Device-authored surfaces
  // render on the content origin and post their actions directly to that origin
  // (surface.js), so they must never reach the trusted bridge here.
  if (e.origin !== location.origin) return;

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
  const surfaceId = e.data.surface_id || currentSurfaceId;
  if (!surfaceId) return;

  fetch(`/artifacts/${encodeURIComponent(surfaceId)}/actions`, {
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

// ── Release notice + one-click update ──
//
// The server answers GET /api/update/status from a cache only (it never blocks
// on the npm registry), pushes `update_status` over SSE, and applies an update
// by running the ordinary `surface upgrade` converger. The service restarts
// mid-flight, so this side is written around losing its own connection: every
// phase transition is idempotent, the "restarting" phase starts a bounded
// reconnect watch, and the result is read back from the server after it
// returns rather than guessed here.

let updateState = null;        // last /api/update/status payload
let updateWatchTimer = null;   // bounded poll while a run is in flight
let updateWatchDeadline = 0;
let updateVersionAtStart = null; // version when Update was clicked → reload once it changes
const UPDATE_WATCH_MS = 120000;
const UPDATE_SEEN_KEY = "surface:update-seen";

function updateSeen(run) {
  if (!run || !run.started_at) return false;
  try { return localStorage.getItem(UPDATE_SEEN_KEY) === run.started_at; } catch { return false; }
}

function markUpdateSeen(run) {
  if (!run || !run.started_at) return;
  try { localStorage.setItem(UPDATE_SEEN_KEY, run.started_at); } catch {}
  paintUpdateNotice();
}

// One place decides what the pill says, so the DOM code stays dumb.
// Returns null when there is nothing worth saying.
function updateNoticeModel(s) {
  if (!s) return null;
  const run = s.run;
  const running = run && run.phase !== "done" && run.phase !== "failed";
  if (running) {
    const label = run.phase === "restarting"
      ? "Restarting Surface…"
      : run.phase === "installing"
        ? `Installing ${run.to || ""}…`.replace("  ", " ")
        : "Checking for updates…";
    return { tone: "busy", text: label };
  }
  if (run && run.phase === "failed" && !updateSeen(run)) {
    return { tone: "error", text: `Update failed — ${run.error || "see the host log"}`, dismiss: run };
  }
  if (run && run.phase === "done" && !updateSeen(run)) {
    return { tone: "done", text: `Updated to ${run.installed || s.current}`, dismiss: run, autoDismiss: true };
  }
  if (!s.update_available || !s.latest) return null;
  // With the Update button beside it there is no room for "available" on a
  // phone header — and the button already says what the pill is for.
  if (s.can_apply) return { tone: "available", text: `Surface ${s.latest}`, action: "Update" };
  // Honest read-only state: a repo clone, a project-local install, or a paired
  // display, none of which may trigger an npm install here.
  return { tone: "available", text: `Surface ${s.latest} available`, hint: s.apply_blocked_reason || s.advice };
}

function paintUpdateNotice() {
  const host = document.getElementById("update-notice");
  if (!host) return;
  const model = updateNoticeModel(updateState);
  if (!model) { host.hidden = true; host.replaceChildren(); return; }
  host.hidden = false;
  host.className = `update-notice update-notice--${model.tone}`;
  // Built with DOM APIs, not a template: the text carries server-side error
  // strings and the hint carries `apply_blocked_reason` — neither is markup.
  host.replaceChildren();
  const text = document.createElement("span");
  text.className = "update-notice-text";
  text.textContent = model.text;
  host.appendChild(text);
  let btn = null;
  if (model.action) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "update-notice-btn";
    btn.setAttribute("data-update-apply", "");
    btn.textContent = model.action;
    host.appendChild(btn);
  }
  let x = null;
  if (model.dismiss) {
    x = document.createElement("button");
    x.type = "button";
    x.className = "update-notice-x";
    x.setAttribute("data-update-dismiss", "");
    x.setAttribute("aria-label", "Dismiss");
    x.textContent = "×";
    host.appendChild(x);
  }
  if (model.hint) host.title = model.hint;
  else host.removeAttribute("title");
  if (btn) btn.addEventListener("click", applyUpdate);
  if (x) x.addEventListener("click", () => markUpdateSeen(model.dismiss));
  if (model.autoDismiss) setTimeout(() => markUpdateSeen(model.dismiss), 10000);
}

async function refreshUpdateStatus() {
  try {
    const res = await fetch("/api/update/status", { cache: "no-store" });
    if (!res.ok) return null;
    applyUpdateStatus(await res.json());
    return updateState;
  } catch {
    // Offline or mid-restart — the watcher retries; nothing to report.
    return null;
  }
}

function applyUpdateStatus(next) {
  if (!next) return;
  // SSE payloads carry no per-plane fields; keep what the last GET told us.
  if (next.can_apply === undefined && updateState) {
    next.can_apply = updateState.can_apply;
    next.apply_blocked_reason = updateState.apply_blocked_reason;
  }
  updateState = next;
  const run = next.run;
  const running = run && run.phase !== "done" && run.phase !== "failed";
  if (running) watchUpdateThroughRestart();
  if (!running && updateWatchTimer) stopUpdateWatch();
  // The bundle that is running right now was replaced on disk — reload once so
  // the PWA shell matches the server that is answering it.
  if (updateVersionAtStart && run && run.phase === "done" && next.current !== updateVersionAtStart) {
    updateVersionAtStart = null;
    location.reload();
    return;
  }
  paintUpdateNotice();
}

function stopUpdateWatch() {
  if (updateWatchTimer) clearInterval(updateWatchTimer);
  updateWatchTimer = null;
}

// The process serving this page is the one being replaced, so SSE is not a
// reliable channel across the restart. Poll — but only while a run is live,
// and only for as long as a restart could plausibly take.
function watchUpdateThroughRestart() {
  updateWatchDeadline = Date.now() + UPDATE_WATCH_MS;
  if (updateWatchTimer) return;
  updateWatchTimer = setInterval(async () => {
    if (Date.now() > updateWatchDeadline) {
      stopUpdateWatch();
      updateState = {
        ...(updateState || {}),
        run: {
          phase: "failed",
          started_at: (updateState && updateState.run && updateState.run.started_at) || String(Date.now()),
          error: "Surface did not come back — check `surface service health` on the host",
        },
      };
      paintUpdateNotice();
      return;
    }
    await refreshUpdateStatus();
  }, 1500);
}

async function applyUpdate() {
  const host = document.getElementById("update-notice");
  if (host) host.className = "update-notice update-notice--busy";
  updateVersionAtStart = (updateState && updateState.current) || null;
  try {
    const res = await fetch("/api/update/apply", { method: "POST", headers: { "Content-Type": "application/json" } });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      updateVersionAtStart = null;
      showToast((body && body.error) || `Update refused (${res.status})`, 6000, "error");
      await refreshUpdateStatus();
      return;
    }
    applyUpdateStatus(body);
    watchUpdateThroughRestart();
  } catch {
    updateVersionAtStart = null;
    showToast("Could not start the update — is Surface still running?", 6000, "error");
  }
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
      <pre class="modal-prompt" id="tutorial-prompt-text">${escapeText(TUTORIAL_PROMPT)}</pre>
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
    copyBtn.innerHTML = `<span class="modal-copy-glyph" aria-hidden="true"></span>${escapeText(label)}`;
    copyBtn.classList.toggle("modal-copy-btn--done", !!done);
  };
  copyBtn.addEventListener("click", async () => {
    const ok = await copyToClipboard(TUTORIAL_PROMPT);
    setBtnLabel(ok ? "Copied" : "Copy failed", ok);
    setTimeout(() => setBtnLabel("Copy prompt", false), 2200);
  });

  requestAnimationFrame(() => overlay.classList.add("modal-overlay--visible"));
}

// Kept on window for agent-authored themes/renderers that call it. The empty
// state binds its own listener — no inline handler anywhere in this app.
window.showTutorialModal = showTutorialModal;

// ── Surface-idea portal ──
// A giant white circle on the right of the empty state, cycling
// through evocative one-line surface ideas. Clicking opens a modal
// with a fleshed-out prompt the user can hand to their agent.

// Each idea has a `src` field — URL of a real surface served from
// /demos/ (the server serves examples/demos/ there). The portal iframe
// loads it directly; `surface seed-demos` links the same files as live
// artifacts with surface.js injection.

const SURFACE_IDEAS = [
  {
    title: "Ask Approval",
    sub: "Choice → Surface.action",
    src: "/demos/ask-approval.html",
    prompt: "Surface an approval question I can answer from any display",
  },
  {
    title: "State Gauge",
    sub: "Live bound progress",
    src: "/demos/state-gauge.html",
    prompt: "Surface a live progress gauge and keep it updated with state",
  },
  {
    title: "Action Panel",
    sub: "Buttons wake the agent",
    src: "/demos/action-panel.html",
    prompt: "Surface a command panel whose buttons wake you with actions",
  },
  {
    title: "Build Stream",
    sub: "Append-only output",
    src: "/demos/stream-build.html",
    prompt: "Surface a build log that streams as the command runs",
  },
  {
    title: "Agent Board",
    sub: "Shared fleet status",
    src: "/demos/board-ops.html",
    prompt: "Surface a shared board for multiple agents working in this repo",
  },
  {
    title: "Report Brief",
    sub: "Readable long-form output",
    src: "/demos/report-brief.html",
    prompt: "Surface a polished report instead of printing a long terminal summary",
  },
  {
    title: "Linked File",
    sub: "Edit on disk, touch the display",
    src: "/demos/live-link.html",
    prompt: "Surface a linked HTML file and hot-reload it after edits",
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
        <iframe class="portal-demo" tabindex="-1" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture; clipboard-write" src="${escapeAttr(idea.src)}"></iframe>
      </div>
      <div class="portal-meta">
        <div class="portal-label">A surface you could make</div>
        <div class="portal-title">${escapeText(idea.title)}</div>
        <div class="portal-sub">${escapeText(idea.sub)}</div>
        <button type="button" class="portal-prompt" aria-label="Copy prompt">
          <span class="portal-prompt-arrow">›</span>
          <span class="portal-prompt-text">${escapeText(idea.prompt)}</span>
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
    if (!track.isConnected) {
      window.removeEventListener("resize", measure);
      if (resumeTimer) clearTimeout(resumeTimer);
      return;
    }
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

// ── Theme system ──

function jsonParse(v) {
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

// The document ships one <meta name="theme-color"> per colour scheme. An agent
// theme is scheme-agnostic, so applying one overrides both and drops the media
// query that would otherwise keep one inert — which means a reset has to put
// the originals back, or the browser/PWA chrome stays on the old theme's colour
// until a reload. Snapshot once, before anything has touched them.
let themeColorDefaults = null;

function themeColorMetas() {
  return document.querySelectorAll('meta[name="theme-color"]');
}

function snapshotThemeColorMetas() {
  if (themeColorDefaults) return;
  // Array.from: querySelectorAll answers a NodeList, which has forEach but no map.
  themeColorDefaults = Array.from(themeColorMetas(), (meta) => ({
    content: meta.getAttribute("content"),
    media: meta.getAttribute("media"),
  }));
}

function restoreThemeColorMetas() {
  if (!themeColorDefaults) return;
  const metas = themeColorMetas();
  metas.forEach((meta, i) => {
    const saved = themeColorDefaults[i];
    if (!saved) return;
    if (saved.content === null) meta.removeAttribute("content");
    else meta.setAttribute("content", saved.content);
    if (saved.media === null) meta.removeAttribute("media");
    else meta.setAttribute("media", saved.media);
  });
}

function applyTheme(config) {
  snapshotThemeColorMetas();
  if (!config || Object.keys(config).length === 0) {
    // Reset to defaults
    restoreThemeColorMetas();
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

  // CSS custom properties. `void` and `textPrimary` map onto the two tokens the
  // shell actually derives everything else from (--bg / --fg); the legacy
  // --void/--text-* names are kept so older theme CSS still resolves.
  if (config.colors && typeof config.colors === "object") {
    const map = {
      void: ["--void", "--bg"],
      glass: ["--glass", "--panel-solid"],
      glassBorder: ["--glass-border", "--line"],
      glassGlow: ["--glass-glow"],
      textPrimary: ["--text-primary", "--fg"],
      textSecondary: ["--text-secondary", "--fg-muted"],
      textGhost: ["--text-ghost", "--fg-faint"],
      accent: ["--accent"],
    };
    for (const [key, props] of Object.entries(map)) {
      if (!config.colors[key]) continue;
      for (const prop of props) root.style.setProperty(prop, config.colors[key]);
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

  // Theme colour meta — see snapshotThemeColorMetas(). A theme that names no
  // usable colour leaves the shipped tags alone (and puts them back if a
  // previous theme had overridden them), so the chrome always matches whatever
  // is actually on screen.
  const themeColor = (config.colors && config.colors.void) || config.background;
  if (themeColor && typeof themeColor === "string" && !themeColor.includes("(")) {
    themeColorMetas().forEach((meta) => {
      meta.removeAttribute("media");
      meta.setAttribute("content", themeColor);
    });
  } else {
    restoreThemeColorMetas();
  }

  // Persistent overlay (across all views) — driven by the overlay slot.
  renderOverlay();

  displayConfig = config;
}

function renderOverlay() {
  let overlay = document.getElementById("display-overlay");
  if (displaySlots.overlay) {
    if (!overlay) {
      overlay = document.createElement("iframe");
      overlay.id = "display-overlay";
      overlay.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-presentation");
      overlay.src = "/display/overlay/html";
      document.body.appendChild(overlay);
    } else {
      overlay.src = "/display/overlay/html?" + Date.now();
    }
  } else if (overlay) {
    overlay.remove();
  }
}

// ── Theme resume (re-applies after view swaps) ──

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
    return;
  }
  if (e.key === "Escape") {
    document.querySelectorAll(".surface-card.is-menu-open").forEach((el) => el.classList.remove("is-menu-open"));
  }
  // Escape leaves an open surface — but only when nothing layered (finder,
  // modal) is on screen and focus isn't inside a field.
  if (e.key === "Escape" && currentSurfaceId) {
    if (document.getElementById("surface-finder") || document.querySelector(".modal-overlay")) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    navigate("/");
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
      const none = document.createElement("div");
      none.className = "finder-empty";
      none.textContent = `No surfaces match "${q}"`;
      results.replaceChildren(none);
      return;
    }
    // Surface titles are device-authorable; they are set as text, never parsed
    // as markup.
    results.replaceChildren(...filtered.map((s, i) => {
      const mime = s.artifact_mime || (s.artifact && s.artifact.mime) || "";
      const sub = [];
      if (mime) sub.push(labelForMime(mime));
      const t = timeAgo(s.updated_at);
      if (t) sub.push(t);
      const row = document.createElement("div");
      row.className = `finder-result${i === 0 ? " finder-result--active" : ""}`;
      row.dataset.idx = String(i);
      row.setAttribute("role", "option");
      const title = document.createElement("div");
      title.className = "finder-result-title";
      title.textContent = s.title || "";
      const subEl = document.createElement("div");
      subEl.className = "finder-result-sub";
      subEl.textContent = sub.join(" · ");
      row.append(title, subEl);
      return row;
    }));
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

// ── Retired: cosmic substrate ──
// The starfield / nebulae / aurora / comet layers are gone. They were hidden by
// the shell CSS anyway, but building them cost ~180 DOM nodes on every grid
// render plus a mousemove parallax listener. These stubs keep the SSE handlers
// and older themes that call them working.

function pulseSpace() {}
function startCometShower() {}
function createStarfield() { return document.createDocumentFragment(); }
function createNebulae() { return document.createDocumentFragment(); }
function createGrain() { return document.createDocumentFragment(); }

// ── Helpers ──

function timeAgo(dateStr) {
  const parsed = parseServerDate(dateStr);
  if (!parsed) return "unknown";
  const diff = Date.now() - parsed.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  return days + "d ago";
}

function parseServerDate(value) {
  if (!value) return null;
  const raw = String(value);
  const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : raw + "Z");
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function parseMetadata(meta) {
  if (typeof meta === "string") {
    try { return JSON.parse(meta); } catch { return {}; }
  }
  return meta || {};
}

// ── HTML encoding ──
//
// Two encoders, named for the context they are safe in, because the difference
// is a security boundary and not a style choice:
//
//   escapeText  — text-node context only. Escapes & < >.
//   escapeAttr  — quoted-attribute context. Escapes & < > " ' as well.
//
// The old single escapeHtml() was `div.textContent = s; return div.innerHTML`,
// which is the browser's *text* serializer: it leaves quotes untouched. Used in
// an attribute it let a title of `" onmouseover="…` close the attribute and add
// a handler. A paired device can set a surface title and the system-plane
// dashboard renders it, so that was device content reaching system-plane script
// (and from there POST /api/update/apply, which installs and runs new code on
// the host). escapeText is deliberately NOT safe in an attribute — never reach
// for it there; test/clientRender.ts fails the build if any attribute-value
// interpolation in this file uses anything but escapeAttr/encodeURIComponent.
//
// Untrusted values should prefer DOM APIs (textContent / setAttribute) over a
// template literal entirely; these exist for the markup that is genuinely
// easier to read as a literal.

const TEXT_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const ATTR_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeText(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>]/g, (c) => TEXT_ESCAPES[c]);
}

function escapeAttr(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, (c) => ATTR_ESCAPES[c]);
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
  currentSurfaceId = null;
  resumeTheme();

  // Custom renderer — agent controls entire grid view
  if (displaySlots.renderer) {
    const iframe = document.createElement("iframe");
    iframe.id = "renderer-frame";
    iframe.src = "/display/renderer/html?" + Date.now();
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-presentation");
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
  const header = document.createElement("header");
  header.className = "grid-header";
  const count = surfaces.length;
  // The skeleton is static markup; the two values that are not (the display
  // title, which a theme sets, and whatever the user typed into the search box)
  // are written afterwards as text/properties, never interpolated.
  header.innerHTML = `
    <div class="grid-brand">
      <span class="grid-title"></span>
      <span class="grid-subtitle">state out, actions back</span>
    </div>
    <div class="grid-header-spacer"></div>
    ${count > 0 ? `
    <span class="grid-search-wrap">
      <input type="text" class="grid-search" placeholder="Search surfaces" spellcheck="false" autocomplete="off" aria-label="Search surfaces">
      <button type="button" class="grid-kbd" title="Find a surface (⌘K)" aria-label="Find a surface">⌘K</button>
    </span>` : ""}
    <div class="grid-meta" id="grid-meta">
      <span class="update-notice" id="update-notice" hidden></span>
      ${count > 0 ? `<span class="grid-meta-count">${count} ${count === 1 ? "surface" : "surfaces"}</span>` : ""}
      <span class="grid-meta-live" role="status"><span class="live-dot"></span></span>
    </div>
  `;
  header.querySelector(".grid-title").textContent = title;
  const headerSearch = header.querySelector(".grid-search");
  if (headerSearch) {
    headerSearch.value = gridQuery;
    headerSearch.addEventListener("input", () => { gridQuery = headerSearch.value; paintGrid(); });
    header.querySelector(".grid-kbd").addEventListener("click", () => openSurfaceFinder());
  }
  gridView.appendChild(header);

  // Home widget (full HTML/JS iframe on the homescreen)
  if (displaySlots.home) {
    const widget = document.createElement("iframe");
    widget.id = "home-widget";
    widget.className = "home-widget";
    widget.src = "/display/home/html";
    widget.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-presentation");
    gridView.appendChild(widget);
    // Auto-size to the widget's own content. The frame has to be collapsed
    // first: an iframe gives its document a viewport, so documentElement
    // .scrollHeight just reports back whatever height the frame already had.
    const sizeWidget = () => {
      try {
        widget.style.height = "0px";
        const doc = widget.contentDocument;
        const h = Math.max(
          doc.body ? doc.body.scrollHeight : 0,
          doc.documentElement ? doc.documentElement.scrollHeight : 0,
        );
        widget.style.height = Math.max(h, 60) + "px";
      } catch { widget.style.height = "200px"; }
    };
    widget.onload = () => {
      sizeWidget();
      // Re-measure once fonts have settled and again on resize; a widget that
      // reflows at a different width would otherwise keep the old height.
      requestAnimationFrame(sizeWidget);
      window.addEventListener("resize", sizeWidget, { passive: true });
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

  if (surfaces.length === 0 && !displaySlots.home) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="empty-text">
        <div class="empty-eyebrow">Surface is listening</div>
        <div class="empty-prompt">What should I make?</div>
        <div class="empty-suggestions">
          <span class="empty-suggestion-arrow">›</span><span class="empty-suggestion-text"></span>
        </div>
        <div class="empty-sub">Say it to your agent — it lands here.</div>
        <button type="button" class="empty-tour-btn" data-tutorial-open>Start the tutorial</button>
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
    const tourBtn = empty.querySelector("[data-tutorial-open]");
    if (tourBtn) tourBtn.addEventListener("click", showTutorialModal);
    // Inside .grid-view, not beside it: .grid-view is `position: relative;
    // z-index: 1`, so it is a stacking context and the header's z-index: 20
    // cannot escape it. An opaque empty state parked outside that context
    // painted straight over the header — hiding the release pill on exactly
    // the dashboard (fresh or just-cleared) where it matters most.
    gridView.appendChild(empty);
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

  // The sticky header only grows a rule once content passes under it. Read the
  // scroll position inside rAF so the listener never forces a synchronous
  // layout on the scroll thread.
  let scrollQueued = false;
  gridView.addEventListener("scroll", () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      gridView.classList.toggle("is-scrolled", gridView.scrollTop > 4);
    });
  }, { passive: true });

  container.appendChild(gridView);
  app.innerHTML = "";
  app.appendChild(container);

  // The header is rebuilt on every grid render; re-apply the last known
  // release status instead of re-fetching it.
  paintUpdateNotice();

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

// Only offer a filter that would actually return something. A wall of empty
// chips ("Video", "Audio") is noise on a display that holds seven HTML surfaces.
function activeFilterGroups(list) {
  const mimes = list.map((s) => s.artifact_mime || (s.artifact && s.artifact.mime) || "");
  const groups = FILTER_GROUPS.filter((f) => f.id === "all" || mimes.some((m) => f.match(m)));
  // A lone "All" chip filters nothing — drop the row entirely.
  return groups.length > 2 ? groups : [];
}

function createGridToolbar() {
  const bar = document.createElement("div");
  bar.className = "grid-toolbar";
  const groups = activeFilterGroups(surfaces);
  bar.innerHTML = `
    <div class="grid-toolbar-left" role="group" aria-label="Filter by kind">
      ${groups.map((f) => `
        <button type="button" class="grid-chip" data-filter="${escapeAttr(f.id)}" aria-pressed="${escapeAttr(String(f.id === gridFilter))}">${escapeText(f.label)}</button>
      `).join("")}
    </div>
    <select class="grid-sort" aria-label="Sort surfaces">
      <option value="newest"${gridSort === "newest" ? " selected" : ""}>Newest</option>
      <option value="oldest"${gridSort === "oldest" ? " selected" : ""}>Oldest</option>
      <option value="az"${gridSort === "az" ? " selected" : ""}>A–Z</option>
      <option value="za"${gridSort === "za" ? " selected" : ""}>Z–A</option>
    </select>
  `;
  bar.querySelectorAll(".grid-chip").forEach((btn) => {
    // The active chip is marked here rather than interpolated into `class`:
    // every attribute-value interpolation in this file has to go through
    // escapeAttr, and the build guard in test/clientRender.ts holds that line.
    btn.classList.toggle("grid-chip--active", btn.dataset.filter === gridFilter);
    btn.addEventListener("click", () => {
      gridFilter = btn.dataset.filter;
      bar.querySelectorAll(".grid-chip").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("grid-chip--active", on);
        b.setAttribute("aria-pressed", String(on));
      });
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
  const ts = (s) => {
    const d = parseServerDate(s.updated_at || s.created_at);
    return d ? d.getTime() : 0;
  };
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
  // One fragment, one insertion: appending each card individually forces the
  // grid to re-layout per card.
  const frag = document.createDocumentFragment();
  visible.forEach((s, i) => frag.appendChild(createCard(s, i)));
  grid.appendChild(frag);
  updateGridMeta();
}

// Thumbnails load only as cards approach the viewport. `rootMargin` gives the
// decode a head start so an image is ready by the time the card is on screen,
// without paying for every card in a hundred-surface grid up front.
const thumbObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.unobserve(entry.target);
        loadCardThumb(entry.target);
      }
    }, { rootMargin: "400px 0px", threshold: 0 })
  : null;

function loadCardThumb(img) {
  if (!img || img.dataset.loaded === "1") return;
  const src = img.dataset.src;
  if (!src) return;
  img.dataset.loaded = "1";
  img.src = src;
}

// Deterministic hue per surface so a card's cover is stable across reloads and
// two neighbours rarely collide. FNV-1a, matching `hueForSeed` in
// server/render.ts — the two covers must be the same picture.
function hueForId(id) {
  const str = String(id || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

function buildFallbackCover(s, mime) {
  const meta = parseMetadata(s.metadata);
  const cover = document.createElement("div");
  cover.className = "card-fallback";
  cover.style.setProperty("--seed-h", String(hueForId(s.id)));
  const kind = document.createElement("div");
  kind.className = "card-fallback-kind";
  // Prefer the human label over metadata.icon: the CLI stamps terse codes like
  // "FILE" on linked artifacts, which is exactly the file-extension chip this
  // cover exists to replace. An agent's own icon still wins for unknown mimes.
  kind.textContent = mime ? labelForMime(mime) : (meta.icon || "Surface");
  const title = document.createElement("div");
  title.className = "card-fallback-title";
  title.textContent = s.title || "Untitled";
  cover.append(kind, title);
  return cover;
}

function cardThumbUrl(s) {
  const version = encodeURIComponent(s.updated_at || s.created_at || "");
  return `/artifacts/${encodeURIComponent(s.id)}/thumb${version ? `?v=${version}` : ""}`;
}

function createCard(s, index) {
  const card = document.createElement("article");
  card.className = "surface-card";
  card.dataset.id = s.id;
  card.tabIndex = 0;
  card.setAttribute("role", "link");
  // Only the first screenful is worth staggering; beyond that the delay just
  // makes a fast grid feel slow.
  if ((index || 0) < 12) card.style.setProperty("--card-delay", ((index || 0) * 0.035) + "s");
  card.onclick = () => navigate("/surface/" + s.id);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      if (e.target !== card) return;
      e.preventDefault();
      navigate("/surface/" + s.id);
    }
  });

  const preview = document.createElement("div");
  preview.className = "card-preview";

  const mime = s.artifact_mime || (s.artifact && s.artifact.mime) || "";
  // `has_thumb` tells us a real capture (or a passthrough image) is on disk.
  // Without it the card paints its own cover instead of fetching a placeholder
  // it would only throw away when the capture lands.
  if (s.has_thumb === false) {
    preview.classList.add("is-capturing");
    preview.appendChild(buildFallbackCover(s, mime));
  } else {
    const img = document.createElement("img");
    img.className = "card-thumb";
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = `Preview of ${s.title || "surface"}`;
    img.dataset.src = cardThumbUrl(s);
    img.onerror = () => {
      img.remove();
      preview.classList.add("is-capturing");
      preview.prepend(buildFallbackCover(s, mime));
    };
    preview.appendChild(img);
    if (thumbObserver) thumbObserver.observe(img);
    else loadCardThumb(img);
  }

  if (s.updated_at) {
    const updatedAt = parseServerDate(s.updated_at);
    const ageMs = updatedAt ? Date.now() - updatedAt.getTime() : Number.POSITIVE_INFINITY;
    if (ageMs < 60000) {
      const live = document.createElement("div");
      live.className = "card-live";
      live.textContent = "live";
      preview.appendChild(live);
    }
  }

  card.appendChild(preview);
  updateCardBadges(card, s);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  for (const [action, label, icon, danger] of [
    ["copy", "Copy link", ICON_COPY, false],
    ["rename", "Rename", ICON_PENCIL, false],
    ["delete", "Delete", ICON_X, true],
  ]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = danger ? "card-action card-action--danger" : "card-action";
    btn.dataset.action = action;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = icon; // a module constant, never artifact data
    actions.appendChild(btn);
  }
  actions.addEventListener("click", (e) => e.stopPropagation());
  actions.querySelector('[data-action="copy"]').addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyToClipboard(location.origin + "/surface/" + s.id);
    if (ok) showToast("Link copied");
    else showToast("Copy failed", 3000, "error");
  });
  actions.querySelector('[data-action="rename"]').addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(card, s.id);
  });
  actions.querySelector('[data-action="delete"]').addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${s.title}"?`)) return;
    const res = await fetch("/artifacts/" + s.id, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || "Failed to delete", 3000, "error");
    }
  });
  card.appendChild(actions);

  // A surface title is device-authorable and lands here on the SYSTEM plane —
  // the dashboard that can POST /api/update/apply. It is written as text and as
  // an attribute through DOM APIs, which cannot be escaped out of, rather than
  // interpolated into markup.
  const body = document.createElement("div");
  body.className = "card-body";
  const text = document.createElement("div");
  text.className = "card-text";
  const titleEl = document.createElement("div");
  titleEl.className = "card-title";
  titleEl.textContent = s.title || "";
  titleEl.setAttribute("title", s.title || "");
  const subEl = document.createElement("div");
  subEl.className = "card-sub";
  subEl.textContent = cardSubtitle(s);
  text.append(titleEl, subEl);
  body.appendChild(text);

  // Touch handle for the tray. CSS shows it only where hover doesn't exist, so
  // pointer devices keep the clean caption and never see it.
  const more = document.createElement("button");
  more.type = "button";
  more.className = "card-more";
  more.setAttribute("aria-label", `Actions for ${s.title || "surface"}`);
  more.innerHTML = ICON_MORE;
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !card.classList.contains("is-menu-open");
    document.querySelectorAll(".surface-card.is-menu-open").forEach((el) => el.classList.remove("is-menu-open"));
    card.classList.toggle("is-menu-open", open);
  });
  body.appendChild(more);
  card.appendChild(body);

  return card;
}

// "HTML · claude · 5m ago" — kind, who made it, when. Sentence case; the mono
// screaming-caps version read as a build log, not a library.
//
// A phone card is ~170px wide, which is not enough for three facts plus the
// actions handle without the line ellipsising mid-word. Attribution is the one
// that drops: kind and age are what you scan a grid by.
function cardSubtitle(s) {
  const mime = s.artifact_mime || (s.artifact && s.artifact.mime) || "";
  const narrow = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
  const parts = [];
  if (mime) parts.push(labelForMime(mime));
  if (!narrow) {
    if (s.agent) parts.push(s.agent);
    else if (s.project_root) parts.push(s.project_root.split("/").pop());
  }
  const t = timeAgo(s.updated_at);
  if (t) parts.push(t);
  return parts.join(" · ");
}

// Delivery-ladder card states: pending-action badge, "agent listening" pill,
// and the ⟳ handling pill while a binding runs.
function updateCardBadges(card, s) {
  const disc = card.querySelector(".card-preview");
  if (!disc) return;
  const n = s.pending_actions || 0;
  let badge = disc.querySelector(".card-badge");
  if (n > 0) {
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "card-badge";
      badge.title = "unanswered actions";
      disc.appendChild(badge);
    }
    badge.textContent = n > 9 ? "9+" : String(n);
  } else if (badge) {
    badge.remove();
  }
  let pill = disc.querySelector(".card-listening");
  if (s.listening && !disc.querySelector(".card-handling")) {
    if (!pill) {
      pill = document.createElement("div");
      pill.className = "card-listening";
      pill.textContent = "listening";
      disc.appendChild(pill);
    }
  } else if (pill) {
    pill.remove();
  }
}

// Find a card by artifact id WITHOUT building a selector string out of the id.
// Interpolating an id into `[data-id="…"]` is the selector-injection cousin of
// the markup problem: a quote in the id throws (taking the SSE handler with it)
// or, worse, matches a different card. dataset comparison cannot be escaped out
// of, and the grid is small enough that the scan is free.
function cardById(id) {
  if (id === null || id === undefined) return null;
  const wanted = String(id);
  const cards = document.querySelectorAll(".surface-card");
  for (const card of cards) {
    if (card.dataset.id === wanted) return card;
  }
  return null;
}

function setCardTitle(card, title) {
  const titleEl = card && card.querySelector(".card-title");
  if (!titleEl) return;
  titleEl.textContent = title || "";
  if (titleEl.tagName !== "INPUT") titleEl.setAttribute("title", title || "");
}

function setCardHandling(surfaceId, running) {
  const card = cardById(surfaceId);
  const disc = card && card.querySelector(".card-preview");
  if (!disc) return;
  let pill = disc.querySelector(".card-handling");
  if (running) {
    const listening = disc.querySelector(".card-listening");
    if (listening) listening.remove();
    if (!pill) {
      pill = document.createElement("div");
      pill.className = "card-handling";
      pill.textContent = "handling…";
      disc.appendChild(pill);
    }
  } else if (pill) {
    pill.remove();
  }
}

const ICON_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_PENCIL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
const ICON_CHEVRON_LEFT = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1.1l2.9-2.9a5 5 0 0 0-7.1-7.1L11.3 4.7"/><path d="M14 11a5 5 0 0 0-7.1-.1L4 13.8a5 5 0 0 0 7.1 7.1l1.5-1.5"/></svg>';
const ICON_EXTERNAL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M19 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5h4.5"/></svg>';

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
    span.setAttribute("title", newText);
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
      setCardTitle(card, originalTitle);
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
  currentSurfaceId = id;
  resumeTheme();
  if (!globalSSE || globalSSE.readyState === EventSource.CLOSED) {
    connectGlobalSSE();
  }

  const res = await fetch("/artifacts/" + id);
  if (!res.ok) { navigate("/"); return; }
  const data = await res.json();
  const artifact = data.artifact || {};

  const view = document.createElement("div");
  view.className = "surface-view";

  const mime = artifact.mime || "";
  const mimeLabel = mime ? labelForMime(mime) : "";

  // One 40px row: leave, identify, state. Everything else belongs to the
  // surface. Meta collapses out of the way before the title ever truncates.
  const nav = document.createElement("header");
  nav.className = "surface-nav";
  // Static skeleton + textContent for the artifact-controlled parts (the title
  // is device-authorable, and this view runs on the trusted app origin).
  nav.innerHTML = `
    <button type="button" class="back-btn" aria-label="Back to all surfaces" title="Back (esc)">${ICON_CHEVRON_LEFT}</button>
    <div class="surface-nav-titlewrap">
      <h1 class="surface-nav-title"></h1>
      <div class="surface-nav-meta">
        ${mimeLabel ? `<span data-surface-mime></span><span class="surface-nav-meta-dot"></span>` : ""}
        <span data-surface-updated-at></span>
        <span class="surface-nav-meta-dot"></span>
        <span class="surface-nav-live">live</span>
      </div>
    </div>
    <div class="surface-nav-actions">
      <button type="button" class="nav-action" data-action="copy" title="Copy link" aria-label="Copy link">${ICON_LINK}</button>
      <button type="button" class="nav-action" data-action="open" title="Open raw surface" aria-label="Open raw surface">${ICON_EXTERNAL}</button>
    </div>
  `;
  nav.querySelector(".surface-nav-title").textContent = artifact.title || "";
  const mimeEl = nav.querySelector("[data-surface-mime]");
  if (mimeEl) mimeEl.textContent = mimeLabel;
  nav.querySelector("[data-surface-updated-at]").textContent = timeAgo(artifact.updated_at);
  nav.querySelector(".back-btn").addEventListener("click", () => { location.hash = "/"; });
  nav.querySelector('[data-action="copy"]').addEventListener("click", async () => {
    const ok = await copyToClipboard(location.origin + "/#/surface/" + id);
    showToast(ok ? "Link copied" : "Copy failed", 2600, ok ? "success" : "error");
  });
  nav.querySelector('[data-action="open"]').addEventListener("click", () => {
    window.open(`/artifacts/${encodeURIComponent(id)}/view`, "_blank", "noopener");
  });
  view.appendChild(nav);

  const iframe = document.createElement("iframe");
  iframe.className = "surface-frame";
  // The sandbox attr blocks top-navigation and modal abuse. allow-same-origin
  // lets surface.js use fetch/SSE — but for DEVICE-authored content we load it
  // from the untrusted content origin, so "same-origin" there is the content
  // plane (never system), not this trusted app origin. System content stays on
  // the app origin. (docs/auth/trust-model.md)
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-presentation");
  iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write");
  const rawViewPath = data.view_url || `/artifacts/${id}/view`;
  const revision = artifact.updated_at || artifact.current_version_id || Date.now();
  const viewPath = versionSurfaceViewPath(rawViewPath, revision);
  const meta = parseMetadata(artifact.metadata);
  const fromDevicePlane = meta && meta.author_plane === "device";
  const frameSrc = surfaceFrameSrc(fromDevicePlane, contentOrigin, viewPath);
  if (frameSrc === null) {
    // Fail closed (see surfaceFrameSrc): a device-authored surface with no
    // content plane available is NOT rendered on the trusted app origin.
    const warn = document.createElement("div");
    warn.className = "surface-frame surface-frame-unavailable";
    warn.textContent = "This surface needs the isolated content plane, which is unavailable.";
    view.appendChild(warn);
  } else {
    iframe.src = frameSrc;
    view.appendChild(iframe);
  }

  app.innerHTML = "";
  app.appendChild(view);

}

// ── Global SSE ──

async function reconcileAfterReconnect() {
  try {
    const [cards] = await Promise.all([
      fetch("/artifacts").then((r) => r.ok ? r.json() : surfaces),
      refreshSlots(),
    ]);
    if (Array.isArray(cards)) surfaces = cards;
    if (getRoute().view === "grid") renderGrid();
  } catch {
    // The next successful SSE open or route render will retry.
  }
}

function connectGlobalSSE() {
  if (globalSSE) globalSSE.close();
  globalSSE = new EventSource("/stream");
  let hadError = false;

  // Connection state → "STATION" indicator in the grid header.
  const setOnline = (on) => {
    const meta = document.getElementById("grid-meta");
    if (meta) meta.classList.toggle("online", on);
  };
  globalSSE.addEventListener("open", async () => {
    setOnline(true);
    if (renderFailed) {
      renderFailed = false;
      await render();
      return;
    }
    if (hadError) {
      hadError = false;
      // A reconnect is also how the PWA finds out an update finished: the
      // server that went away was the one being replaced.
      refreshUpdateStatus();
      await reconcileAfterReconnect();
    }
  });
  globalSSE.onerror = () => { hadError = true; setOnline(false); };
  // EventSource is open as soon as it's instantiated and the
  // browser has the connection — set online optimistically.
  setTimeout(() => {
    if (globalSSE && globalSSE.readyState === 1) setOnline(true);
  }, 200);

  globalSSE.addEventListener("surface_created", (e) => {
    // The event payload IS the full card — no follow-up fetch needed.
    const full = JSON.parse(e.data);
    pulseSpace({ comet: true });
    const meta = parseMetadata(full.metadata);
    if (meta && meta.hidden === true) return;
    surfaces.unshift(full);
    maybeRefreshSlots(full);
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
    } else if (shouldRenderSurfaceCreated(getRoute().view, false)) {
      render();
    }
  });

  globalSSE.addEventListener("surface_updated", (e) => {
    const data = JSON.parse(e.data);
    publishSurfaceHostEvent("surface_updated", data);
    pulseSpace();
    maybeRefreshSlots(data);
    if (data.id === currentSurfaceId) {
      const iframe = document.querySelector("iframe.surface-frame");
      if (iframe) {
        const base = iframe.src.split("?")[0];
        iframe.src = versionSurfaceViewPath(base, data.updated_at || Date.now());
        iframe.classList.remove("refreshing");
        void iframe.offsetWidth;
        iframe.classList.add("refreshing");
      }
      const titleEl = document.querySelector(".surface-nav-title");
      if (titleEl && data.title) titleEl.textContent = data.title;
      const tsSpan = document.querySelector("[data-surface-updated-at]");
      if (tsSpan && data.updated_at) tsSpan.textContent = timeAgo(data.updated_at);
    }
    const idx = surfaces.findIndex((s) => s.id === data.id);
    // A flip to metadata.hidden = true (e.g. via `surface clear-demos`) is the
    // signal to remove the card from view without deleting the artifact.
    let nextMeta = {};
    try { nextMeta = typeof data.metadata === "string" ? JSON.parse(data.metadata) : (data.metadata || {}); } catch {}
    const becameHidden = nextMeta && nextMeta.hidden === true;
    if (becameHidden) {
      if (idx !== -1) surfaces.splice(idx, 1);
      const card = cardById(data.id);
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
    // The payload is the full card — treat it like a fresh creation.
    if (idx === -1) {
      surfaces.unshift(data);
      if (document.querySelector(".empty-state")) { render(); return; }
      const grid = document.getElementById("surface-grid");
      if (grid && !cardById(data.id)) {
        grid.prepend(createCard(data, 0));
        updateGridMeta();
      }
      return;
    }
    if (idx !== -1) {
      surfaces[idx] = { ...surfaces[idx], ...data };
      const card = cardById(data.id);
      if (card) {
        updateCardBadges(card, surfaces[idx]);
        setCardTitle(card, data.title || surfaces[idx].title);
        const subEl = card.querySelector(".card-sub");
        if (subEl) subEl.textContent = cardSubtitle(surfaces[idx]);
        let live = card.querySelector(".card-live");
        if (!live) {
          live = document.createElement("div");
          live.className = "card-live";
          live.textContent = "live";
          const preview = card.querySelector(".card-preview");
          if (preview) preview.appendChild(live);
        }
        setTimeout(() => {
          const stillThere = card.querySelector(".card-live");
          if (stillThere) stillThere.remove();
        }, 60000);
      }
    }
  });

  globalSSE.addEventListener("state_patch", (e) => {
    publishSurfaceHostEvent("state_patch", JSON.parse(e.data));
  });

  globalSSE.addEventListener("stream_append", (e) => {
    publishSurfaceHostEvent("stream_append", JSON.parse(e.data));
  });

  globalSSE.addEventListener("agent_reply", (e) => {
    const data = JSON.parse(e.data);
    publishSurfaceHostEvent("agent_reply", data);
    if (data.surface_id === currentSurfaceId) showToast(data.text);
  });

  globalSSE.addEventListener("surface_exec", (e) => {
    const data = JSON.parse(e.data);
    publishSurfaceHostEvent("surface_exec", data);
    if (data.surface_id !== currentSurfaceId || !data.js) return;
    const iframe = document.querySelector("iframe.surface-frame");
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.eval(data.js);
    } catch (err) {
      console.error("[surface_exec]", err);
    }
  });

  globalSSE.addEventListener("surface_deleted", (e) => {
    const data = JSON.parse(e.data);
    pulseSpace();
    maybeRefreshSlots(data.id);
    surfaces = surfaces.filter((s) => s.id !== data.id);
    const card = cardById(data.id);
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

  // ── Delivery-ladder card states ──

  globalSSE.addEventListener("surface_action", (e) => {
    const d = JSON.parse(e.data);
    const idx = surfaces.findIndex((s) => s.id === d.surface_id);
    if (idx === -1) return;
    surfaces[idx].pending_actions = (surfaces[idx].pending_actions || 0) + 1;
    const card = cardById(d.surface_id);
    if (card) updateCardBadges(card, surfaces[idx]);
  });

  globalSSE.addEventListener("actions_acked", (e) => {
    const d = JSON.parse(e.data);
    const idx = surfaces.findIndex((s) => s.id === d.surface_id);
    if (idx === -1) return;
    surfaces[idx].pending_actions = d.pending_actions || 0;
    const card = cardById(d.surface_id);
    if (card) updateCardBadges(card, surfaces[idx]);
  });

  globalSSE.addEventListener("waiter_status", (e) => {
    const d = JSON.parse(e.data);
    if (!d.surface_id || d.surface_id === "*") return;
    const idx = surfaces.findIndex((s) => s.id === d.surface_id);
    if (idx !== -1) surfaces[idx].listening = d.listening;
    const card = cardById(d.surface_id);
    if (card) updateCardBadges(card, surfaces[idx] || { listening: d.listening });
  });

  globalSSE.addEventListener("binding_status", (e) => {
    const d = JSON.parse(e.data);
    if (!d.surface_id) return;
    setCardHandling(d.surface_id, d.status === "running");
  });

  // Codex flowback narration: a delivered batch shows the same "⟳ handling…"
  // indicator as a running binding, cleared when the turn ends or is held.
  globalSSE.addEventListener("codex_bridge_status", (e) => {
    const d = JSON.parse(e.data);
    if (!d.surface_id) return;
    setCardHandling(d.surface_id, d.state === "delivered_live" || d.state === "delivered_wake");
  });

  globalSSE.addEventListener("thumb_ready", (e) => {
    const data = JSON.parse(e.data);
    if (!data || !data.id) return;
    const idx = surfaces.findIndex((s) => s.id === data.id);
    if (idx !== -1) surfaces[idx].has_thumb = true;
    const card = cardById(data.id);
    if (!card) return;
    const preview = card.querySelector(".card-preview");
    if (!preview) return;
    const src = `/artifacts/${encodeURIComponent(data.id)}/thumb?v=${Date.now()}`;
    const existing = preview.querySelector(".card-thumb");
    if (existing) {
      existing.dataset.src = src;
      existing.dataset.loaded = "1";
      existing.src = src;
      return;
    }
    // First capture for a card that has been showing its own cover: decode the
    // PNG off-thread and only swap once it is paintable, so the card never
    // flashes empty between the cover leaving and the image arriving.
    const img = new Image();
    img.className = "card-thumb";
    img.decoding = "async";
    img.alt = `Preview of ${(surfaces[idx] && surfaces[idx].title) || "surface"}`;
    img.dataset.loaded = "1";
    img.onload = () => {
      const cover = preview.querySelector(".card-fallback");
      if (cover) cover.remove();
      preview.classList.remove("is-capturing");
      preview.prepend(img);
    };
    img.src = src;
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
    const data = JSON.parse(e.data);
    applyTheme(data);
    pulseSpace();
  });

  globalSSE.addEventListener("update_status", (e) => {
    applyUpdateStatus(JSON.parse(e.data));
  });
}

// Update the surface-count badge in the grid header without
// re-rendering the whole grid (used after SSE create/delete). Only the
// count span is touched — the live-connection indicator (and its
// `.online` class, toggled by SSE state) lives in the same element and
// must survive these updates.
function updateGridMeta() {
  const header = document.querySelector(".grid-header");
  if (!header) return;
  const metaEl = header.querySelector(".grid-meta");
  if (!metaEl) return;
  const n = surfaces.length;
  let countEl = metaEl.querySelector(".grid-meta-count");
  if (n === 0) {
    if (countEl) countEl.remove();
    return;
  }
  if (!countEl) {
    countEl = document.createElement("span");
    countEl.className = "grid-meta-count";
    // before the live dot, after the release notice — the header order is fixed
    metaEl.insertBefore(countEl, metaEl.querySelector(".grid-meta-live"));
  }
  countEl.textContent = `${n} ${n === 1 ? "surface" : "surfaces"}`;
}

// ── Main Render ──

async function render() {
  try {
    const route = getRoute();
    if (route.view === "surface") {
      await renderSurface(route.id);
    } else {
      // One fetch: the card list carries everything the grid renders.
      const res = await fetch("/artifacts");
      if (!res.ok) throw new Error(`GET /artifacts ${res.status}`);
      surfaces = await res.json();
      renderGrid();
    }
    renderFailed = false;
    reportPresence();
  } catch {
    renderFailed = true;
    app.innerHTML = `<div class="grid-empty">Surface is reconnecting…</div>`;
    connectGlobalSSE();
  }
}

// ── Init ──

function startApp() {
  return Promise.all([
    fetch("/display/config").then((r) => r.json()).catch(() => ({})),
    fetch("/display/slots").then((r) => r.json()).catch(() => displaySlots),
  ])
    .then(([config, slots]) => {
      displaySlots = slots;
      if (config && config.content_origin) {
        contentOrigin = config.content_origin;
      } else if (config && config.content_port) {
        contentOrigin = location.protocol + "//" + location.hostname + ":" + config.content_port;
      }
      applyTheme(config);
      // Fire-and-forget: the status endpoint is cache-only, but the first
      // paint must not wait on it either.
      refreshUpdateStatus();
      return render();
    })
    .catch(() => render());
}

// Auth gate: an unpaired browser (non-loopback, no session) is sent to /pair.
// The session endpoint is public, so this only redirects on an explicit
// `authenticated: false`; transient/network errors fall through to startApp so
// we never bounce between / and /pair when the server is simply down.
fetch("/api/auth/session")
  .then((r) => r.json())
  .then((s) => {
    if (s && s.authenticated === false) {
      window.location.replace("/pair");
      return;
    }
    return startApp();
  })
  .catch(() => startApp());

window.addEventListener("resize", () => reportPresence());
