import { z } from "zod";
import {
  ChatSchema,
  FileSchema,
  MessageSchema,
} from "./entities.js";

export const ChatUpdatedEventSchema = z.object({
  type: z.literal("chat.updated"),
  payload: ChatSchema,
});

/**
 * Fired when a chat is deleted. Carries only the ids clients need to
 * drop the chat from their local caches — the row and its messages are
 * already gone by the time this event is broadcast.
 */
export const ChatDeletedEventSchema = z.object({
  type: z.literal("chat.deleted"),
  payload: z.object({
    chatId: z.string(),
    workspaceId: z.string(),
  }),
});

export const MessageAppendedEventSchema = z.object({
  type: z.literal("message.appended"),
  payload: MessageSchema,
});

/**
 * Message mutation event — covers state transitions (pending→running→terminal)
 * and content edits (user editing a summary, etc). Consumers can diff the
 * payload against their cached copy.
 */
export const MessageUpdatedEventSchema = z.object({
  type: z.literal("message.updated"),
  payload: MessageSchema,
});

/**
 * Streaming log output for an executing message.
 */
export const MessageLogAppendedEventSchema = z.object({
  type: z.literal("message.log_appended"),
  payload: z.object({
    messageId: z.string(),
    kind: z.enum(["stdout", "stderr", "event"]),
    line: z.string(),
  }),
});

export const MessageStreamingEventSchema = z.object({
  type: z.literal("message.streaming"),
  payload: z.object({
    chatId: z.string(),
    messageId: z.string(),
    delta: z.string(),
  }),
});

export const ArtifactCreatedEventSchema = z.object({
  type: z.literal("artifact.created"),
  payload: FileSchema,
});

export const LibraryChangedEventSchema = z.object({
  type: z.literal("library.changed"),
  payload: z.object({
    workspaceId: z.string(),
    /** Workspace-relative path of the file that changed. */
    path: z.string(),
    op: z.enum(["added", "removed", "updated", "moved"]),
    /** Chats whose attachment-symlinks or message-attachment refs were
     * retargeted by this change. Set on `op: "moved"` so the client can
     * invalidate per-chat caches (Files panel, etc.); other ops omit it. */
    affectedChatIds: z.array(z.string()).optional(),
  }),
});

export const WorkspaceSyncedEventSchema = z.object({
  type: z.literal("workspace.synced"),
  payload: z.object({
    workspaceId: z.string(),
  }),
});

export const WsEventSchema = z.discriminatedUnion("type", [
  ChatUpdatedEventSchema,
  ChatDeletedEventSchema,
  MessageAppendedEventSchema,
  MessageUpdatedEventSchema,
  MessageLogAppendedEventSchema,
  MessageStreamingEventSchema,
  ArtifactCreatedEventSchema,
  LibraryChangedEventSchema,
  WorkspaceSyncedEventSchema,
]);
export type WsEvent = z.infer<typeof WsEventSchema>;

export function parseWsEvent(raw: string): WsEvent {
  const json = JSON.parse(raw);
  return WsEventSchema.parse(json);
}

export function serializeWsEvent(event: WsEvent): string {
  return JSON.stringify(WsEventSchema.parse(event));
}
