import { useState } from "react";
import { api } from "../api";
import { useApi, cacheInvalidate } from "../store";
import { useDispatch } from "react-redux";
import { parseSchedule } from "../parseSchedule";

interface JobSpec {
  type: string;
  onceAt?: string;
  cronExpr?: string;
}

interface ScheduledJob {
  id: string;
  kind: string;
  spec: JobSpec;
  chatId?: string;
  active: boolean;
}

function formatSpec(spec: JobSpec): string {
  if (spec.type === "once" && spec.onceAt) return spec.onceAt;
  if (spec.type === "recurring" && spec.cronExpr) return spec.cronExpr;
  return spec.type;
}

function formatKind(kind: string): string {
  if (kind === "once") return "One-time";
  if (kind === "recurring") return "Recurring";
  return kind;
}

export function Scheduled() {
  const { data: jobs } = useApi<ScheduledJob[]>("/scheduled-jobs");
  const dispatch = useDispatch();
  const [mode, setMode] = useState<"scheduled" | "recurring">("scheduled");
  const [when, setWhen] = useState("");
  const [prompt, setPrompt] = useState("");
  const [chatId, setChatId] = useState("");
  const [parseError, setParseError] = useState("");

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const result = parseSchedule(mode, when);
    if (result.error) {
      setParseError(result.error);
      return;
    }
    setParseError("");
    const body: Record<string, string> = { mode, spec: result.spec, prompt };
    if (chatId) body.chatId = chatId;
    await api("/scheduled-jobs", { method: "POST", body });
    setWhen("");
    setPrompt("");
    setChatId("");
    dispatch(cacheInvalidate("/scheduled-jobs"));
  }

  async function handleCancel(jobId: string) {
    await api(`/scheduled-jobs/${jobId}`, { method: "DELETE" });
    dispatch(cacheInvalidate("/scheduled-jobs"));
  }

  const jobList = Array.isArray(jobs) ? jobs : [];

  return (
    <div>
      <h2>Scheduled Jobs</h2>

      <form onSubmit={handleCreate}>
        <div>
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as "scheduled" | "recurring")}>
              <option value="scheduled">One-time</option>
              <option value="recurring">Recurring</option>
            </select>
          </label>
        </div>
        <div>
          <label>
            When
            <input
              value={when}
              onChange={(e) => { setWhen(e.target.value); setParseError(""); }}
              placeholder={mode === "scheduled" ? "in 5 minutes, tomorrow at 9am" : "every monday at 9, every 30 minutes"}
              style={{ minWidth: 300 }}
              required
            />
          </label>
          {parseError && <div style={{ color: "red" }}>{parseError}</div>}
        </div>
        <div>
          <label>
            Prompt
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Summarize today's emails"
              style={{ minWidth: 300 }}
              required
            />
          </label>
        </div>
        <div>
          <label>
            Chat ID (optional)
            <input
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="Leave empty for a standalone run"
              style={{ minWidth: 300 }}
            />
          </label>
        </div>
        <button type="submit">Create job</button>
      </form>

      {jobList.length === 0 ? (
        <p>No scheduled jobs.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Job ID</th>
              <th>Type</th>
              <th>When</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobList.map((j) => (
              <tr key={j.id}>
                <td>{j.id.slice(0, 12)}</td>
                <td>{formatKind(j.kind)}</td>
                <td>{formatSpec(j.spec)}</td>
                <td>
                  <button onClick={() => handleCancel(j.id)}>Cancel</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
