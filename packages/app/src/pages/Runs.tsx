import { api } from "../api";
import { useApi, cacheInvalidate } from "../store";
import { useDispatch } from "react-redux";
import type { Route } from "../app";

interface Run {
  id: string;
  kind: string;
  state: string;
  chatId?: string;
  startedAt?: string;
  finishedAt?: string;
}

export function Runs({ nav }: { nav: (r: Route) => void }) {
  const { data: runs } = useApi<Run[]>("/runs");
  const dispatch = useDispatch();

  async function cancel(runId: string) {
    await api(`/runs/${runId}/cancel`, { method: "POST" });
    dispatch(cacheInvalidate("/runs"));
  }

  return (
    <div>
      <h2>Runs</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Kind</th>
            <th>State</th>
            <th>Chat</th>
            <th>Started</th>
            <th>Finished</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {(Array.isArray(runs) ? runs : []).map((r) => (
            <tr key={r.id}>
              <td>
                <a href={`/runs/${r.id}`} onClick={(e) => { e.preventDefault(); nav({ page: "run-detail", id: r.id }); }}>
                  {r.id.slice(0, 8)}
                </a>
              </td>
              <td>{r.kind}</td>
              <td>{r.state}</td>
              <td>
                {r.chatId ? (
                  <a href={`/chat/${r.chatId}`} onClick={(e) => { e.preventDefault(); nav({ page: "chat", id: r.chatId! }); }}>
                    {r.chatId.slice(0, 8)}
                  </a>
                ) : "—"}
              </td>
              <td>{r.startedAt ?? "—"}</td>
              <td>{r.finishedAt ?? "—"}</td>
              <td>
                {!["completed", "failed", "cancelled"].includes(r.state) && (
                  <button onClick={() => cancel(r.id)}>Cancel</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
