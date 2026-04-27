/**
 * Server entity types — mirror of `packages/server/shared/src/entities.ts`.
 * Duplicated (not imported) because app-prototype isn't in the server's
 * TS path. Kept narrow: only the fields the UI actually reads.
 */

export type MessageRole = "user" | "agent" | "system" | "tool";
export type MessageState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "paused";

export interface AgentEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: Record<string, unknown>;
  [k: string]: unknown;
}

export type AgentLogEntry =
  | { kind: "event"; event: AgentEvent }
  | { kind: "stderr"; line: string }
  | { kind: "unparsed"; line: string };

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "toolCall"; toolName: string; args: Record<string, unknown> }
  | { type: "toolResult"; toolName: string; result: unknown }
  | { type: "artifactRef"; path: string; name?: string; mime?: string }
  | { type: "events"; log: AgentLogEntry[] }
  | { type: "note"; body: string }
  | { type: "ai_note_request" }
  | { type: "agent_turn"; userMessageId: string };

export interface ServerUser {
  id: string;
  username: string;
  email: string;
  avatarPath?: string;
  createdAt: string;
}

export interface ServerAgent {
  id: string;
  userId: string;
  name: string;
  instructions: string;
  model: string;
}

/** Membership row from `GET /workspaces/:id/agents`: agent + enrollment timestamp. */
export interface ServerWorkspaceAgent extends ServerAgent {
  addedAt: string;
}

export interface ServerWorkspace {
  id: string;
  userId: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  createdAt: string;
}

export interface ServerChat {
  id: string;
  workspaceId: string;
  agentId: string;
  title: string;
  goal?: string;
  updatedAt: string;
  awaitingUser: boolean;
  unread: boolean;
  /**
   * Drives the chat-list icon. Set to the newest non-chat message kind, with
   * `'chat'` as the fallback when the chat is empty or contains only chat
   * messages. Only populated by /chats list responses.
   */
  iconKind?: "chat" | "task" | "ai_note";
}

export interface AttachmentRef {
  path: string;
  name: string;
  /** "directory" when the path points at a folder; defaults to "file" when omitted. */
  kind?: "file" | "directory";
  mime?: string;
  size?: number;
}

export interface ServerMessage {
  id: string;
  chatId: string;
  role: MessageRole;
  content: MessageContent;
  createdAt: string;
  /** Files attached to this message (user uploads sent alongside the text). */
  attachments?: AttachmentRef[];
  /** Model that produced this message — stamped at insert time on agent rows. */
  model?: string;
  executeAt?: string;
  cron?: string;
  state?: MessageState;
  parentId?: string;
  agentId?: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt?: string;
  /** Discriminates the message's surface — `chat` (default), `task`,
   * or `ai_note`. The Tasks page filters on `task`. */
  kind?: "chat" | "task" | "ai_note";
  /** Display name for tasks; null/missing for ordinary chat messages. */
  title?: string | null;
}

export interface ServerFile {
  path: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  /**
   * Set on `GET /chats/{id}/attachments` items only — `attachment` is a
   * user upload from `.chats/{id}/attachments/`, `note` is a materialized
   * note from `.chats/{id}/notes/`. Library responses omit it.
   */
  kind?: "attachment" | "note";
  /**
   * Optional human-friendly label rendered alongside the raw file name.
   * Notes carry "Chat notes" so the UI doesn't surface the messageId-based
   * filename as the primary label.
   */
  label?: string;
}

/**
 * Minimal metadata for a folder in a workspace library. Returned from
 * `GET /library` alongside files so the client can render empty folders
 * (which wouldn't show up through path-prefix derivation alone).
 */
export interface ServerFolder {
  path: string;
  name: string;
  createdAt: string;
}

export interface Cursor {
  cursor?: string;
}

export interface ListMessagesResponse extends Cursor {
  items: ServerMessage[];
}

export interface ListLibraryResponse extends Cursor {
  items: ServerFile[];
  folders: ServerFolder[];
}

/** Cross-chat message listing query (/messages). */
export interface MessagesFilter {
  workspaceId?: string;
  chatId?: string;
  state?: MessageState[];
  scheduled?: boolean;
  awaitingUser?: boolean;
  contentKind?: string[];
  /** Message-kind discriminator (`task`, `ai_note`, `chat`). The Tasks
   * page filters on `task`. Distinct from `contentKind` which targets
   * `content.type`. */
  kind?: ("chat" | "task" | "ai_note")[];
  since?: string;
  limit?: number;
  cursor?: string;
}

export type WsEvent =
  | { type: "chat.updated"; payload: ServerChat }
  | {
      type: "chat.deleted";
      payload: { chatId: string; workspaceId: string };
    }
  | { type: "message.appended"; payload: ServerMessage }
  | { type: "message.updated"; payload: ServerMessage }
  | {
      type: "message.log_appended";
      payload: {
        messageId: string;
        kind: "stdout" | "stderr" | "event";
        line: string;
      };
    }
  | {
      type: "message.streaming";
      payload: { chatId: string; messageId: string; delta: string };
    }
  | { type: "artifact.created"; payload: ServerFile }
  | {
      type: "library.changed";
      payload: {
        workspaceId: string;
        path: string;
        op: "added" | "removed" | "updated" | "moved";
      };
    };
