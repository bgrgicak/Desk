import { useEffect, useState } from "react";
import { api } from "../api";
import type { Route } from "../app";

interface Run {
  id: string;
  state: string;
  chatId: string;
  startedAt: string;
  finishedAt?: string;
}

interface LogEntry {
  seq: number;
  kind: string;
  payload: string;
}

export function RunDetail({ id, nav }: { id: string; nav: (r: Route) => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await api<Run>(`/runs/${id}`);
      setRun(data);
    })();
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

  if (!run) return <p>Loading...</p>;

  return (
    <div>
      <h2>Run {run.id.slice(0, 8)}</h2>
      <dl>
        <dt>State</dt>
        <dd>{run.state}</dd>
        <dt>Started</dt>
        <dd>{run.startedAt}</dd>
        <dt>Finished</dt>
        <dd>{run.finishedAt ?? "—"}</dd>
      </dl>

      {!["completed", "failed", "cancelled"].includes(run.state) && (
        <button onClick={async () => {
          await api(`/runs/${id}/cancel`, { method: "POST" });
          const { data } = await api<Run>(`/runs/${id}`);
          setRun(data);
        }}>
          Cancel run
        </button>
      )}

      <h3>Logs</h3>
      <ol>
        {logs.map((l, i) => (
          <li key={i}>[{l.kind}] {l.payload}</li>
        ))}
      </ol>
      {hasMore && cursor != null && (
        <button onClick={() => loadLogs(cursor)}>Load more</button>
      )}

      <p>
        <button onClick={() => nav({ page: "runs" })}>Back to runs</button>
      </p>
    </div>
  );
}
