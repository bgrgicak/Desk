import { useEffect, useState } from "react";
import { api } from "../api";
import type { Route } from "../app";

interface LibFile {
  id: string;
  name: string;
  mime: string;
  createdAt: string;
}

export function Library({ nav }: { nav: (r: Route) => void }) {
  const [files, setFiles] = useState<LibFile[]>([]);
  const [view, setView] = useState<"list" | "grid">("list");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data } = await api<{ items: LibFile[] }>("/library");
    setFiles(data.items ?? []);
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const contentBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    await api("/library", {
      method: "POST",
      body: { name: file.name, mime: file.type || "application/octet-stream", contentBase64 },
    });
    form.reset();
    await load();
  }

  return (
    <div>
      <h2>Library</h2>
      <button onClick={() => setView(view === "list" ? "grid" : "list")}>
        Switch to {view === "list" ? "grid" : "list"} view
      </button>

      <form onSubmit={handleUpload}>
        <label>
          Choose file
          <input type="file" name="file" />
        </label>
        <button type="submit">Upload to library</button>
      </form>

      {view === "list" ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td>
                  <a href="#" onClick={(e) => { e.preventDefault(); nav({ page: "library-item", id: f.id }); }}>
                    {f.name}
                  </a>
                </td>
                <td>{f.mime}</td>
                <td>{f.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul>
          {files.map((f) => (
            <li key={f.id}>
              <a href="#" onClick={(e) => { e.preventDefault(); nav({ page: "library-item", id: f.id }); }}>
                {f.name}
              </a>{" "}
              — {f.mime}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
