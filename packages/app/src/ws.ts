import { getToken, getBaseUrl } from "./api";

type Listener = (event: { type: string; payload: unknown }) => void;

let ws: WebSocket | null = null;
let listeners: Listener[] = [];

export function connectWs() {
  const token = getToken();
  if (!token) return;
  const base = getBaseUrl().replace(/^http/, "ws");
  ws = new WebSocket(`${base}/ws?token=${token}`);
  ws.onmessage = (ev) => {
    try {
      const parsed = JSON.parse(ev.data);
      for (const fn of listeners) fn(parsed);
    } catch {
      // ignore non-JSON frames
    }
  };
  ws.onclose = () => {
    ws = null;
  };
}

export function disconnectWs() {
  if (ws) {
    ws.close();
    ws = null;
  }
}

export function onWsEvent(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}
