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
const MAX_WRITABLE_BUFFER = 1024 * 1024;

function removeGlobalClient(id: string): void {
  const idx = globalClients.findIndex((c) => c.id === id);
  if (idx !== -1) globalClients.splice(idx, 1);
}

function removeSurfaceClient(surfaceId: string, id: string): void {
  const clients = surfaceClients.get(surfaceId);
  if (!clients) return;
  const idx = clients.findIndex((c) => c.id === id);
  if (idx !== -1) clients.splice(idx, 1);
  if (clients.length === 0) surfaceClients.delete(surfaceId);
}

function safeWrite(client: SSEClient, payload: string, onFailure?: () => void): boolean {
  try {
    if (client.res.destroyed || client.res.writableEnded) throw new Error("SSE response closed");
    const ok = client.res.write(payload);
    if (!ok && client.res.writableLength > MAX_WRITABLE_BUFFER) {
      throw new Error("SSE client exceeded write buffer");
    }
    return true;
  } catch {
    onFailure?.();
    try { client.res.destroy(); } catch {}
    return false;
  }
}

setInterval(() => {
  for (const client of [...globalClients]) {
    safeWrite(client, ":hb\n\n", () => removeGlobalClient(client.id));
  }
  for (const [surfaceId, clients] of [...surfaceClients.entries()]) {
    for (const client of [...clients]) {
      safeWrite(client, ":hb\n\n", () => removeSurfaceClient(surfaceId, client.id));
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
  res.on("error", () => removeGlobalClient(id));
  globalClients.push({ id, res, target, waiterFor: opts.waiterFor ?? null });
  safeWrite(globalClients[globalClients.length - 1], ":\n\n", () => removeGlobalClient(id)); // heartbeat
  res.on("close", () => {
    removeGlobalClient(id);
    opts.onClose?.();
  });
  return id;
}

// A live waiter for this surface (or a catch-all waiter) suppresses bindings.
export function hasWaiter(surfaceId: string): boolean {
  return globalClients.some((c) => c.waiterFor === surfaceId || c.waiterFor === "*");
}

export function addSurfaceClient(surfaceId: string, res: Response, target: string = LOCAL_TARGET): string {
  const id = String(++clientCounter);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.on("error", () => removeSurfaceClient(surfaceId, id));
  if (!surfaceClients.has(surfaceId)) {
    surfaceClients.set(surfaceId, []);
  }
  surfaceClients.get(surfaceId)!.push({ id, res, target });
  safeWrite(surfaceClients.get(surfaceId)![surfaceClients.get(surfaceId)!.length - 1], ":\n\n", () => removeSurfaceClient(surfaceId, id));
  res.on("close", () => {
    removeSurfaceClient(surfaceId, id);
  });
  return id;
}

function sendEvent(client: SSEClient, event: string, data: unknown, onFailure?: () => void): void {
  safeWrite(client, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, onFailure);
}

// Broadcast to every global client, or — when `onlyTarget` is set — to just
// the connections belonging to that device session (or "local").
export function broadcastGlobal(event: string, data: unknown, onlyTarget?: string): void {
  for (const client of [...globalClients]) {
    if (onlyTarget && client.target !== onlyTarget) continue;
    sendEvent(client, event, data, () => removeGlobalClient(client.id));
  }
}

export function broadcastToSurface(
  surfaceId: string,
  event: string,
  data: unknown
): void {
  const clients = surfaceClients.get(surfaceId);
  if (clients) {
    for (const client of [...clients]) {
      sendEvent(client, event, data, () => removeSurfaceClient(surfaceId, client.id));
    }
  }
}

// Live connection targets — used to mark devices as connected in
// `surface devices` and to validate targeting before an event is dropped on
// the floor.
export function connectedTargets(): Set<string> {
  return new Set(globalClients.map((c) => c.target));
}

export function closeSSEClients(): void {
  for (const client of globalClients.splice(0)) {
    try { client.res.end(); } catch {}
    try { client.res.destroy(); } catch {}
  }
  for (const clients of surfaceClients.values()) {
    for (const client of clients) {
      try { client.res.end(); } catch {}
      try { client.res.destroy(); } catch {}
    }
  }
  surfaceClients.clear();
}
