import { useEffect, useState, useCallback } from "react";
import Markdown from "react-markdown";
import { api } from "../api";
import { onWsEvent } from "../ws";
import type { Route } from "../app";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface OpenCodeEvent { type: string; part?: Record<string, any>; [key: string]: any; }

interface MessageContent {
  type: string;
  text?: string;
  toolName?: string;
  events?: OpenCodeEvent[];
}

interface Message {
  id: string;
  chatId: string;
  role: string;
  content: MessageContent;
  createdAt: string;
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

/** Strip XML-like tool output tags (e.g. <path>, <content>, <entries>),
 *  keeping only their text content. */
function stripToolTags(text: string): string {
  return text.replace(/<\/?(path|type|content|entries|task_result)[^>]*>/g, "");
}

/** Detect fake-driver boilerplate and strip it to just the prompt echo. */
function cleanFakeDriverOutput(text: string): string | null {
  const m = text.match(
    /^Starting fake sandbox run\.\.\.\s*(?:System prompt:.*?\.\s*)?Processing prompt:\s*(.*?)\.\.\.\s*Fake response generated\.\s*Run complete\.$/s,
  );
  return m ? `[fake driver] ${m[1]}` : null;
}

function MessageText({ text }: { text: string }) {
  const fake = cleanFakeDriverOutput(text);
  if (fake) return <em style={{ fontSize: "0.85em", color: "#888" }}>{fake}</em>;
  return <Markdown>{stripToolTags(text)}</Markdown>;
}

function EventsRenderer({ events }: { events: OpenCodeEvent[] }) {
  return (
    <>
      {events.map((ev, i) => {
        switch (ev.type) {
          case "text":
            return <Markdown key={i}>{stripToolTags(ev.part?.text ?? "")}</Markdown>;
          case "tool_use": {
            const tool = ev.part?.tool ?? "tool";
            const status = ev.part?.state?.status ?? "";
            const output = ev.part?.state?.output;
            return (
              <details key={i} style={{ margin: "0.25em 0" }}>
                <summary style={{ cursor: "pointer", fontSize: "0.85em", color: "#666" }}>
                  {tool}{status ? ` — ${status}` : ""}
                </summary>
                {typeof output === "string" && (
                  <Markdown>{stripToolTags(output)}</Markdown>
                )}
              </details>
            );
          }
          case "step_start":
          case "step_finish": {
            if (ev.type === "step_start") return null;
            const tokens = ev.part?.tokens as Record<string, number> | undefined;
            const cost = ev.part?.cost as number | undefined;
            const parts: string[] = [];
            if (tokens?.input != null) parts.push(`in: ${tokens.input}`);
            if (tokens?.output != null) parts.push(`out: ${tokens.output}`);
            if (cost != null) parts.push(`$${cost.toFixed(4)}`);
            if (parts.length === 0) return null;
            return (
              <div key={i} style={{ fontSize: "0.75em", color: "#999" }}>
                {parts.join(" · ")}
              </div>
            );
          }
          default:
            return null;
        }
      })}
    </>
  );
}

export function Chat({ id, nav }: { id: string; nav: (r: Route) => void }) {
  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [content, setContent] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editGoal, setEditGoal] = useState("");
  const [editing, setEditing] = useState(false);

  const loadMessages = useCallback(async () => {
    const { data } = await api<{ items: Message[] }>(`/chats/${id}/messages`);
    setMessages(data.items ?? []);
  }, [id]);

  const loadArtifacts = useCallback(async () => {
    const { data } = await api<Artifact[]>(`/chats/${id}/artifacts`);
    setArtifacts(Array.isArray(data) ? data : []);
  }, [id]);

  useEffect(() => {
    (async () => {
      const { data } = await api<ChatDetail>(`/chats/${id}`);
      setChat(data);
      setEditTitle(data.title);
      setEditGoal(data.goal ?? "");
    })();
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
    setChat((prev) => prev ? { ...prev, title: editTitle, goal: editGoal } : prev);
    setEditing(false);
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const contentBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    await api(`/chats/${id}/artifacts`, {
      method: "POST",
      body: { name: file.name, mime: file.type || "application/octet-stream", contentBase64 },
    });
    form.reset();
  }

  if (!chat) return <p>Loading...</p>;

  return (
    <div>
      <h2>Chat: {chat.title}</h2>
      {chat.goal && <p>Goal: {chat.goal}</p>}

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

      <h3>Messages</h3>
      <ol>
        {messages.map((m) => (
          <li key={m.id}>
            <strong>{m.role}:</strong>{" "}
            {m.content.type === "text" ? (
              <MessageText text={m.content.text ?? ""} />
            ) : m.content.type === "events" ? (
              <EventsRenderer events={m.content.events ?? []} />
            ) : m.content.type === "toolCall" ? (
              `[tool: ${m.content.toolName}]`
            ) : (
              `[${m.content.type}]`
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
