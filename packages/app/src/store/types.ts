import type { Agent, ChatWithListMeta, Workspace } from "@agent-desk/shared";

/**
 * Server entity types — mirror of `packages/server/shared/src/entities.ts`.
 * Duplicated (not imported) because @agent-desk/app isn't in the server's
 * TS path. Kept narrow: only the fields the UI actually reads.
 */

export type MessageRole = "user" | "agent" | "system";
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
  | { type: "artifactRef"; path: string; workspaceId?: string; name?: string; mime?: string; params?: Record<string, string> }
  | { type: "events"; log: AgentLogEntry[] }
  | { type: "summary"; body: string }
  | { type: "summary_request"; chatTitle?: string; messagePreview?: string }
  | { type: "reflection_request"; workspaceId: string }
  | { type: "agent_turn"; userMessageId: string };

export interface ServerUser {
  id: string;
  username: string;
  email: string;
  avatarPath?: string;
  createdAt: string;
}

/**
 * Server agent / workspace types — re-exported from
 * `@agent-desk/shared` so the API contract has a single source of
 * truth.  The `ServerWorkspaceAgent` membership row is server-side
 * only (no shared schema yet) since it pairs an Agent with its
 * workspace enrollment timestamp.
 */
export type ServerAgent = Agent;

/** Membership row from `GET /workspaces/:id/agents`: agent + enrollment timestamp. */
export interface ServerWorkspaceAgent extends ServerAgent {
  addedAt: string;
}

export type ServerWorkspace = Workspace;

export type ConnectorStatus = "active" | "disabled" | "error" | "revoked";

export interface ConnectorConnection {
  id: string;
  providerId: string;
  ownerUserId?: string;
  externalAccountId?: string;
  displayName: string;
  scopes: string[];
  capabilities: string[];
  metadata: Record<string, unknown>;
  status: ConnectorStatus;
  isDefault: boolean;
  /**
   * True when the per-user vault has a credential entry for this connection.
   * False if the vault is locked or the entry is missing — in which case the
   * UI should prompt the user to unlock or re-authenticate even though
   * status === 'active'.
   */
  hasCredentials: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceConnectorGrant {
  id: string;
  workspaceId: string;
  connectionId: string;
  providerId: string;
  grantedCapabilities: string[];
  grantedByUserId: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Server chat type — re-exported from `@agent-desk/shared` so both
 * sides of the API agree on the shape by definition (the same Zod
 * schema is parsed on the server and inferred here).  The list-meta
 * fields (kind / running / failed / lastMessage) are optional in the
 * shared type because the WS `chat.updated` payload omits them — the
 * server's `GET /chats` response sets them, the sidebar refetch on
 * list invalidation picks up the new preview.
 */
export type ServerChat = ChatWithListMeta;

export interface AttachmentRef {
  path: string;
  name: string;
  workspaceId?: string;
  /** "directory" when the path points at a folder; defaults to "file" when omitted. */
  kind?: "file" | "directory";
  mime?: string;
  size?: number;
  params?: Record<string, string>;
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
  assigneeId?: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt?: string;
  /** Discriminates the message's surface — `chat` (default), `task`,
   * `task_run` (execution record child of a task), or `summary`. */
  kind?: "chat" | "task" | "task_run" | "summary";
  /** Display name for tasks; null/missing for ordinary chat messages. */
  title?: string | null;
  /** Live runtime/progress entries appended over WS while an agent_turn runs. */
  progressLog?: AgentLogEntry[];
  /** When set, this message is the anchor of a thread; the referenced
   * chat holds the thread transcript. UI surfaces an "open thread"
   * action; the absence of this field exposes a "start thread" action. */
  threadChatId?: string;
}

export interface ServerFile {
  path: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  /**
   * Set on `GET /chats/{id}/attachments` items only — `attachment` is a
   * user upload from `.chats/{id}/attachments/`, `artifact` is an
   * agent-written file or directory from `.chats/{id}/artifacts/`. Library
   * responses omit it.
   */
  kind?: "attachment" | "artifact";
  /** True when the entry is a directory rather than a regular file. */
  isDir?: boolean;
  /** Optional human-friendly label rendered alongside the raw file name. */
  label?: string;
  /** ID of the agent that last created or edited this file, if known. */
  agentId?: string;
  /** ID of the agent that *originally* created this file. Stays stable
   * even after subsequent edits, so the Library UI can show a durable
   * "by AI" provenance label. */
  creatorAgentId?: string;
  /** Whether this file is pinned in the workspace's Pinned view. */
  pinned?: boolean;
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
  /** Cursor for loading older messages (scrollback). */
  prevCursor?: string;
}

export interface ListLibraryResponse extends Cursor {
  items: ServerFile[];
  folders: ServerFolder[];
}

/** Cross-chat message listing query (/messages). */
export interface MessagesFilter {
  /** Request full message content instead of the compact UI payload. */
  full?: boolean;
  workspaceId?: string;
  chatId?: string;
  state?: MessageState[];
  scheduled?: boolean;
  awaitingUser?: boolean;
  contentKind?: string[];
  /** Message-kind discriminator (`task`, `task_run`, `summary`, `chat`). The Tasks
   * page filters on `task`/`summary` definitions and separately fetches
   * `task_run` rows for per-task history. Distinct from `contentKind` which
   * targets `content.type`. */
  kind?: ("chat" | "task" | "task_run" | "summary")[];
  /** Restrict to child messages whose `parentId` matches a task definition. */
  parentId?: string;
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
  | { type: "message.appended"; payload: ServerMessage; workspaceId?: string; chatTitle?: string; actorUserId?: string }
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
        affectedChatIds?: string[];
      };
    }
  | { type: "workspace.synced"; payload: { workspaceId: string } };
