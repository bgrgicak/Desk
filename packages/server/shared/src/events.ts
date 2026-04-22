import { z } from "zod";
import {
  ChatSchema,
  FileSchema,
  MessageSchema,
  RunSchema,
} from "./entities.js";

export const ChatUpdatedEventSchema = z.object({
  type: z.literal("chat.updated"),
  payload: ChatSchema,
});

export const MessageAppendedEventSchema = z.object({
  type: z.literal("message.appended"),
  payload: MessageSchema,
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

export const RunStateChangedEventSchema = z.object({
  type: z.literal("run.state_changed"),
  payload: RunSchema,
});

export const RunLogAppendedEventSchema = z.object({
  type: z.literal("run.log_appended"),
  payload: z.object({
    runId: z.string(),
    seq: z.number().int().nonnegative(),
    kind: z.enum(["stdout", "stderr", "event"]),
    payload: z.string(),
  }),
});

export const LibraryChangedEventSchema = z.object({
  type: z.literal("library.changed"),
  payload: z.object({
    workspaceId: z.string(),
    /** Workspace-relative path of the file that changed. */
    path: z.string(),
    op: z.enum(["added", "removed", "updated", "moved"]),
  }),
});

/**
 * Message mutation event — covers state transitions (pending→running→terminal)
 * and content edits (user editing a note, etc). Consumers can diff the
 * payload against their cached copy.
 */
export const MessageUpdatedEventSchema = z.object({
  type: z.literal("message.updated"),
  payload: MessageSchema,
});

/**
 * Streaming log output for an executing message. Replaces the old
 * run.log_appended event; keyed by messageId now that messages carry
 * execution state directly.
 */
export const MessageLogAppendedEventSchema = z.object({
  type: z.literal("message.log_appended"),
  payload: z.object({
    messageId: z.string(),
    kind: z.enum(["stdout", "stderr", "event"]),
    line: z.string(),
  }),
});

export const WsEventSchema = z.discriminatedUnion("type", [
  ChatUpdatedEventSchema,
  MessageAppendedEventSchema,
  MessageUpdatedEventSchema,
  MessageLogAppendedEventSchema,
  MessageStreamingEventSchema,
  ArtifactCreatedEventSchema,
  RunStateChangedEventSchema,
  RunLogAppendedEventSchema,
  LibraryChangedEventSchema,
]);
export type WsEvent = z.infer<typeof WsEventSchema>;

export function parseWsEvent(raw: string): WsEvent {
  const json = JSON.parse(raw);
  return WsEventSchema.parse(json);
}

export function serializeWsEvent(event: WsEvent): string {
  return JSON.stringify(WsEventSchema.parse(event));
}
