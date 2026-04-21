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

export function Runs({ nav }: { nav: (r: Route) => void }) {
  const [runs, setRuns] = useState<Run[]>([]);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data } = await api<Run[]>("/runs");
    setRuns(Array.isArray(data) ? data : []);
  }

  return (
    <div>
      <h2>Runs</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>State</th>
            <th>Chat</th>
            <th>Started</th>
            <th>Finished</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <a href="#" onClick={(e) => { e.preventDefault(); nav({ page: "run-detail", id: r.id }); }}>
                  {r.id.slice(0, 8)}
                </a>
              </td>
              <td>{r.state}</td>
              <td>
                <a href="#" onClick={(e) => { e.preventDefault(); nav({ page: "chat", id: r.chatId }); }}>
                  {r.chatId.slice(0, 8)}
                </a>
              </td>
              <td>{r.startedAt}</td>
              <td>{r.finishedAt ?? "—"}</td>
              <td>
                {!["completed", "failed", "cancelled"].includes(r.state) && (
                  <button onClick={async () => { await api(`/runs/${r.id}/cancel`, { method: "POST" }); load(); }}>
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
