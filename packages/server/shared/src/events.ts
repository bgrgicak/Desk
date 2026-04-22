import { z } from "zod";
import {
  ChatSchema,
  FileSchema,
  MessageSchema,
  NoteSchema,
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

export const NoteCreatedEventSchema = z.object({
  type: z.literal("note.created"),
  payload: NoteSchema,
});

export const WsEventSchema = z.discriminatedUnion("type", [
  ChatUpdatedEventSchema,
  MessageAppendedEventSchema,
  MessageStreamingEventSchema,
  ArtifactCreatedEventSchema,
  RunStateChangedEventSchema,
  RunLogAppendedEventSchema,
  LibraryChangedEventSchema,
  NoteCreatedEventSchema,
]);
export type WsEvent = z.infer<typeof WsEventSchema>;

export function parseWsEvent(raw: string): WsEvent {
  const json = JSON.parse(raw);
  return WsEventSchema.parse(json);
}

export function serializeWsEvent(event: WsEvent): string {
  return JSON.stringify(WsEventSchema.parse(event));
}
