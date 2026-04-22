import { useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import { api } from "../api";
import { useApi, cacheInvalidate } from "../store";

interface WorkspaceData {
  id: string;
  name: string;
  description?: string;
  icon?: string;
}

interface AgentRow {
  id: string;
  name: string;
  isDefault: boolean;
}

export function Workspace() {
  const { data: workspaces } = useApi<WorkspaceData[]>("/workspaces");
  const ws = workspaces?.[0] ?? null;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [saved, setSaved] = useState<WorkspaceData | null>(null);

  const displayWs = saved ?? ws;

  useEffect(() => {
    if (displayWs) {
      setName(displayWs.name);
      setDescription(displayWs.description ?? "");
      setIcon(displayWs.icon ?? "");
    }
  }, [displayWs?.id]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!displayWs) return;
    const { data } = await api<WorkspaceData>(`/workspaces/${displayWs.id}`, {
      method: "PATCH",
      body: { name, description, icon },
    });
    setSaved(data);
  }

  async function handleDelete() {
    if (!displayWs) return;
    if (!confirm("Delete this workspace?")) return;
    await api(`/workspaces/${displayWs.id}`, { method: "DELETE" });
    setSaved(null);
  }

  if (!displayWs) return <p>No workspace found.</p>;

  return (
    <div>
      <h2>Workspace: {displayWs.name}</h2>
      <form onSubmit={handleSave}>
        <div>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Description
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Icon
            <input value={icon} onChange={(e) => setIcon(e.target.value)} />
          </label>
        </div>
        <button type="submit">Save workspace</button>
      </form>
      <button onClick={handleDelete}>Delete workspace</button>

      <hr />
      <WorkspaceAgents workspaceId={displayWs.id} />
    </div>
  );
}

function WorkspaceAgents({ workspaceId }: { workspaceId: string }) {
  const { data: enrolled } = useApi<AgentRow[]>(`/workspaces/${workspaceId}/agents`);
  const { data: allAgents } = useApi<AgentRow[]>("/agents");
  const dispatch = useDispatch();
  const [msg, setMsg] = useState("");

  const enrolledIds = new Set(enrolled?.map((a) => a.id) ?? []);
  const available = (allAgents ?? []).filter((a) => !enrolledIds.has(a.id));

  async function refresh() {
    dispatch(cacheInvalidate(`/workspaces/${workspaceId}/agents`));
    dispatch(cacheInvalidate("/agents"));
  }

  async function handleAdd(agentId: string) {
    await api(`/workspaces/${workspaceId}/agents`, {
      method: "POST",
      body: { agentId },
    });
    setMsg("Agent added.");
    await refresh();
  }

  async function handleRemove(agentId: string) {
    const res = await api(`/workspaces/${workspaceId}/agents/${agentId}`, {
      method: "DELETE",
    });
    if (res.status === 400) {
      setMsg("Cannot remove the default agent while others are enrolled.");
      return;
    }
    setMsg("Agent removed.");
    await refresh();
  }

  async function handleSetDefault(agentId: string) {
    await api(`/workspaces/${workspaceId}/default-agent`, {
      method: "POST",
      body: { agentId },
    });
    setMsg("Default agent updated.");
    await refresh();
  }

  return (
    <section>
      <h3>Agents in this workspace</h3>
      {msg && <p role="status">{msg}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Default</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(enrolled ?? []).map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td>{a.isDefault ? "default" : ""}</td>
              <td>
                {!a.isDefault && (
                  <button type="button" onClick={() => handleSetDefault(a.id)}>
                    Make default
                  </button>
                )}
                <button type="button" onClick={() => handleRemove(a.id)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {available.length > 0 && (
        <div>
          <h4>Add an existing agent</h4>
          <ul>
            {available.map((a) => (
              <li key={a.id}>
                {a.name}{" "}
                <button type="button" onClick={() => handleAdd(a.id)}>
                  Add
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
