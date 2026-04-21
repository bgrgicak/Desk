import { useEffect, useState } from "react";
import { api, getBaseUrl, getToken } from "../api";
import type { Route } from "../app";

interface LibFileMeta {
  id: string;
  name: string;
  mime: string;
  createdAt: string;
}

export function LibraryItem({ id, nav }: { id: string; nav: (r: Route) => void }) {
  const [meta, setMeta] = useState<LibFileMeta | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await api<LibFileMeta>(`/library/${id}`);
      setMeta(data);
    })();
  }, [id]);

  async function handleDownload() {
    const token = getToken();
    const res = await fetch(`${getBaseUrl()}/library/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = meta?.name ?? "file";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleNote(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    await api(`/library/${id}/note`, { method: "POST", body: { text: note } });
    setNote("");
  }

  async function handleDelete() {
    if (!confirm("Delete this file?")) return;
    await api(`/library/${id}`, { method: "DELETE" });
    nav({ page: "library" });
  }

  if (!meta) return <p>Loading...</p>;

  return (
    <div>
      <h2>Library: {meta.name}</h2>
      <dl>
        <dt>Type</dt>
        <dd>{meta.mime}</dd>
        <dt>Created</dt>
        <dd>{meta.createdAt}</dd>
      </dl>
      <button onClick={handleDownload}>Download</button>
      <button onClick={handleDelete}>Delete</button>

      <h3>Add note</h3>
      <form onSubmit={handleNote}>
        <label>
          Note
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="submit">Add note</button>
      </form>

      <p>
        <button onClick={() => nav({ page: "library" })}>Back to library</button>
      </p>
    </div>
  );
}
