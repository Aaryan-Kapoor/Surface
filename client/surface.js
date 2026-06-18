// surface.js — the runtime auto-injected into surface HTML.
// Gives any surface live state bindings and an action helper with zero build
// step (docs/state/stateful-surfaces.md):
//
//   <span data-surface-bind="tests.passed">0</span>
//   <progress data-surface-bind="progress" max="1"></progress>
//   <div data-surface-show="deploy.ready">…</div>
//   <button onclick="Surface.action('approve', {env: 'prod'})">Ship</button>
//
// Custom rendering: Surface.state (snapshot), Surface.onState(cb).
(function () {
  "use strict";

  // The artifact id rides on the injected script tag's query string.
  var script = document.currentScript;
  var artifactId = null;
  if (script && script.src) {
    try {
      artifactId = new URL(script.src, location.origin).searchParams.get("id");
    } catch (e) {}
  }
  if (!artifactId) return;

  var state = {};
  var version = 0;
  var listeners = [];
  var eventListeners = {}; // event name -> [cb]; shares the runtime's SSE connection

  function get(obj, path) {
    var parts = String(path).split(".");
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function applyBindings(root) {
    var scope = root || document;
    var bound = scope.querySelectorAll("[data-surface-bind]");
    for (var i = 0; i < bound.length; i++) {
      var el = bound[i];
      var value = get(state, el.getAttribute("data-surface-bind"));
      if (value === undefined) continue;
      var tag = el.tagName;
      if (tag === "PROGRESS" || tag === "METER") {
        el.value = Number(value) || 0;
      } else if (tag === "INPUT") {
        if (el.type === "checkbox") el.checked = !!value;
        else el.value = String(value);
      } else if (tag === "IMG" || tag === "IFRAME") {
        if (el.src !== String(value)) el.src = String(value);
      } else {
        var text = typeof value === "object" ? JSON.stringify(value) : String(value);
        if (el.textContent !== text) el.textContent = text;
      }
    }
    var shown = scope.querySelectorAll("[data-surface-show]");
    for (var j = 0; j < shown.length; j++) {
      var sel = shown[j];
      var expr = sel.getAttribute("data-surface-show");
      var negate = expr.charAt(0) === "!";
      var v = get(state, negate ? expr.slice(1) : expr);
      var visible = negate ? !v : !!v;
      sel.style.display = visible ? "" : "none";
    }
  }

  function emit(patch) {
    applyBindings();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](patch, state); } catch (e) { console.error("[surface.js] onState handler", e); }
    }
  }

  function hydrate() {
    fetch("/artifacts/" + encodeURIComponent(artifactId) + "/state")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (doc) {
        if (!doc) return;
        state = doc.state || {};
        version = doc.state_version || 0;
        emit(state);
      })
      .catch(function () {});
  }

  var KNOWN_EVENTS = ["state_patch", "stream_append", "surface_updated", "agent_reply", "surface_exec"];

  function connect() {
    var sse = new EventSource("/artifacts/" + encodeURIComponent(artifactId) + "/stream");
    KNOWN_EVENTS.forEach(function (name) {
      sse.addEventListener(name, function (e) {
        var cbs = eventListeners[name];
        if (!cbs || !cbs.length) return;
        var data;
        try { data = JSON.parse(e.data); } catch (err) { data = e.data; }
        for (var i = 0; i < cbs.length; i++) {
          try { cbs[i](data); } catch (err) { console.error("[surface.js] onEvent handler", err); }
        }
      });
    });
    sse.addEventListener("state_patch", function (e) {
      var data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      if (!data || data.id !== artifactId) return;
      // A version gap means we missed patches (reconnect); re-hydrate.
      if (typeof data.state_version === "number" && data.state_version !== version + 1) {
        version = data.state_version;
        hydrate();
        return;
      }
      version = data.state_version || version + 1;
      state = mergeInto(state, data.patch || {});
      emit(data.patch || {});
    });
    sse.onerror = function () { /* EventSource auto-reconnects */ };
  }

  function isObj(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
  function mergeInto(base, patch) {
    var out = {};
    var k;
    for (k in base) out[k] = base[k];
    for (k in patch) {
      if (patch[k] === null) delete out[k];
      else if (isObj(patch[k]) && isObj(out[k])) out[k] = mergeInto(out[k], patch[k]);
      else out[k] = patch[k];
    }
    return out;
  }

  function postDirect(name, data) {
    // Post straight to our own origin's actions endpoint. For a device-authored
    // surface this origin is the content plane, so the action lands as `device`
    // without ever touching the trusted parent.
    return fetch("/artifacts/" + encodeURIComponent(artifactId) + "/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: name, data: data || {} }),
    }).then(function (r) { return r.json(); });
  }

  function action(name, data) {
    if (window.parent && window.parent !== window) {
      // Cross-origin (content-plane) iframe: the parent can't be trusted to
      // relay, and same-origin bridge access would throw — post directly.
      var sameOriginParent = true;
      try { void window.parent.location.origin; } catch (e) { sameOriginParent = false; }
      if (!sameOriginParent) return postDirect(name, data);
      // Same-origin (system) iframe: use the PWA bridge so it can update the
      // "agent listening" UI and route through its own connection.
      window.parent.postMessage({ type: "surface_action", action: name, data: data || {} }, "*");
      return Promise.resolve({ delivered: "bridge" });
    }
    // Standalone tab (no PWA bridge): post straight to the server.
    return postDirect(name, data);
  }

  // Stage / commit — batch at the surface, not at the agent. Intermediate
  // clicks (picking options, toggling) stay LOCAL via stage(); a single
  // commit() emits ONE action carrying the full picture, so the agent wakes
  // once on the user's actual intent — not once per twitch, and not on a
  // blind timer. Reserve bare action() for genuinely standalone clicks.
  var staged = {};

  function stage(key, value) {
    if (value === undefined) delete staged[key];
    else staged[key] = value;
    return stagedCopy();
  }

  function stagedCopy() {
    var c = {};
    for (var k in staged) c[k] = staged[k];
    return c;
  }

  function commit(name, extra) {
    if (!name) return Promise.reject(new Error("commit(name): action name is required"));
    var payload = stagedCopy();
    if (extra && typeof extra === "object") {
      for (var e in extra) payload[e] = extra[e];
    }
    // Clear the staged buffer only AFTER the action is accepted. A falsy name, a
    // server rejection (res.error), or a network failure must not lose the
    // user's buffered intent — so they can retry the commit.
    return Promise.resolve(action(name, payload)).then(function (res) {
      if (res && res.error) throw new Error("commit failed: " + res.error);
      staged = {};
      return res;
    });
  }

  window.Surface = {
    id: artifactId,
    get state() { return state; },
    onState: function (cb) { listeners.push(cb); return function () {
      var i = listeners.indexOf(cb);
      if (i !== -1) listeners.splice(i, 1);
    }; },
    // Subscribe to this surface's SSE events (stream_append, surface_updated…)
    // over the runtime's existing connection.
    onEvent: function (name, cb) {
      (eventListeners[name] = eventListeners[name] || []).push(cb);
      return function () {
        var arr = eventListeners[name] || [];
        var i = arr.indexOf(cb);
        if (i !== -1) arr.splice(i, 1);
      };
    },
    action: action,
    stage: stage,
    commit: commit,
    staged: stagedCopy,
    clearStaged: function () { staged = {}; },
  };

  function boot() {
    hydrate();
    connect();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
