import { api, getBaseUrl, getToken } from "../api";
import { useApi, cacheInvalidate } from "../store";
import { useDispatch } from "react-redux";
import type { Route } from "../app";

interface LibFileMeta {
  id: string;
  name: string;
  mime: string;
  createdAt: string;
}

export function LibraryItem({ id, nav }: { id: string; nav: (r: Route) => void }) {
  const { data: meta } = useApi<LibFileMeta>(`/library/${id}`);
  const dispatch = useDispatch();

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

  async function handleDelete() {
    if (!confirm("Delete this file?")) return;
    await api(`/library/${id}`, { method: "DELETE" });
    dispatch(cacheInvalidate("/library"));
    dispatch(cacheInvalidate(`/library/${id}`));
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

      <p>
        <button onClick={() => nav({ page: "library" })}>Back to library</button>
      </p>
    </div>
  );
}
