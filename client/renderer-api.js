(function () {
  window.__surfaces = Array.isArray(window.__surfaces) ? window.__surfaces : [];

  window.navigate = (id) => parent.postMessage({ type: "surface_navigate", surface_id: id }, window.location.origin);
  window.navigateHome = () => parent.postMessage({ type: "surface_navigate" }, window.location.origin);

  window.getSurface = (id) => fetch(`/artifacts/${encodeURIComponent(id)}`).then((r) => r.json());

  window.parseMeta = (surface) => {
    try {
      return typeof surface.metadata === "string" ? JSON.parse(surface.metadata) : (surface.metadata || {});
    } catch {
      return {};
    }
  };

  window.previewUrl = (id) => {
    const surface = window.__surfaces.find((s) => s.id === id);
    return surface && surface.preview_url ? surface.preview_url : `/artifacts/${encodeURIComponent(id)}/view`;
  };

  window.onSurfaceChange = (handlers) => {
    const sse = new EventSource("/stream");
    if (handlers.created) sse.addEventListener("surface_created", (e) => {
      const data = JSON.parse(e.data);
      window.__surfaces.unshift(data);
      handlers.created(data);
    });
    if (handlers.updated) sse.addEventListener("surface_updated", (e) => {
      const data = JSON.parse(e.data);
      const index = window.__surfaces.findIndex((s) => s.id === data.id);
      if (index !== -1) window.__surfaces[index] = { ...window.__surfaces[index], ...data };
      handlers.updated(data);
    });
    if (handlers.deleted) sse.addEventListener("surface_deleted", (e) => {
      const data = JSON.parse(e.data);
      window.__surfaces = window.__surfaces.filter((s) => s.id !== data.id);
      handlers.deleted(data);
    });
    return sse;
  };
}());
