import { z } from "zod";
import { FileSchema, MessageSchema } from "./entities.js";

export const FileReadRequestSchema = z.object({
  fileId: z.string(),
});
export const FileReadResponseSchema = z.object({
  content: z.string(),
  mime: z.string(),
});

export const FileWriteRequestSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  mime: z.string(),
  contentBase64: z.string(),
  chatId: z.string().optional(),
});
export const FileWriteResponseSchema = FileSchema;

export const LibraryListRequestSchema = z.object({
  workspaceId: z.string(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
});
export const LibraryListResponseSchema = z.object({
  items: z.array(FileSchema),
  nextCursor: z.string().optional(),
});

export const LibraryGetRequestSchema = z.object({
  fileId: z.string(),
});
export const LibraryGetResponseSchema = FileSchema.extend({
  previewUrl: z.string().optional(),
});

export const ChatSendMessageRequestSchema = z.object({
  chatId: z.string(),
  content: z.string(),
});
export const ChatSendMessageResponseSchema = MessageSchema;

export const ChatAttachArtifactRequestSchema = z.object({
  chatId: z.string(),
  fileId: z.string(),
});
export const ChatAttachArtifactResponseSchema = MessageSchema;

export const WebFetchRequestSchema = z.object({
  url: z.string().url(),
  method: z.string().optional(),
  headers: z.record(z.string()).optional(),
  bodyBase64: z.string().optional(),
});
export const WebFetchResponseSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string()),
  bodyBase64: z.string(),
});

export interface ToolDefinition<Req extends z.ZodTypeAny = z.ZodTypeAny, Res extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  request: Req;
  response: Res;
}

export const TOOLS = {
  "file.read": {
    name: "file.read",
    request: FileReadRequestSchema,
    response: FileReadResponseSchema,
  },
  "file.write": {
    name: "file.write",
    request: FileWriteRequestSchema,
    response: FileWriteResponseSchema,
  },
  "library.list": {
    name: "library.list",
    request: LibraryListRequestSchema,
    response: LibraryListResponseSchema,
  },
  "library.get": {
    name: "library.get",
    request: LibraryGetRequestSchema,
    response: LibraryGetResponseSchema,
  },
  "chat.send_message": {
    name: "chat.send_message",
    request: ChatSendMessageRequestSchema,
    response: ChatSendMessageResponseSchema,
  },
  "chat.attach_artifact": {
    name: "chat.attach_artifact",
    request: ChatAttachArtifactRequestSchema,
    response: ChatAttachArtifactResponseSchema,
  },
  "web.fetch": {
    name: "web.fetch",
    request: WebFetchRequestSchema,
    response: WebFetchResponseSchema,
  },
} as const satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof TOOLS;
