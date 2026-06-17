// Per-device presence (docs/display/devices.md). Each connected display
// reports what it is showing; entries are keyed by delivery target — the
// device session id, or "local" for the host machine's own browser.
// In-memory by design: presence is ephemeral.

export interface DevicePresence {
  target: string;
  device: string;
  current_view: string;
  current_surface_id: string | null;
  viewport_width: number;
  viewport_height: number;
  last_activity: string;
}

const PRESENCE_STALE_MS = 60_000;

const presences = new Map<string, DevicePresence>();

export function reportPresence(
  target: string,
  device: string,
  patch: Partial<Pick<DevicePresence, "current_view" | "current_surface_id" | "viewport_width" | "viewport_height">>,
): void {
  const existing = presences.get(target) || {
    target,
    device,
    current_view: "grid",
    current_surface_id: null,
    viewport_width: 0,
    viewport_height: 0,
    last_activity: new Date().toISOString(),
  };
  if (patch.current_view) existing.current_view = patch.current_view;
  if (patch.current_surface_id !== undefined) existing.current_surface_id = patch.current_surface_id;
  if (patch.viewport_width) existing.viewport_width = patch.viewport_width;
  if (patch.viewport_height) existing.viewport_height = patch.viewport_height;
  existing.device = device;
  existing.last_activity = new Date().toISOString();
  presences.set(target, existing);
}

export function isStale(p: DevicePresence): boolean {
  const t = Date.parse(p.last_activity);
  return !Number.isFinite(t) || Date.now() - t > PRESENCE_STALE_MS;
}

export function listPresence(): Array<DevicePresence & { stale: boolean }> {
  return [...presences.values()]
    .map((p) => ({ ...p, stale: isStale(p) }))
    .sort((a, b) => (a.device < b.device ? -1 : 1));
}

export function getPresence(target: string): (DevicePresence & { stale: boolean }) | null {
  const p = presences.get(target);
  return p ? { ...p, stale: isStale(p) } : null;
}

export function dropPresence(target: string): void {
  presences.delete(target);
}
