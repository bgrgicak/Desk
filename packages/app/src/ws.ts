import { getToken, getBaseUrl } from "./api";

type Listener = (event: { type: string; payload: unknown }) => void;

let ws: WebSocket | null = null;
let listeners: Listener[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let intentionalClose = false;

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];
let reconnectAttempt = 0;

export function connectWs() {
  const token = getToken();
  if (!token) return;
  intentionalClose = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const base = getBaseUrl().replace(/^http/, "ws");
  ws = new WebSocket(`${base}/ws?token=${token}`);
  ws.onopen = () => {
    reconnectAttempt = 0;
  };
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
    if (!intentionalClose) scheduleReconnect();
  };
}

function scheduleReconnect() {
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, delay);
}

export function disconnectWs() {
  intentionalClose = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
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
