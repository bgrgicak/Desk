import { useEffect, useState } from "react";
import { api } from "../api";

interface WorkspaceData {
  id: string;
  name: string;
  description?: string;
  icon?: string;
}

export function Workspace() {
  const [ws, setWs] = useState<WorkspaceData | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await api<WorkspaceData[]>("/workspaces");
      if (data.length) {
        const w = data[0];
        setWs(w);
        setName(w.name);
        setDescription(w.description ?? "");
        setIcon(w.icon ?? "");
      }
    })();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!ws) return;
    const { data } = await api<WorkspaceData>(`/workspaces/${ws.id}`, {
      method: "PATCH",
      body: { name, description, icon },
    });
    setWs(data);
  }

  async function handleDelete() {
    if (!ws) return;
    if (!confirm("Delete this workspace?")) return;
    await api(`/workspaces/${ws.id}`, { method: "DELETE" });
    setWs(null);
  }

  if (!ws) return <p>No workspace found.</p>;

  return (
    <div>
      <h2>Workspace: {ws.name}</h2>
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
    </div>
  );
}
