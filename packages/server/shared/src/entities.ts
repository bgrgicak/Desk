import { z } from "zod";
import {
  MESSAGE_ROLES,
} from "./constants.js";

export const UserSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().email(),
  avatarPath: z.string().optional(),
  createdAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  instructions: z.string(),
  model: z.string(),
  toolAllowlist: z.array(z.string()),
});
export type Agent = z.infer<typeof AgentSchema>;

export const WorkspaceAgentSchema = z.object({
  workspaceId: z.string(),
  agentId: z.string(),
  isDefault: z.boolean(),
  addedAt: z.string(),
});
export type WorkspaceAgent = z.infer<typeof WorkspaceAgentSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  createdAt: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const ChatSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  title: z.string(),
  goal: z.string().optional(),
  updatedAt: z.string(),
  awaitingUser: z.boolean(),
  unread: z.boolean(),
});
export type Chat = z.infer<typeof ChatSchema>;

export const MessageContentTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const MessageContentToolCallSchema = z.object({
  type: z.literal("toolCall"),
  toolName: z.string(),
  args: z.record(z.unknown()),
});

export const MessageContentToolResultSchema = z.object({
  type: z.literal("toolResult"),
  toolName: z.string(),
  result: z.unknown(),
});

export const MessageContentArtifactRefSchema = z.object({
  type: z.literal("artifactRef"),
  /** Workspace-relative path (forward-slash separated). */
  path: z.string(),
  /** Caller-facing display name, usually the basename. */
  name: z.string().optional(),
  mime: z.string().optional(),
});

/** A single event from the OpenCode JSON event stream. */
export const OpenCodeEventSchema = z.object({
  type: z.string(),
  timestamp: z.number().optional(),
  sessionID: z.string().optional(),
  part: z.record(z.unknown()).optional(),
}).passthrough();
export type OpenCodeEvent = z.infer<typeof OpenCodeEventSchema>;

export const MessageContentEventsSchema = z.object({
  type: z.literal("events"),
  events: z.array(OpenCodeEventSchema),
});

/**
 * A coherent narrative summary of a chat. Produced by scheduled ai_note
 * runs and stored as a regular message in the chat timeline (no separate
 * notes table). The user can edit it via PATCH on the message; the agent
 * reads the most recent note to incorporate edits on the next refresh.
 */
export const MessageContentNoteSchema = z.object({
  type: z.literal("note"),
  body: z.string(),
});

/**
 * Scheduled request for the agent to (re)generate the chat's note. Emitted
 * as a pending system message; on fire the agent replaces it with a
 * `note`-content child. Kept as its own content type so scheduled requests
 * stay distinguishable from ordinary system messages in the chat log.
 */
export const MessageContentAiNoteRequestSchema = z.object({
  type: z.literal("ai_note_request"),
});

export const MessageContentSchema = z.discriminatedUnion("type", [
  MessageContentTextSchema,
  MessageContentToolCallSchema,
  MessageContentToolResultSchema,
  MessageContentArtifactRefSchema,
  MessageContentEventsSchema,
  MessageContentNoteSchema,
  MessageContentAiNoteRequestSchema,
]);
export type MessageContent = z.infer<typeof MessageContentSchema>;

export const MESSAGE_STATES = ["pending", "running", "succeeded", "failed", "cancelled"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export const SchedulerRefSchema = z.object({
  kind: z.enum(["at", "cron"]),
  id: z.string(),
});
export type SchedulerRef = z.infer<typeof SchedulerRefSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: z.enum(MESSAGE_ROLES),
  content: MessageContentSchema,
  createdAt: z.string(),

  /** Execution metadata (nullable — present for scheduled/executing messages only). */
  executeAt: z.string().optional(),
  cron: z.string().optional(),
  state: z.enum(MESSAGE_STATES).optional(),
  parentId: z.string().optional(),
  agentId: z.string().optional(),
  schedulerRef: SchedulerRefSchema.optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/**
 * Filesystem-backed reference to a file inside a workspace. Path is
 * workspace-relative, forward-slash separated. Replaces the old DB-indexed
 * File entity from v1.
 */
export const FileSchema = z.object({
  path: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type File = z.infer<typeof FileSchema>;


export const SandboxSessionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  tokenHash: z.string(),
  issuedAt: z.string(),
  revokedAt: z.string().optional(),
});
export type SandboxSession = z.infer<typeof SandboxSessionSchema>;

