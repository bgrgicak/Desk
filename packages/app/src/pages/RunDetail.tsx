import { useEffect, useState } from "react";
import { api } from "../api";
import { useApi } from "../store";
import { EventsRenderer, MessageText, type OpenCodeEvent } from "../MessageRenderers";
import type { Route } from "../app";

interface Run {
  id: string;
  state: string;
  chatId?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface LogEntry {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}

/** Try to parse a log entry's payload.text as a JSON OpenCode event. */
function parseLogEvents(entries: LogEntry[]): OpenCodeEvent[] {
  const events: OpenCodeEvent[] = [];
  let partial = "";

  for (const entry of entries) {
    const raw = typeof entry.payload.text === "string" ? entry.payload.text : "";
    if (!raw) continue;

    if (entry.kind === "stderr") {
      events.push({ type: "text", part: { text: raw } });
      continue;
    }

    // stdout: try parsing as JSON OpenCode events (may span multiple chunks)
    for (const line of raw.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      const candidate = partial ? partial + l : l;
      try {
        const obj = JSON.parse(candidate);
        partial = "";
        events.push(obj as OpenCodeEvent);
      } catch {
        if (candidate.startsWith("{")) {
          partial = candidate;
        } else {
          partial = "";
          // Plain text line — render as text event
          events.push({ type: "text", part: { text: l } });
        }
      }
    }
  }

  return events;
}

export function RunDetail({ id, nav }: { id: string; nav: (r: Route) => void }) {
  const { data: run } = useApi<Run>(`/runs/${id}`);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [runState, setRunState] = useState<Run | null>(null);

  const displayRun = runState ?? run;

  useEffect(() => {
    setRunState(null);
    setLogs([]);
    setCursor(null);
    setHasMore(true);
    loadLogs();
  }, [id]);

  async function loadLogs(c?: number) {
    const qs = c != null ? `?cursor=${c}` : "";
    const { data } = await api<{ items: LogEntry[]; nextCursor?: number }>(`/runs/${id}/logs${qs}`);
    const items = data.items ?? [];
    if (c != null) {
      setLogs((prev) => [...prev, ...items]);
    } else {
      setLogs(items);
    }
    if (data.nextCursor != null) {
      setCursor(data.nextCursor);
    } else {
      setHasMore(false);
    }
  }

  const events = parseLogEvents(logs);

  if (!displayRun) return <p>Loading...</p>;

  return (
    <div>
      <h2>Run {displayRun.id.slice(0, 8)}</h2>
      <dl>
        <dt>State</dt>
        <dd>{displayRun.state}</dd>
        <dt>Started</dt>
        <dd>{displayRun.startedAt ?? "—"}</dd>
        <dt>Finished</dt>
        <dd>{displayRun.finishedAt ?? "—"}</dd>
      </dl>

      {!["completed", "failed", "cancelled", "succeeded"].includes(displayRun.state) && (
        <button onClick={async () => {
          await api(`/runs/${id}/cancel`, { method: "POST" });
          const { data } = await api<Run>(`/runs/${id}`);
          setRunState(data);
        }}>
          Cancel run
        </button>
      )}

      <h3>Logs</h3>
      {events.length > 0 ? (
        <EventsRenderer events={events} />
      ) : (
        <p style={{ color: "#888" }}>No log entries yet.</p>
      )}
      {hasMore && cursor != null && (
        <button onClick={() => loadLogs(cursor)}>Load more</button>
      )}

      <p>
        <button onClick={() => nav({ page: "runs" })}>Back to runs</button>
      </p>
    </div>
  );
}
