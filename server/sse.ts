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
};

const globalClients: SSEClient[] = [];
const surfaceClients: Map<string, SSEClient[]> = new Map();

let clientCounter = 0;

export function addGlobalClient(res: Response, target: string = LOCAL_TARGET): string {
  const id = String(++clientCounter);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":\n\n"); // heartbeat
  globalClients.push({ id, res, target });
  res.on("close", () => {
    const idx = globalClients.findIndex((c) => c.id === id);
    if (idx !== -1) globalClients.splice(idx, 1);
  });
  return id;
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
