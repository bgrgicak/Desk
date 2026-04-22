import { useEffect, useState } from "react";
import { api } from "../api";
import { useApi } from "../store";

interface WorkspaceData {
  id: string;
  name: string;
  description?: string;
  icon?: string;
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
    </div>
  );
}
