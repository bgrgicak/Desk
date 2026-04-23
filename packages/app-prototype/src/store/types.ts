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
  | "cancelled";

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "toolCall"; toolName: string; args: Record<string, unknown> }
  | { type: "toolResult"; toolName: string; result: unknown }
  | { type: "artifactRef"; path: string; name?: string; mime?: string }
  | { type: "events"; events: unknown[] }
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
  toolAllowlist: string[];
}

export interface ServerWorkspace {
  id: string;
  userId: string;
  name: string;
  description: string;
  icon: string;
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
}

export interface ServerMessage {
  id: string;
  chatId: string;
  role: MessageRole;
  content: MessageContent;
  createdAt: string;
  executeAt?: string;
  cron?: string;
  state?: MessageState;
  parentId?: string;
  agentId?: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt?: string;
}

export interface ServerFile {
  path: string;
  name: string;
  mime: string;
  size: number;
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
}

/** Cross-chat message listing query (/messages). */
export interface MessagesFilter {
  workspaceId?: string;
  chatId?: string;
  state?: MessageState[];
  scheduled?: boolean;
  awaitingUser?: boolean;
  contentKind?: string[];
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
