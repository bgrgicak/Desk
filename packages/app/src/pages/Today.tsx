import { useState } from "react";
import { api } from "../api";
import { useApi, cacheInvalidate } from "../store";
import { useDispatch } from "react-redux";
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
  const { data: chats } = useApi<ChatSummary[]>("/chats");
  const { data: workspaces } = useApi<{ id: string }[]>("/workspaces");
  const { data: agents } = useApi<{ id: string }[]>("/agents");
  const dispatch = useDispatch();
  const [message, setMessage] = useState("");

  const workspaceId = workspaces?.[0]?.id ?? "";
  const agentId = agents?.[0]?.id ?? "";

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !agentId || !message.trim()) return;
    const title = message.trim().slice(0, 80);
    const { status, data } = await api<{ id: string }>("/chats", {
      method: "POST",
      body: { workspaceId, agentId, title },
    });
    if (status === 201 || status === 200) {
      await api(`/chats/${data.id}/messages`, {
        method: "POST",
        body: { content: message.trim() },
      });
      setMessage("");
      dispatch(cacheInvalidate("/chats"));
      nav({ page: "chat", id: data.id });
    }
  }

  return (
    <div>
      <h2>Today</h2>
      <form onSubmit={handleCreate}>
        <label>
          Message
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={'e.g. "Summarize my recent emails", "Draft a blog post about AI"'}
          />
        </label>
        <button type="submit">New chat</button>
      </form>
      {chats && chats.length === 0 && <p>No chats yet.</p>}
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
          {(chats ?? []).map((c) => (
            <tr key={c.id}>
              <td>
                <a href={`/chat/${c.id}`} onClick={(e) => { e.preventDefault(); nav({ page: "chat", id: c.id }); }}>
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
