import { useEffect, useState, useCallback } from "react";
import Markdown from "react-markdown";
import { api } from "../api";
import { onWsEvent } from "../ws";
import type { Route } from "../app";

interface MessageContent {
  type: string;
  text?: string;
  toolName?: string;
}

interface Message {
  id: string;
  role: string;
  content: MessageContent;
  createdAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonEvent = Record<string, any>;

const KNOWN_EVENT_TYPES = new Set([
  "text", "step_start", "step_finish", "tool_use",
]);

/**
 * Extract top-level JSON objects from a string. Tries JSON.parse first
 * (fast path for well-formed single objects or newline-delimited JSON).
 * Falls back to a regex-based key extractor for malformed JSON where
 * string values contain unescaped quotes/newlines.
 */
function extractJsonObjects(raw: string): JsonEvent[] {
  const results: JsonEvent[] = [];

  // Fast path: try each line as a standalone JSON object
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || !l.startsWith("{")) continue;
    try { results.push(JSON.parse(l)); } catch { /* not a clean line */ }
  }
  if (results.length > 0) return results;

  // Fast path: try the whole thing
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return [obj];
  } catch { /* fall through */ }

  // Malformed JSON fallback: extract "type" value and key content via regex.
  // This handles cases where the output field contains unescaped quotes/newlines.
  const typeMatch = raw.match(/"type"\s*:\s*"([^"]+)"/);
  if (!typeMatch) return [];
  const type = typeMatch[1];
  const ev: JsonEvent = { type };

  if (type === "text") {
    // Extract part.text — find "text":"..." that's NOT the type field
    const textMatches = [...raw.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
    // The first "text" match is the type field value, the part.text is later
    const partText = textMatches.find((m) => m[1] !== "text" && m.index! > typeMatch.index!);
    if (partText) ev.part = { text: partText[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') };
  } else if (type === "tool_use") {
    // Extract output value: everything between "output":"  and the closing "}}
    const outputStart = raw.indexOf('"output":"');
    if (outputStart >= 0) {
      const valStart = outputStart + '"output":"'.length;
      // The output value ends where the JSON structure closes.
      // Find the closing pattern: "}}} or similar trailing braces
      // Work backwards from the end to find where the output value ends.
      let valEnd = raw.length - 1;
      // Strip trailing braces and quotes from the end
      while (valEnd > valStart && (raw[valEnd] === "}" || raw[valEnd] === " ")) valEnd--;
      if (raw[valEnd] === '"') valEnd--; // closing quote of output value
      const outputRaw = raw.slice(valStart, valEnd + 1);
      const output = outputRaw.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      ev.part = { state: { output } };
      // Extract tool name
      const toolMatch = raw.match(/"tool"\s*:\s*"([^"]+)"/);
      if (toolMatch) ev.part.tool = toolMatch[1];
      const statusMatch = raw.match(/"status"\s*:\s*"([^"]+)"/);
      if (statusMatch) ev.part.state.status = statusMatch[1];
    }
  } else if (type === "step_finish") {
    const costMatch = raw.match(/"cost"\s*:\s*([\d.]+)/);
    const inputMatch = raw.match(/"input"\s*:\s*(\d+)/);
    const outputMatch = raw.match(/"output"\s*:\s*(\d+)/);
    ev.part = {
      cost: costMatch ? parseFloat(costMatch[1]) : undefined,
      tokens: {
        input: inputMatch ? parseInt(inputMatch[1]) : undefined,
        output: outputMatch ? parseInt(outputMatch[1]) : undefined,
      },
    };
  }

  return [ev];
}

/** A parsed event with a summary label and body content for rendering. */
interface ParsedEvent {
  summary: string;
  body: string | null;
  open?: boolean;
}

/**
 * Parse message text containing JSON events into renderable parts.
 * Returns null if the text doesn't contain JSON events.
 */
function parseAgentOutput(raw: string): ParsedEvent[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;

  const objects = extractJsonObjects(trimmed);
  if (objects.length === 0) return null;

  const results: ParsedEvent[] = [];
  for (const ev of objects) {
    switch (ev.type) {
      case "text":
        results.push({
          summary: `text: ${(ev.part?.text ?? "").slice(0, 80)}${(ev.part?.text ?? "").length > 80 ? "..." : ""}`,
          body: ev.part?.text ?? null,
          open: true,
        });
        break;
      case "step_start":
        results.push({ summary: "step started", body: null });
        break;
      case "step_finish": {
        const tokens = ev.part?.tokens;
        const cost = ev.part?.cost;
        const parts: string[] = [];
        if (tokens?.input != null) parts.push(`in: ${tokens.input}`);
        if (tokens?.output != null) parts.push(`out: ${tokens.output}`);
        if (cost != null) parts.push(`$${cost.toFixed(4)}`);
        results.push({
          summary: `step finished${parts.length ? ` (${parts.join(", ")})` : ""}`,
          body: null,
        });
        break;
      }
      case "tool_use": {
        const tool = ev.part?.tool ?? ev.part?.state?.input?.description ?? "tool";
        const status = ev.part?.state?.status ?? "";
        const output = ev.part?.state?.output;
        results.push({
          summary: `${tool}${status ? ` — ${status}` : ""}`,
          body: typeof output === "string" ? output : null,
          open: true,
        });
        break;
      }
      default:
        results.push({
          summary: ev.type ?? "unknown event",
          body: JSON.stringify(ev, null, 2),
        });
    }
  }
  return results.length > 0 ? results : null;
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

/** Detect fake-driver boilerplate and strip it to just the prompt echo. */
function cleanFakeDriverOutput(text: string): string | null {
  const m = text.match(
    /^Starting fake sandbox run\.\.\.\s*(?:System prompt:.*?\.\s*)?Processing prompt:\s*(.*?)\.\.\.\s*Fake response generated\.\s*Run complete\.$/s,
  );
  return m ? `[fake driver] ${m[1]}` : null;
}

function MessageText({ text }: { text: string }) {
  // 1. Try parsing as JSON streaming events
  const events = parseAgentOutput(text);
  if (events) {
    return (
      <>
        {events.map((ev, i) => (
          <details key={i} open={ev.open} style={{ fontSize: "0.85em" }}>
            <summary style={{ color: "#666", cursor: "pointer" }}>{ev.summary}</summary>
            {ev.body && <Markdown>{ev.body}</Markdown>}
          </details>
        ))}
      </>
    );
  }
  // 2. Clean up fake driver output
  const fake = cleanFakeDriverOutput(text);
  if (fake) return <em style={{ fontSize: "0.85em", color: "#888" }}>{fake}</em>;
  // 3. Regular text → render as markdown
  return <Markdown>{text}</Markdown>;
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
      if (ev.type === "message.appended" || ev.type === "artifact.created") {
        loadMessages();
        loadArtifacts();
      }
    });
    // Poll every 3 seconds as fallback when WS isn't available
    const interval = setInterval(() => {
      loadMessages();
    }, 3000);
    return () => {
      unsub();
      clearInterval(interval);
    };
  }, [loadMessages, loadArtifacts]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    await api(`/chats/${id}/messages`, { method: "POST", body: { content } });
    setContent("");
    await loadMessages();
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
    await loadArtifacts();
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
