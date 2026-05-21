import type {
  Agent,
  AgentEvent as SharedAgentEvent,
  AgentLogEntry as SharedAgentLogEntry,
  ChatWithListMeta,
  Message,
  MessageContent as SharedMessageContent,
  MessageRole as SharedMessageRole,
  MessageState as SharedMessageState,
  User,
  Workspace,
} from "@agent-desk/shared";

/**
 * Server entity types — mirror of `packages/server/shared/src/entities.ts`.
 * Duplicated (not imported) because @agent-desk/app isn't in the server's
 * TS path. Kept narrow: only the fields the UI actually reads.
 */

// Re-export the shared envelope types so client code and server agree
// by definition.  `MessageContent`, `MessageRole`, `MessageState`,
// `AgentEvent` and `AgentLogEntry` all live in `@agent-desk/shared`
// alongside their Zod schemas; the app used to carry parallel
// definitions that drifted from the shared ones (e.g. the app's
// `MessageContentTextSchema` lacked the optional `goal` field).
export type MessageRole = SharedMessageRole;
export type MessageState = SharedMessageState;
export type AgentEvent = SharedAgentEvent;
export type AgentLogEntry = SharedAgentLogEntry;
export type MessageContent = SharedMessageContent;

/**
 * Server user type — re-exported from `@agent-desk/shared` so the
 * `mustChangePassword` flag (and any future fields) flow through to
 * the app without a parallel definition.  See UserSchema for the
 * source of truth.
 */
export type ServerUser = User;

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

/**
 * Server message envelope plus the one client-only augmentation
 * (`progressLog`).  The base shape comes from the shared `Message`
 * Zod schema — its inferred type is the exact union the server
 * parses and the API returns.  `progressLog` is appended in the WS
 * middleware on `message.delta` events while an agent_turn runs;
 * the server never sends it, but every consumer that reads a
 * message in the chat thread expects it on the same object so the
 * augmentation rides here.
 */
export type ServerMessage = Message & {
  /** Live runtime/progress entries appended over WS while an agent_turn runs. */
  progressLog?: AgentLogEntry[];
};

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
  pinned?: boolean;
}

export interface Cursor {
  cursor?: string;
}

export interface ListMessagesResponse extends Cursor {
  items: ServerMessage[];
  /** Cursor for loading older messages (scrollback). */
  prevCursor?: string;
}

export interface ListLibraryResponse {
  items: ServerFile[];
  folders: ServerFolder[];
}

/** Folders-only recursive tree — returned by `GET /library/folders`. */
export interface ListLibraryFoldersResponse {
  folders: ServerFolder[];
}

/**
 * Library search result. `truncated` flags that the server hit its result
 * cap; the UI should prompt for a more specific query rather than imply
 * the empty tail means "no more matches."
 */
export interface SearchLibraryResponse {
  items: ServerFile[];
  folders: ServerFolder[];
  truncated: boolean;
}

/** Cross-chat message listing query (/messages). */
export interface MessagesFilter {
  /** Request full message content instead of the compact UI payload. */
  full?: boolean;
  workspaceId?: string;
  chatId?: string;
  state?: MessageState[];
  scheduled?: boolean;
  unread?: boolean;
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
