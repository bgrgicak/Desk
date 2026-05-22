import { z } from "zod";
import {
  MESSAGE_ROLES,
} from "./constants.js";

export const UserSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().email(),
  avatarPath: z.string().optional(),
  /** IANA timezone reported by the user's app client, e.g. "America/Los_Angeles".
   * Self-healing: every authed API request carries `X-Client-Timezone` and the
   * server upserts when the stored value drifts. The agent file injects it as
   * the default zone for ambiguous user-supplied times. */
  timezone: z.string().optional(),
  createdAt: z.string(),
  /** True when the user signed in with the documented public seed
   * password and hasn't changed it yet. SPA uses it to prompt for a
   * password change after first login. Cleared by POST /me/password. */
  mustChangePassword: z.boolean().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  model: z.string(),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().nonnegative().default(0),
});
export type Agent = z.infer<typeof AgentSchema>;

export const WorkspaceAgentSchema = z.object({
  workspaceId: z.string(),
  agentId: z.string(),
  addedAt: z.string(),
});
export type WorkspaceAgent = z.infer<typeof WorkspaceAgentSchema>;

export const WORKSPACE_KINDS = ["project", "hub"] as const;
export const WorkspaceKindSchema = z.enum(WORKSPACE_KINDS);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  color: z.string(),
  /** On-disk directory name under `~/Desk/`. Derived from `name`
   * at create time, renamed in lock-step when the workspace is renamed. */
  path: z.string(),
  /** Discriminator that drives capability resolution at the API layer.
   * `project` is the default and the only kind users can create directly;
   * `hub` is the per-user home base, created server-side. */
  kind: WorkspaceKindSchema.default("project"),
  createdAt: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const PIN_KINDS = ["chat", "library_file", "app", "fragment", "artifact"] as const;
export const PinKindSchema = z.enum(PIN_KINDS);
export type PinKind = z.infer<typeof PinKindSchema>;

export const PinSchema = z.object({
  id: z.string(),
  /** Workspace the pin lives in (the hub). */
  workspaceId: z.string(),
  /** Workspace the pinned item originates from. */
  sourceWorkspaceId: z.string(),
  kind: PinKindSchema,
  /** Interpretation depends on `kind`:
   *  - chat / app / artifact: row primary-key id
   *  - library_file / fragment: workspace-relative file path */
  refId: z.string(),
  pinnedAt: z.string(),
});
export type Pin = z.infer<typeof PinSchema>;

export const ChatSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  title: z.string(),
  goal: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  unread: z.boolean(),
  /** True when this chat is pinned to the workspace sidebar's Pinned
   *  section (chat_pins table). Optional so WS payloads that omit the
   *  joined value still parse. */
  pinned: z.boolean().optional(),
  /** True when the chat's most recent `agent_turn` is `pending` or
   *  `running`. Computed live from the messages table by `findById` and
   *  `listWithLatestMessage`, and carried by every `chat.updated` WS
   *  payload — so the client can render the sidebar spinner from a
   *  single authoritative signal instead of reconciling a denormalized
   *  column, a derived running-id set, and the live message stream. */
  running: z.boolean().optional(),
  /** True when the chat's most recent `agent_turn` is in `failed`
   *  terminal state. Same plumbing as `running`. */
  failed: z.boolean().optional(),
  /** Server-derived: the chat in which this thread's anchor message
   *  lives. Set only when the chat is a thread (some other chat has a
   *  message whose `thread_chat_id` points at this one). Lets the
   *  client render a "back to parent" affordance without scanning
   *  every message page. */
  parentChatId: z.string().optional(),
  /** Server-derived: the anchor message id in `parentChatId`. Lets
   *  the client deep-link the back-affordance to the originating
   *  message. */
  anchorMessageId: z.string().optional(),
});
export type Chat = z.infer<typeof ChatSchema>;

/**
 * Chat shape returned by the chat-list endpoint (`GET /chats`).
 * Wraps `Chat` with the extra sidebar fields the list view needs:
 * the latest non-fallback message kind and a short preview of the
 * latest user/agent text message. `running` and `failed` are part of
 * the base `Chat` so they ride along on every `chat.updated` event,
 * not just chat-list responses.
 */
export const ChatWithListMetaSchema = ChatSchema.extend({
  /** Newest user-action message kind (`task` / `task_run`).  `chat`
   *  and `summary` are fallbacks the sidebar treats specially. */
  kind: z.enum(["chat", "task", "task_run"]).optional(),
  /** Short preview of the chat's most recent visible text message. */
  lastMessage: z.string().optional(),
});
export type ChatWithListMeta = z.infer<typeof ChatWithListMetaSchema>;

export const MessageContentTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  /** Optional goal the user selected in the chat composer for this message. */
  goal: z.string().optional(),
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
  /** Workspace that owns the path. Older rows omit this and use the active chat workspace. */
  workspaceId: z.string().optional(),
  /** Caller-facing display name, usually the basename. */
  name: z.string().optional(),
  mime: z.string().optional(),
  params: z.record(z.string(), z.string()).optional(),
});

/** A single event from the agent's JSON event stream. */
export const AgentEventSchema = z.object({
  type: z.string(),
  timestamp: z.number().optional(),
  sessionID: z.string().optional(),
  part: z.record(z.unknown()).optional(),
}).passthrough();
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/**
 * Tagged entry from a single agent run's log. `event` wraps a validated
 * JSON event emitted by the agent on stdout; `stderr` is a raw stderr
 * line; `unparsed` is a stdout line that didn't parse as JSON (kept so
 * nothing is silently dropped).
 */
export const AgentLogEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), event: AgentEventSchema }),
  z.object({ kind: z.literal("stderr"), line: z.string() }),
  z.object({ kind: z.literal("unparsed"), line: z.string() }),
]);
export type AgentLogEntry = z.infer<typeof AgentLogEntrySchema>;

export const MessageContentEventsSchema = z.object({
  type: z.literal("events"),
  log: z.array(AgentLogEntrySchema),
});

/**
 * A coherent narrative summary of a chat. Produced by scheduled summary
 * runs and stored as a regular message in the chat timeline. The user can
 * edit it via PATCH on the message; the agent reads the most recent summary
 * to incorporate edits on the next refresh.
 */
export const MessageContentSummarySchema = z.object({
  type: z.literal("summary"),
  body: z.string(),
});

/**
 * Scheduled request for the agent to (re)generate the chat's summary. Emitted
 * as a pending system message; on fire the agent replaces it with a
 * `summary`-content child. Kept as its own content type so scheduled requests
 * stay distinguishable from ordinary system messages in the chat log.
 */
export const MessageContentSummaryRequestSchema = z.object({
  type: z.literal("summary_request"),
  chatTitle: z.string().optional(),
  messagePreview: z.string().optional(),
});

/**
 * Scheduled request for the workspace agent to run the daily memory
 * reflection pass. Stored as a recurring internal task so the normal
 * scheduler owns retries, run history, pause/resume, and next-run updates.
 */
export const MessageContentReflectionRequestSchema = z.object({
  type: z.literal("reflection_request"),
  workspaceId: z.string(),
});

/**
 * A pending execution slot attached to a user message. Created alongside a
 * user message so fireMessage has a row to claim; carries no textual copy
 * of the user's prompt — the prompt is resolved from the referenced
 * user message at fire time. Hidden from the visible chat timeline.
 */
export const MessageContentAgentTurnSchema = z.object({
  type: z.literal("agent_turn"),
  userMessageId: z.string(),
});

/**
 * Thumbs-up / thumbs-down reaction the user left on an agent reply.
 * Stored as a `role: 'system'` chat message so the reaction shows up in
 * the same activity stream as the conversation it reacted to, and the
 * workspace's daily reflection can read it as a signal alongside the
 * surrounding chat.
 */
export const MessageContentFeedbackSchema = z.object({
  type: z.literal("feedback"),
  rating: z.enum(["up", "down"]),
  /** Id of the agent message the reaction applies to. */
  targetMessageId: z.string(),
});

export const MessageContentSchema = z.discriminatedUnion("type", [
  MessageContentTextSchema,
  MessageContentToolCallSchema,
  MessageContentToolResultSchema,
  MessageContentArtifactRefSchema,
  MessageContentEventsSchema,
  MessageContentSummarySchema,
  MessageContentSummaryRequestSchema,
  MessageContentReflectionRequestSchema,
  MessageContentAgentTurnSchema,
  MessageContentFeedbackSchema,
]);
export type MessageContent = z.infer<typeof MessageContentSchema>;

/**
 * Reference to a file or directory that was attached to a specific
 * message. Lives on the Message envelope (not MessageContent) so the
 * text-plus-files shape of a user message stays a single row. Paths are
 * workspace-relative, forward-slash separated. `kind` defaults to
 * `"file"` when omitted; directories opt in explicitly so the UI can
 * render a folder icon and route clicks to the folder view.
 */
export const AttachmentRefSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["file", "directory"]).optional(),
  mime: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

export const MESSAGE_STATES = ["pending", "running", "succeeded", "failed", "cancelled", "paused"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

/**
 * Discriminates a message's role on non-chat surfaces. `chat` is the default
 * conversational message; `task` is a user-defined task surfaced on the Tasks
 * page; `summary` is the system-scheduled summary refresh trigger; `task_run`
 * is one firing of a task-like row (parent_id points at the definition, state
 * tracks that single execution). See:
 *   - packages/server/docs/plans/message-as-task.md
 *   - packages/server/docs/plans/task-runs-as-messages.md
 */
export const MESSAGE_KINDS = ["chat", "task", "task_run", "summary"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

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

  /** Files attached to this message. User messages: files the user sent
   * alongside the text. Agent messages: reserved for future use. */
  attachments: z.array(AttachmentRefSchema).optional(),
  /** Model identifier that produced this message. Stamped at insert time
   * on assistant rows so history survives agent reconfiguration. */
  model: z.string().optional(),

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

  /** Discriminator for non-chat surfaces (tasks, summary refresh, etc.). */
  kind: z.enum(MESSAGE_KINDS).default("chat"),
  /** Display name for tasks; null for ordinary chat messages. */
  title: z.string().nullable().optional(),

  /** When set, this message is the anchor of a thread; the referenced
   * chat holds the thread transcript. */
  threadChatId: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/**
 * Plain-text preview of a message, regardless of content shape. Used by
 * code that needs a human-readable snippet (thread titles, previews, log
 * lines) without caring about the content discriminator. Returns an empty
 * string when no human-readable text is available (tool calls, agent
 * turns, feedback markers, empty event logs).
 *
 * For `events`, concatenates the text parts of stream events; falls back
 * to `unparsed` stdout lines when there are no structured events.
 */
export function messageTextPreview(message: Message): string {
  const content = message.content;
  switch (content.type) {
    case "text":
      return content.text;
    case "summary":
      return content.body;
    case "artifactRef":
      return content.name ?? content.path;
    case "events": {
      // Text events that share a part id with a `reasoning` event are the
      // model's chain-of-thought, not the user-facing reply. The UI hides
      // them and so should any preview — otherwise the first line of the
      // "preview" is internal monologue (e.g. "**Clarifying next steps**")
      // instead of the actual reply.
      const reasoningPartIds = new Set<string>();
      for (const e of content.log) {
        if (e.kind !== "event" || e.event.type !== "reasoning") continue;
        const id = (e.event.part as { id?: unknown } | undefined)?.id;
        if (typeof id === "string") reasoningPartIds.add(id);
      }
      const parts: string[] = [];
      let sawEvent = false;
      for (const e of content.log) {
        if (e.kind !== "event") continue;
        sawEvent = true;
        if (e.event.type !== "text") continue;
        const id = (e.event.part as { id?: unknown } | undefined)?.id;
        if (typeof id === "string" && reasoningPartIds.has(id)) continue;
        const t = (e.event.part as { text?: unknown } | undefined)?.text;
        if (typeof t === "string") parts.push(t);
      }
      if (sawEvent) return parts.join("").trim();
      return content.log
        .filter((e) => e.kind === "unparsed")
        .map((e) => (e as { line: string }).line)
        .join("\n")
        .trim();
    }
    default:
      return "";
  }
}

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
  /** Message/run id this token was minted for. Used to gate run-scoped APIs. */
  runId: z.string().optional(),
  /** Workspace whose sandbox container this token was minted for.
   * Optional for historical sessions from before the multi-workspace split. */
  workspaceId: z.string().optional(),
  tokenHash: z.string(),
  issuedAt: z.string(),
  revokedAt: z.string().optional(),
});
export type SandboxSession = z.infer<typeof SandboxSessionSchema>;
