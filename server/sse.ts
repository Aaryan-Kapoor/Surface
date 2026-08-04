import type { Response } from "express";

// Every SSE connection is tagged with a delivery target: "local" for the
// agent plane (loopback / system bearers) or the device session id for paired
// displays. Directed events (--on <device>) deliver only to one target;
// untargeted broadcasts reach everyone.
export const LOCAL_TARGET = "local";

// Layer-1 waiter presence (docs/interaction/delivery-ladder.md). A `surface wait`
// connection registers what it is eligible to claim, and only a claiming consumer
// registers at all — observers (`surface stream`, the PWA, `wait --no-ack`,
// `wait --event <non-action>`) must never suppress a binding they will not handle.
//
// Eligibility is (scope × action pattern). Registering the pattern matters: a
// waiter armed as `--id deploy --action approve` used to suppress the `reject`
// binding on the same surface even though it would never consume a reject.
export type WaiterScope =
  | { kind: "surface"; value: string }
  | { kind: "project"; value: string }
  | { kind: "all"; value: null };

export interface WaiterRegistration {
  scope: WaiterScope;
  // A single action name the waiter will take, or null for any action.
  action: string | null;
}

export type SSEClient = {
  id: string;
  res: Response;
  target: string;
  waiter?: WaiterRegistration | null;
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
  opts: { waiter?: WaiterRegistration | null; onClose?: (clientId: string) => void } = {},
): string {
  const id = String(++clientCounter);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.on("error", () => removeGlobalClient(id));
  globalClients.push({ id, res, target, waiter: opts.waiter ?? null });
  safeWrite(globalClients[globalClients.length - 1], ":\n\n", () => removeGlobalClient(id)); // heartbeat
  res.on("close", () => {
    removeGlobalClient(id);
    opts.onClose?.(id);
  });
  return id;
}

function waiterCovers(
  waiter: WaiterRegistration,
  target: { surfaceId: string; projectRoot: string | null; action?: string },
): boolean {
  const { scope } = waiter;
  const scopeMatches =
    scope.kind === "all" ||
    (scope.kind === "surface" && scope.value === target.surfaceId) ||
    // Exact project match only, and never for an unowned surface: a
    // project-scoped waiter must not absorb actions that belong to no repo.
    (scope.kind === "project" && target.projectRoot != null && scope.value === target.projectRoot);
  if (!scopeMatches) return false;
  // A waiter that registered an action predicate is only eligible for that
  // action — otherwise `wait --id deploy --action approve` would go on muting
  // the `reject` binding it is never going to handle.
  if (waiter.action && target.action !== undefined && waiter.action !== target.action) return false;
  return true;
}

export function getLiveWaiter(clientId: string): SSEClient | undefined {
  const client = globalClients.find((c) => c.id === clientId);
  return client && client.waiter ? client : undefined;
}

// May this specific waiter claim this specific action? Checked server-side on
// every claim so a waiter cannot take work outside the scope it registered.
export function isWaiterEligible(
  clientId: string,
  target: { surfaceId: string; projectRoot: string | null; action: string },
): boolean {
  const client = getLiveWaiter(clientId);
  return !!client && waiterCovers(client.waiter!, target);
}

// Is ANY live waiter eligible to claim this action? Decides whether layer 2
// waits out the waiter-first grace period before firing.
export function hasEligibleWaiter(target: {
  surfaceId: string;
  projectRoot: string | null;
  action?: string;
}): boolean {
  return globalClients.some((c) => c.waiter && waiterCovers(c.waiter, target));
}

// Back-compat shape for the card's "listening" pill: could any waiter take
// anything on this surface.
export function hasWaiter(surfaceId: string, action?: string, projectRoot?: string | null): boolean {
  return hasEligibleWaiter({ surfaceId, projectRoot: projectRoot ?? null, action });
}

export function sendToClient(clientId: string, event: string, data: unknown): void {
  const client = globalClients.find((c) => c.id === clientId);
  if (client) sendEvent(client, event, data, () => removeGlobalClient(client.id));
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
