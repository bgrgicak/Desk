import { z } from "zod";
import {
  MESSAGE_ROLES,
  RUN_EVENT_KINDS,
  RUN_KINDS,
  RUN_STATES,
  SCHEDULED_JOB_KINDS,
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

export const MessageContentSchema = z.discriminatedUnion("type", [
  MessageContentTextSchema,
  MessageContentToolCallSchema,
  MessageContentToolResultSchema,
  MessageContentArtifactRefSchema,
  MessageContentEventsSchema,
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

export const RunSchema = z.object({
  id: z.string(),
  chatId: z.string().optional(),
  scheduledJobId: z.string().optional(),
  kind: z.enum(RUN_KINDS),
  state: z.enum(RUN_STATES),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
  logPath: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;

export const ScheduledJobOnceSpecSchema = z.object({
  type: z.literal("once"),
  onceAt: z.string(),
});

export const ScheduledJobRecurringSpecSchema = z.object({
  type: z.literal("recurring"),
  cronExpr: z.string(),
});

export const ScheduledJobAiNoteSpecSchema = z.object({
  type: z.literal("ai_note"),
  aiNoteDelayMs: z.number().int().nonnegative(),
});

export const ScheduledJobSpecSchema = z.discriminatedUnion("type", [
  ScheduledJobOnceSpecSchema,
  ScheduledJobRecurringSpecSchema,
  ScheduledJobAiNoteSpecSchema,
]);
export type ScheduledJobSpec = z.infer<typeof ScheduledJobSpecSchema>;

export const ScheduledJobSchema = z.object({
  id: z.string(),
  chatId: z.string().optional(),
  kind: z.enum(SCHEDULED_JOB_KINDS),
  spec: ScheduledJobSpecSchema,
  atJobId: z.string().optional(),
  crontabId: z.string().optional(),
  nextRunAt: z.string().optional(),
  active: z.boolean(),
});
export type ScheduledJob = z.infer<typeof ScheduledJobSchema>;

export const RunEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  kind: z.enum(RUN_EVENT_KINDS),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const SandboxSessionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  tokenHash: z.string(),
  issuedAt: z.string(),
  revokedAt: z.string().optional(),
});
export type SandboxSession = z.infer<typeof SandboxSessionSchema>;

export const NoteSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  chatId: z.string(),
  createdAt: z.string(),
  summary: z.string(),
});
export type Note = z.infer<typeof NoteSchema>;
