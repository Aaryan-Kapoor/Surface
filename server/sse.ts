import type { Response } from "express";

type SSEClient = {
  id: string;
  res: Response;
};

const globalClients: SSEClient[] = [];
const surfaceClients: Map<string, SSEClient[]> = new Map();

let clientCounter = 0;

export function addGlobalClient(res: Response): string {
  const id = String(++clientCounter);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":\n\n"); // heartbeat
  globalClients.push({ id, res });
  res.on("close", () => {
    const idx = globalClients.findIndex((c) => c.id === id);
    if (idx !== -1) globalClients.splice(idx, 1);
  });
  return id;
}

export function addSurfaceClient(surfaceId: string, res: Response): string {
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
  surfaceClients.get(surfaceId)!.push({ id, res });
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

export function broadcastGlobal(event: string, data: unknown): void {
  for (const client of globalClients) {
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
