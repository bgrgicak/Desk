import { serializeWsEvent, type WsEvent } from "@roomy-ai/shared";

interface WsLike {
  send(data: string): void;
  readyState: number;
}

const OPEN = 1;

/** Per-user WebSocket connection registry. */
const connections = new Map<string, Set<WsLike>>();

export function addConnection(userId: string, ws: WsLike): void {
  if (!connections.has(userId)) {
    connections.set(userId, new Set());
  }
  connections.get(userId)!.add(ws);
}

export function removeConnection(userId: string, ws: WsLike): void {
  const set = connections.get(userId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) connections.delete(userId);
  }
}

/**
 * Broadcasts a WS event to all sockets for a given user.
 * Prunes dead sockets.
 */
export function broadcast(userId: string, event: WsEvent): void {
  const set = connections.get(userId);
  if (!set) return;

  const serialized = serializeWsEvent(event);
  const dead: WsLike[] = [];

  for (const ws of set) {
    if (ws.readyState === OPEN) {
      try {
        ws.send(serialized);
      } catch {
        dead.push(ws);
      }
    } else {
      dead.push(ws);
    }
  }

  for (const ws of dead) {
    set.delete(ws);
  }
}

/** Clears all connections. For testing. */
export function clearConnections(): void {
  connections.clear();
}

/** Returns the total number of connected sockets. For testing. */
export function connectionCount(): number {
  let count = 0;
  for (const set of connections.values()) {
    count += set.size;
  }
  return count;
}
