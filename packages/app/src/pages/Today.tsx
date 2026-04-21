import { useEffect, useState } from "react";
import { api } from "../api";
import type { Route } from "../app";

interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  awaitingUser: boolean;
  unread: boolean;
  lastMessage?: string;
}

export function Today({ nav }: { nav: (r: Route) => void }) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [title, setTitle] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    load();
    loadDefaults();
  }, []);

  async function loadDefaults() {
    const ws = await api<{ id: string }[]>("/workspaces");
    if (ws.data.length) setWorkspaceId(ws.data[0].id);
    const ag = await api<{ id: string }[]>("/agents");
    if (ag.data.length) setAgentId(ag.data[0].id);
  }

  async function load() {
    const { data } = await api<ChatSummary[]>("/chats");
    setChats(data);
    setLoaded(true);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !agentId) return;
    const { status, data } = await api<{ id: string }>("/chats", {
      method: "POST",
      body: { workspaceId, agentId, title: title || "Untitled" },
    });
    if (status === 201 || status === 200) {
      setTitle("");
      nav({ page: "chat", id: data.id });
    }
  }

  return (
    <div>
      <h2>Today</h2>
      <form onSubmit={handleCreate}>
        <label>
          New chat title
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <button type="submit">New chat</button>
      </form>
      {loaded && chats.length === 0 && <p>No chats yet.</p>}
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Updated</th>
            <th>Awaiting</th>
            <th>Unread</th>
            <th>Last message</th>
          </tr>
        </thead>
        <tbody>
          {chats.map((c) => (
            <tr key={c.id}>
              <td>
                <a href="#" onClick={(e) => { e.preventDefault(); nav({ page: "chat", id: c.id }); }}>
                  {c.title}
                </a>
              </td>
              <td>{c.updatedAt}</td>
              <td>{c.awaitingUser ? "Yes" : "No"}</td>
              <td>{c.unread ? "Yes" : "No"}</td>
              <td>{c.lastMessage ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
