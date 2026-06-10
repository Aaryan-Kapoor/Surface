import type { Response } from "express";

// Every SSE connection is tagged with a delivery target: "local" for the
// agent plane (loopback / system bearers) or the device session id for paired
// displays. Directed events (--on <device>) deliver only to one target;
// untargeted broadcasts reach everyone.
export const LOCAL_TARGET = "local";

type SSEClient = {
  id: string;
  res: Response;
  target: string;
  // Layer-1 waiter presence (docs/interaction/delivery-ladder.md): a `surface
  // wait` connection registers which surface it is waiting on ("*" = any).
  // While one is connected, bindings for that surface are suppressed.
  waiterFor?: string | null;
};

const globalClients: SSEClient[] = [];
const surfaceClients: Map<string, SSEClient[]> = new Map();

let clientCounter = 0;

// Keepalive heartbeat: a comment line every 20s so idle connections survive
// proxies and NAT timeouts, and dead ones get detected by the TCP stack.
const HEARTBEAT_MS = 20_000;
setInterval(() => {
  for (const client of globalClients) {
    try { client.res.write(":hb\n\n"); } catch {}
  }
  for (const clients of surfaceClients.values()) {
    for (const client of clients) {
      try { client.res.write(":hb\n\n"); } catch {}
    }
  }
}, HEARTBEAT_MS).unref();

export function addGlobalClient(
  res: Response,
  target: string = LOCAL_TARGET,
  opts: { waiterFor?: string | null; onClose?: () => void } = {},
): string {
  const id = String(++clientCounter);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":\n\n"); // heartbeat
  globalClients.push({ id, res, target, waiterFor: opts.waiterFor ?? null });
  res.on("close", () => {
    const idx = globalClients.findIndex((c) => c.id === id);
    if (idx !== -1) globalClients.splice(idx, 1);
    opts.onClose?.();
  });
  return id;
}

// A live waiter for this surface (or a catch-all waiter) suppresses bindings.
export function hasWaiter(surfaceId: string): boolean {
  return globalClients.some((c) => c.waiterFor === surfaceId || c.waiterFor === "*");
}

export function waitedSurfaces(): Set<string> {
  return new Set(globalClients.filter((c) => c.waiterFor).map((c) => c.waiterFor as string));
}

export function addSurfaceClient(surfaceId: string, res: Response, target: string = LOCAL_TARGET): string {
  const id = String(++clientCounter);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":\n\n");
  if (!surfaceClients.has(surfaceId)) {
    surfaceClients.set(surfaceId, []);
  }
  surfaceClients.get(surfaceId)!.push({ id, res, target });
  res.on("close", () => {
    const clients = surfaceClients.get(surfaceId);
    if (clients) {
      const idx = clients.findIndex((c) => c.id === id);
      if (idx !== -1) clients.splice(idx, 1);
      if (clients.length === 0) surfaceClients.delete(surfaceId);
    }
  });
  return id;
}

function sendEvent(client: SSEClient, event: string, data: unknown): void {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Broadcast to every global client, or — when `onlyTarget` is set — to just
// the connections belonging to that device session (or "local").
export function broadcastGlobal(event: string, data: unknown, onlyTarget?: string): void {
  for (const client of globalClients) {
    if (onlyTarget && client.target !== onlyTarget) continue;
    sendEvent(client, event, data);
  }
}

export function broadcastToSurface(
  surfaceId: string,
  event: string,
  data: unknown
): void {
  const clients = surfaceClients.get(surfaceId);
  if (clients) {
    for (const client of clients) {
      sendEvent(client, event, data);
    }
  }
}

// Live connection targets — used to mark devices as connected in
// `surface devices` and to validate targeting before an event is dropped on
// the floor.
export function connectedTargets(): Set<string> {
  return new Set(globalClients.map((c) => c.target));
}
