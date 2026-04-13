// Surface bootloader — injected into every /surfaces/:id/html response by the
// server, right before </body>. It gives the PWA a safe, in-iframe way to:
//
//   1. Morph the DOM in place (preserves running timers, canvas state, focus,
//      form values, scroll, event listeners on unchanged nodes).
//   2. Apply server-validated text edits locally.
//   3. Execute JS inside the iframe without the parent calling
//      contentWindow.eval() from outside (safer, no leak of parent scope).
//
// The parent posts `{type: 'surface/*', ...}` messages; the bootloader replies
// on the same channel. All replies carry a `reqId` when one was provided.
//
// The bootloader also shims parent.postMessage for `surface_action` so we
// stamp a schema version and an auto-generated action id — makes two-way
// traffic debuggable and lets the server correlate replies.

(function () {
  "use strict";
  if (window.__surfaceBoot) return; // idempotent
  window.__surfaceBoot = { version: 1 };

  // ── DOM morph ──────────────────────────────────────────────────────────────
  //
  // Based on morphdom's algorithm, pared down to what we need. Reuses nodes
  // with matching tagName, diffs attributes, updates text nodes in place,
  // does NOT re-execute <script> elements that already ran.

  const VOID_TAGS = new Set([
    "area","base","br","col","embed","hr","img","input","keygen","link",
    "meta","param","source","track","wbr",
  ]);

  function sameTag(a, b) {
    return a.nodeType === b.nodeType &&
      (a.nodeType !== 1 || a.tagName === b.tagName);
  }

  function morphAttrs(from, to) {
    const fromAttrs = from.attributes;
    const toAttrs = to.attributes;
    // remove attrs not in `to`
    for (let i = fromAttrs.length - 1; i >= 0; i--) {
      const name = fromAttrs[i].name;
      if (!to.hasAttribute(name)) from.removeAttribute(name);
    }
    // set/update from `to`
    for (let i = 0; i < toAttrs.length; i++) {
      const a = toAttrs[i];
      if (from.getAttribute(a.name) !== a.value) {
        from.setAttribute(a.name, a.value);
      }
    }
    // Form-control value syncing: attribute edits don't update the
    // live value/checked/selected properties by default.
    if (from.tagName === "INPUT") {
      if (to.hasAttribute("value")) from.value = to.getAttribute("value");
      if (from.type === "checkbox" || from.type === "radio") {
        from.checked = to.hasAttribute("checked");
      }
    } else if (from.tagName === "TEXTAREA") {
      from.value = to.value;
    } else if (from.tagName === "OPTION") {
      from.selected = to.hasAttribute("selected");
    }
  }

  function morphChildren(fromEl, toEl) {
    let fromChild = fromEl.firstChild;
    let toChild = toEl.firstChild;
    while (toChild) {
      const toNext = toChild.nextSibling;
      if (!fromChild) {
        fromEl.appendChild(cloneForInsert(toChild));
      } else if (sameTag(fromChild, toChild)) {
        morphNode(fromChild, toChild);
        fromChild = fromChild.nextSibling;
      } else {
        // Try to find a matching later sibling to reuse; otherwise insert.
        let scan = fromChild.nextSibling;
        let matched = null;
        while (scan) {
          if (sameTag(scan, toChild)) { matched = scan; break; }
          scan = scan.nextSibling;
        }
        if (matched) {
          // Remove everything between fromChild and matched, then morph.
          while (fromChild !== matched) {
            const rm = fromChild;
            fromChild = fromChild.nextSibling;
            fromEl.removeChild(rm);
          }
          morphNode(fromChild, toChild);
          fromChild = fromChild.nextSibling;
        } else {
          fromEl.insertBefore(cloneForInsert(toChild), fromChild);
        }
      }
      toChild = toNext;
    }
    // Drop trailing extras.
    while (fromChild) {
      const rm = fromChild;
      fromChild = fromChild.nextSibling;
      fromEl.removeChild(rm);
    }
  }

  function cloneForInsert(node) {
    if (node.nodeType === 1 && node.tagName === "SCRIPT") {
      // Newly-inserted scripts should execute. Clone into a fresh script
      // so the browser schedules it.
      const s = document.createElement("script");
      for (const a of node.attributes) s.setAttribute(a.name, a.value);
      s.textContent = node.textContent;
      return s;
    }
    return node.cloneNode(true);
  }

  function morphNode(from, to) {
    if (from.nodeType === 3 || from.nodeType === 8) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
      return;
    }
    if (from.nodeType !== 1) return;
    // SCRIPT: don't re-execute an already-executed script just because its
    // attributes/text didn't change. If text changed, we bail and let the
    // caller decide (usually: full reload). Most real edits don't touch
    // <script> tags.
    if (from.tagName === "SCRIPT") {
      if (from.textContent !== to.textContent ||
          from.getAttribute("src") !== to.getAttribute("src")) {
        const replacement = cloneForInsert(to);
        from.parentNode.replaceChild(replacement, from);
      }
      return;
    }
    morphAttrs(from, to);
    if (VOID_TAGS.has(from.tagName.toLowerCase())) return;
    morphChildren(from, to);
  }

  function parseHTML(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc;
  }

  function morphDocument(newHtml) {
    const next = parseHTML(newHtml);
    // Preserve activeElement / selection best-effort across morph.
    const active = document.activeElement;
    const tag = active && active.tagName;
    const idPath = active && active.id ? "#" + active.id : null;
    let selStart, selEnd;
    if (active && (tag === "INPUT" || tag === "TEXTAREA")) {
      try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch {}
    }

    morphNode(document.documentElement, next.documentElement);

    if (idPath) {
      const re = document.querySelector(idPath);
      if (re && typeof re.focus === "function") {
        try {
          re.focus({ preventScroll: true });
          if (selStart != null && (re.tagName === "INPUT" || re.tagName === "TEXTAREA")) {
            re.setSelectionRange(selStart, selEnd);
          }
        } catch {}
      }
    }
  }

  // ── Local edit application (mirrors server/edits.ts) ──────────────────────
  function applyEditsLocal(src, edits) {
    let out = src;
    for (const e of edits) {
      if (!e.old_string || e.old_string === e.new_string) continue;
      if (e.replace_all) {
        out = out.split(e.old_string).join(e.new_string);
      } else {
        const at = out.indexOf(e.old_string);
        if (at === -1) continue; // server already validated; be permissive
        out = out.slice(0, at) + e.new_string + out.slice(at + e.old_string.length);
      }
    }
    return out;
  }

  // ── Message bridge ─────────────────────────────────────────────────────────
  const api = {
    morph(html) { morphDocument(html); return { ok: true }; },
    edits(edits, priorHtml) {
      // Prefer the server-provided full html (priorHtml) for morphing.
      // Fall back to applying edits to document.documentElement.outerHTML.
      const src = priorHtml || document.documentElement.outerHTML;
      const next = priorHtml || applyEditsLocal(src, edits);
      morphDocument(next);
      return { ok: true, edits: edits.length };
    },
    exec(js) {
      // Run in iframe's own global scope via indirect eval.
      (0, eval)(js);
      return { ok: true };
    },
    ping() { return { ok: true, ts: Date.now(), version: window.__surfaceBoot.version }; },
  };

  function reply(port, source, reqId, result, error) {
    if (!reqId && !error) return;
    const msg = { type: "surface/reply", reqId, ok: !error, result, error };
    if (port && port.postMessage) port.postMessage(msg);
    else if (source && source.postMessage) source.postMessage(msg, "*");
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (typeof d.type !== "string" || !d.type.startsWith("surface/")) return;
    const reqId = d.reqId || null;
    try {
      if (d.type === "surface/morph") {
        reply(null, e.source, reqId, api.morph(d.html));
      } else if (d.type === "surface/edits") {
        reply(null, e.source, reqId, api.edits(d.edits || [], d.html));
      } else if (d.type === "surface/exec") {
        reply(null, e.source, reqId, api.exec(d.js || ""));
      } else if (d.type === "surface/ping") {
        reply(null, e.source, reqId, api.ping());
      }
    } catch (err) {
      reply(null, e.source, reqId, null, String(err && err.message || err));
    }
  });

  // Announce ready (lets the PWA skip its initial load wait if it wants to).
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "surface/ready", version: 1 }, "*");
  }
})();
