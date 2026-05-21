import type { Store } from "@reduxjs/toolkit";
import type { RootState } from "@/store/store";
import { getSessionToken } from "@/auth/session";

/**
 * The browser tags any main-thread task that runs ≥50ms as a "long task";
 * the PerformanceObserver API surfaces them directly. That threshold maps
 * exactly to "the user sees a dropped frame," which is what we want to
 * track in prod — not React render time, not bundle size, but observed
 * jank.
 *
 * The reporter buffers entries, attaches Redux-derived context (which
 * chat the user was viewing, whether a turn was streaming), and POSTs a
 * batch every FLUSH_INTERVAL_MS or when the buffer fills. Send is best-
 * effort: failures drop on the floor rather than retry, because reporting
 * jank shouldn't add jank.
 */

const LONG_TASK_THRESHOLD_MS = 50;
const FLUSH_INTERVAL_MS = 5_000;
const MAX_BUFFER = 50;

interface BufferedEntry {
  duration: number;
  startTime: number;
  name?: string;
  chatId?: string;
  streaming?: boolean;
  url?: string;
  heapUsedMb?: number;
}

let installed = false;
let buffer: BufferedEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

interface PerformanceMemory {
  usedJSHeapSize: number;
}

function chatRunningFromCache(state: RootState, chatId: string): boolean | undefined {
  // The chat's `running` flag now rides on every cached `ServerChat`
  // row; scan any `getChats` cache entry for the chat id rather than
  // wiring a dedicated selector through here.
  const apiState = (state as unknown as Record<string, unknown>)["api"] as
    | { queries?: Record<string, { data?: unknown }> }
    | undefined;
  if (!apiState?.queries) return undefined;
  for (const entry of Object.values(apiState.queries)) {
    const data = entry?.data as { id?: string; running?: boolean }[] | undefined;
    if (!Array.isArray(data)) continue;
    const chat = data.find((c) => c?.id === chatId);
    if (chat) return Boolean(chat.running);
  }
  return undefined;
}

function currentHeapMb(): number | undefined {
  // performance.memory is Chromium-only and not in lib.dom.d.ts; soft-cast
  // and feature-detect so other browsers just omit the field.
  const mem = (performance as unknown as { memory?: PerformanceMemory }).memory;
  if (!mem || typeof mem.usedJSHeapSize !== "number") return undefined;
  return Math.round(mem.usedJSHeapSize / (1024 * 1024));
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const entries = buffer;
  buffer = [];

  const token = getSessionToken();
  if (!token) return;

  const body = JSON.stringify({ entries });
  try {
    // keepalive=true lets the request survive a tab navigation; small
    // payloads (well under 64KB) are allowed under that constraint. Bigger
    // batches won't ever hit this — MAX_BUFFER × ~200 bytes per entry caps
    // us well below the limit.
    await fetch("/api/client-perf", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      keepalive: true,
    });
  } catch {
    // Reporting jank shouldn't add jank — drop on failure.
  }
}

/**
 * Install the long-task observer. Idempotent. Safe to call before the
 * user is authenticated; entries buffer until a session exists.
 *
 * Returns a teardown for tests and HMR; production callers ignore it.
 */
export function installPerfReporter(store: Store<RootState>): () => void {
  if (installed) return () => undefined;
  if (typeof PerformanceObserver === "undefined") return () => undefined;
  // Chrome >= 58 supports "longtask". Older Safari versions don't —
  // feature-detect via supportedEntryTypes to skip cleanly.
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (!supported.includes("longtask")) return () => undefined;

  installed = true;

  const observer = new PerformanceObserver((list) => {
    const state = store.getState();
    const chatId = state.derived.viewingChatId ?? undefined;
    const streaming = chatId ? chatRunningFromCache(state, chatId) : undefined;
    const url = typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search}`
      : undefined;
    const heapUsedMb = currentHeapMb();

    for (const entry of list.getEntries()) {
      if (entry.duration < LONG_TASK_THRESHOLD_MS) continue;
      buffer.push({
        duration: entry.duration,
        startTime: entry.startTime,
        name: entry.name,
        chatId,
        streaming,
        url,
        heapUsedMb,
      });
      if (buffer.length >= MAX_BUFFER) {
        // Drop oldest first — fresh entries are more diagnostic when a
        // long-running incident is filling the buffer faster than we can
        // ship it out.
        buffer = buffer.slice(buffer.length - MAX_BUFFER);
      }
    }

    if (buffer.length > 0) scheduleFlush();
  });

  observer.observe({ type: "longtask", buffered: true });

  // Flush on visibility change too — when the user tabs away, the regular
  // 5-second timer may not fire before the browser parks the tab.
  const visibilityHandler = () => {
    if (document.visibilityState === "hidden" && buffer.length > 0) {
      void flush();
    }
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  return () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", visibilityHandler);
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    installed = false;
  };
}
