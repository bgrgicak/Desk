import { useEffect, useState } from "react";
import { api } from "../api";

interface ScheduledJob {
  id: string;
  mode: string;
  spec: string;
  prompt: string;
  chatId?: string;
  state?: string;
}

interface Run {
  id: string;
  state: string;
  scheduledJobId?: string;
}

export function Scheduled() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [mode, setMode] = useState<"scheduled" | "recurring">("scheduled");
  const [spec, setSpec] = useState("");
  const [prompt, setPrompt] = useState("");
  const [chatId, setChatId] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data } = await api<Run[]>("/runs");
    const runs = Array.isArray(data) ? data : [];
    const jobMap = new Map<string, ScheduledJob>();
    for (const r of runs) {
      if (r.scheduledJobId && !jobMap.has(r.scheduledJobId)) {
        jobMap.set(r.scheduledJobId, {
          id: r.scheduledJobId,
          mode: "unknown",
          spec: "",
          prompt: "",
          state: r.state,
        });
      }
    }
    setJobs(Array.from(jobMap.values()));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, string> = { mode, spec, prompt };
    if (chatId) body.chatId = chatId;
    await api("/scheduled-jobs", { method: "POST", body });
    setSpec("");
    setPrompt("");
    setChatId("");
    await load();
  }

  async function handleCancel(jobId: string) {
    await api(`/scheduled-jobs/${jobId}`, { method: "DELETE" });
    await load();
  }

  return (
    <div>
      <h2>Scheduled Jobs</h2>

      <form onSubmit={handleCreate}>
        <div>
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as "scheduled" | "recurring")}>
              <option value="scheduled">Scheduled</option>
              <option value="recurring">Recurring</option>
            </select>
          </label>
        </div>
        <div>
          <label>
            Spec
            <input value={spec} onChange={(e) => setSpec(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Prompt
            <input value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Chat ID (optional)
            <input value={chatId} onChange={(e) => setChatId(e.target.value)} />
          </label>
        </div>
        <button type="submit">Create job</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Job ID</th>
            <th>State</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.id.slice(0, 8)}</td>
              <td>{j.state ?? "active"}</td>
              <td>
                <button onClick={() => handleCancel(j.id)}>Cancel</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
