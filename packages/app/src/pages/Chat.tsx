import { useEffect, useState, useCallback } from "react";
import { api } from "../api";
import { useApi } from "../store";
import { onWsEvent } from "../ws";
import { MessageText, EventsRenderer, type OpenCodeEvent } from "../MessageRenderers";
import type { Route } from "../app";

interface MessageContent {
  type: string;
  text?: string;
  toolName?: string;
  events?: OpenCodeEvent[];
  body?: string;
  path?: string;
  name?: string;
}

interface Message {
  id: string;
  chatId: string;
  role: string;
  content: MessageContent;
  createdAt: string;
  state?: string;
  parentId?: string;
}

interface ChatDetail {
  id: string;
  title: string;
  goal?: string;
}

interface Artifact {
  id: string;
  name: string;
  mime: string;
}

export function Chat({ id, nav }: { id: string; nav: (r: Route) => void }) {
  const { data: chat } = useApi<ChatDetail>(`/chats/${id}`);
  const [messages, setMessages] = useState<Message[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [content, setContent] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editGoal, setEditGoal] = useState("");
  const [editing, setEditing] = useState(false);
  const [chatState, setChatState] = useState<ChatDetail | null>(null);

  const displayChat = chatState ?? chat;

  // Sync edit fields when cached chat data arrives
  useEffect(() => {
    if (displayChat) {
      setEditTitle(displayChat.title);
      setEditGoal(displayChat.goal ?? "");
    }
  }, [displayChat?.id]);

  const loadMessages = useCallback(async () => {
    const { data } = await api<{ items: Message[] }>(`/chats/${id}/messages`);
    setMessages(data.items ?? []);
  }, [id]);

  const loadArtifacts = useCallback(async () => {
    const { data } = await api<Artifact[]>(`/chats/${id}/artifacts`);
    setArtifacts(Array.isArray(data) ? data : []);
  }, [id]);

  useEffect(() => {
    setChatState(null);
    loadMessages();
    loadArtifacts();
  }, [id, loadMessages, loadArtifacts]);

  useEffect(() => {
    const unsub = onWsEvent((ev) => {
      if (ev.type === "message.appended") {
        const msg = ev.payload as Message;
        if (msg.chatId === id) {
          setMessages((prev) =>
            prev.some((m) => m.id === msg.id) ? prev : [...prev, msg],
          );
        }
      } else if (ev.type === "message.updated") {
        const msg = ev.payload as Message;
        if (msg.chatId === id) {
          setMessages((prev) => {
            const found = prev.some((m) => m.id === msg.id);
            if (!found) return [...prev, msg];
            return prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m));
          });
        }
      } else if (ev.type === "artifact.created") {
        const art = ev.payload as Artifact & { chatId?: string };
        if (art.chatId === id) {
          setArtifacts((prev) =>
            prev.some((a) => a.id === art.id) ? prev : [...prev, art],
          );
        }
      }
    });
    return unsub;
  }, [id]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    await api(`/chats/${id}/messages`, { method: "POST", body: { content } });
    setContent("");
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    await api(`/chats/${id}`, {
      method: "PATCH",
      body: { title: editTitle, goal: editGoal },
    });
    setChatState((prev) => {
      const base = prev ?? displayChat;
      return base ? { ...base, title: editTitle, goal: editGoal } : null;
    });
    setEditing(false);
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file, file.name);
    await api(`/chats/${id}/artifacts`, {
      method: "POST",
      body: fd,
    });
    form.reset();
  }

  if (!displayChat) return <p>Loading...</p>;

  return (
    <div>
      <h2>Chat: {displayChat.title}</h2>
      {displayChat.goal && <p>Goal: {displayChat.goal}</p>}

      <button onClick={() => setEditing(!editing)}>
        {editing ? "Cancel edit" : "Edit chat"}
      </button>
      {editing && (
        <form onSubmit={handleUpdate}>
          <label>
            Title
            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
          </label>
          <label>
            Goal
            <input value={editGoal} onChange={(e) => setEditGoal(e.target.value)} />
          </label>
          <button type="submit">Save</button>
        </form>
      )}

      {(() => {
        // Pin the latest note-content message at the top of the chat.
        const latestNote = [...messages]
          .reverse()
          .find((m) => m.content.type === "note");
        if (!latestNote) return null;
        return (
          <section aria-label="Chat note">
            <h3>Note</h3>
            <NotePinned message={latestNote} chatId={id} onSaved={loadMessages} />
          </section>
        );
      })()}

      <h3>Messages</h3>
      <ol>
        {messages
          .filter((m) => m.content.type !== "ai_note_request" && m.content.type !== "agent_turn")
          .map((m) => (
            <li key={m.id}>
              <strong>{m.role}:</strong>{" "}
              {m.content.type === "text" ? (
                <MessageText text={m.content.text ?? ""} />
              ) : m.content.type === "events" ? (
                <EventsRenderer events={m.content.events ?? []} />
              ) : m.content.type === "note" ? (
                <em>[note — see pinned above]</em>
              ) : m.content.type === "toolCall" ? (
                `[tool: ${m.content.toolName}]`
              ) : (
                `[${m.content.type}]`
              )}
              {m.state && m.state !== "succeeded" && (
                <span> ({m.state})</span>
              )}
            </li>
          ))}
      </ol>

      <form onSubmit={sendMessage}>
        <label>
          Message
          <input
            type="text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Type a message..."
          />
        </label>
        <button type="submit">Send</button>
      </form>

      <h3>Artifacts</h3>
      <ul>
        {artifacts.map((a) => (
          <li key={a.id}>{a.name} ({a.mime})</li>
        ))}
      </ul>
      <form onSubmit={handleUpload}>
        <label>
          Choose artifact
          <input type="file" name="file" />
        </label>
        <button type="submit">Upload artifact</button>
      </form>

      <p>
        <button onClick={() => nav({ page: "today" })}>Back to chats</button>
      </p>
    </div>
  );
}

function NotePinned({
  message,
  chatId,
  onSaved,
}: {
  message: Message;
  chatId: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(message.content.body ?? "");

  useEffect(() => {
    setBody(message.content.body ?? "");
  }, [message.id, message.content.body]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await api(`/chats/${chatId}/messages/${message.id}`, {
      method: "PATCH",
      body: { content: { type: "note", body } },
    });
    setEditing(false);
    onSaved();
  }

  if (editing) {
    return (
      <form onSubmit={handleSave}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          style={{ width: "100%" }}
        />
        <div>
          <button type="submit">Save note</button>
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div>
      <pre style={{ whiteSpace: "pre-wrap" }}>{message.content.body}</pre>
      <button type="button" onClick={() => setEditing(true)}>
        Edit note
      </button>
    </div>
  );
}
