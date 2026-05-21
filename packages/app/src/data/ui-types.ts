/**
 * UI types and pure helpers used by the React components.
 *
 * This module replaces the old `mock-data.ts`: it carries the shapes the
 * components render against and a few shape-agnostic helpers. No mock
 * records live here — server data arrives via RTK Query + the selectors
 * under `src/store/selectors/`, and UI-derived concepts that the server
 * can't back yet live in `src/store/slices/derivedSlice.ts`.
 */

import { FileText, Zap, ImageIcon, Table, Globe, type LucideIcon } from 'lucide-react'
import type { GoalKey } from '@agent-desk/shared'

// ── Artifacts ─────────────────────────────────────────────────────────────────

export type ArtifactType = 'document' | 'app' | 'image' | 'spreadsheet' | 'site'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  status?: string
  isGrouped?: boolean
}

export interface Artifact {
  id: string
  name: string
  type: ArtifactType
  agentName: string
  agentModel: string
  createdAt: Date
  updatedAt: Date
  content: string
  conversation: ChatMessage[]
  thumbnail?: string
}

export interface ArtifactUpdate {
  id: string
  artifactId: string
  message: string
  timestamp: number
}

// ── Today / Inbox ─────────────────────────────────────────────────────────────

export type InboxUICard =
  | {
      type: 'email-draft'
      to: string
      subject: string
      body: string
    }
  | {
      type: 'expense-flags'
      entries: { description: string; date: string; amount: string }[]
    }
  | {
      type: 'reconnect'
      service: string
      detail: string
    }

export interface InboxItem {
  id: string
  type: 'question' | 'completion' | 'error'
  agentName: string
  message: string
  artifactId?: string
  runId?: string
  timestamp: Date
  read: boolean
  quickReplies?: string[]
  uiCard?: InboxUICard
}

export type TodayItemType =
  | 'broken-connection'
  | 'decision-from-run'
  | 'agent-question'
  | 'calendar-prompt'
  | 'unresolved-follow-up'
  | 'user-todo'

export type TodayBand = 'right-now' | 'today' | 'this-week' | 'earlier'

export interface TodayChip { label: string }

export interface TodayItem {
  id: string
  type: TodayItemType
  ask: string
  context: string
  workspaceId: string
  workspaceName: string
  sourceLabel: string
  timestamp: Date
  band: TodayBand
  chips?: TodayChip[]
  routeToWorkspace?: boolean
  note?: string
  attachment?: { name: string; size: string }
}

// ── Library / Context ─────────────────────────────────────────────────────────

export interface ContextItem {
  id: string
  type: 'file' | 'link' | 'note' | 'app'
  name: string
  content: string
  folder?: string
  folderId?: string | null
  addedAt: Date
  usedBy: string[]
  uploadedBy: 'user' | 'ai'
  /** Display name of the agent that originally created this file, when
   * `uploadedBy === 'ai'`. Used to show an inline provenance badge on
   * library cards. */
  agentName?: string
  /** Whether this file is pinned in the workspace's Pinned view. */
  pinned?: boolean
  lastAccessed?: Date
  relatedArtifactIds: string[]
  fileSize?: string
  /** Raw byte size of the underlying file. Used to populate
   * `AttachmentRef.size` so the inline message-bubble chip can render a
   * size subtitle without re-fetching. `fileSize` is the formatted
   * sibling for direct UI rendering. */
  size?: number
  mimeType?: string
}

export interface Folder {
  id: string
  name: string
  parentId: string | null
  createdAt: Date
  /** True when the folder is pinned to the workspace sidebar (mirrors
   *  ContextItem.pinned). Optional so library lists that don't surface
   *  pin state stay compatible. */
  pinned?: boolean
}

export type PinnedEntryKind = 'library' | 'folder' | 'chat'

// ── Tasks ─────────────────────────────────────────────────────────────────────

export interface TaskOccurrence {
  id: string
  startedAt: Date
  endedAt: Date
  status: 'completed' | 'failed' | 'active' | 'scheduled'
  statusText?: string
}

export interface Task {
  id: string
  name: string
  /** AI-generated short title (parity with chat titles). Shown as the
   *  card heading above the body. Empty until titled. */
  title?: string
  description?: string
  agentName: string
  /** `todo` = idle (created, not picked up). `active` = in progress
   *  (picked up by the user or the AI / a run is executing).
   *  `needs_input` = the AI paused awaiting the user's reply (the AI
   *  moves it here and back). `scheduled` = has a future run.
   *  `complete` = done/cancelled. */
  status: 'todo' | 'active' | 'needs_input' | 'complete' | 'scheduled'
  statusText: string
  priority?: 'low' | 'medium' | 'high' | 'highest'
  assigneeId?: string
  startedAt: Date
  completedAt?: Date
  /** Server message id for lifecycle PATCHes (pause/resume/cancel) and
   * for scrolling the chat view to the originating message. */
  messageId?: string
  /** Backing message kind/content type. Used to avoid editing system rows as user task text. */
  messageKind?: 'chat' | 'task' | 'task_run' | 'summary'
  messageContentType?: string
  /** Backing message author. Plain user-authored tasks keep kanban status under user control after runs. */
  messageRole?: 'user' | 'agent' | 'system'
  /** Raw server lifecycle state. UI status is derived from this plus schedule/run children. */
  messageState?: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'paused'
  /** Chat the backing message lives in. */
  chatId?: string
  /** True when the task has actually fired at least once. */
  hasRealStartedAt?: boolean
  artifactIds: string[]
  scheduledFor?: Date
  scheduleEndDate?: Date
  scheduleRepeat?: boolean
  /** Next scheduled fire time (server `executeAt` or next cron tick). */
  nextRun?: Date
  color: 'blue' | 'emerald' | 'amber' | 'violet' | 'slate' | 'rose' | 'orange'
  /** Free-form schedule label (cron string, "Every Tuesday", etc.). */
  schedule?: string
  history: TaskOccurrence[]
}

// ── Runs ──────────────────────────────────────────────────────────────────────

export interface RunOccurrence {
  id: string
  startedAt: Date
  endedAt: Date
  status: 'completed' | 'failed' | 'active' | 'scheduled' | 'paused'
  statusText?: string
}

export interface Run {
  id: string
  name: string
  agentName: string
  status: 'active' | 'scheduled' | 'completed' | 'paused' | 'failed'
  statusText: string
  /** startedAt falls back to createdAt for scheduled-but-never-fired runs
   * so the Run still has a sortable timestamp. Use `hasRealStartedAt` to
   * decide whether "Last run" should display this value. */
  startedAt: Date
  hasRealStartedAt?: boolean
  completedAt?: Date
  /** Chat the backing message lives in — used to deep-link from the Run
   * panel's Chat tab to the originating conversation. */
  chatId?: string
  /** Server message id for lifecycle PATCHes (pause/resume/cancel) and
   * for scrolling the chat view to the originating message. */
  messageId?: string
  artifactIds: string[]
  scheduled?: boolean
  nextRun?: Date
  color: 'blue' | 'emerald' | 'amber' | 'violet' | 'slate' | 'rose' | 'orange'
  schedule?: string
  history: RunOccurrence[]
}

// ── Chats ─────────────────────────────────────────────────────────────────────

export type ChatKind = 'chat' | 'task' | 'task_run'

export type ChatGoalKind = GoalKey

export interface Chat {
  id: string
  title: string
  lastMessage: string
  updatedAt: Date
  createdAt: Date
  artifactIds?: string[]
  messages?: ChatMessage[]
  unread?: boolean
  /** True when the latest agent turn failed and can be retried. */
  failed?: boolean
  /** True when the latest agent turn is pending/running. */
  running?: boolean
  workspaceId?: string
  agentId?: string
  /** Persisted composer goal for this chat. */
  goal?: ChatGoalKind | null
  /**
   * Drives the chat-list icon (fallback signal). Newest user-action
   * message kind, falling back to `'chat'`.
   */
  kind?: ChatKind
  /** True when the user has pinned this chat to the sidebar's Pinned
   *  section. Server-derived from the chat_pins table. */
  pinned?: boolean
  /** The chat that owns this thread. Undefined for top-level chats.
   *  The server will populate this directly once
   *  `packages/server/docs/plans/threads-nesting.md` lands; until then
   *  `selectors/threads.ts` reverse-derives it from the existing
   *  `message.threadChatId` back-ref so the UI can be built against the
   *  target shape today. */
  parentChatId?: string
  /** The message in the parent chat that anchors this thread.
   *  Undefined for top-level chats. See `parentChatId`. */
  anchorMessageId?: string
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function getRelativeTime(date: Date): string {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function getArtifactIcon(type: ArtifactType): LucideIcon {
  switch (type) {
    case 'document': return FileText
    case 'app': return Zap
    case 'image': return ImageIcon
    case 'spreadsheet': return Table
    case 'site': return Globe
  }
}

// Folder helpers — accept the folder list explicitly so they can be
// used against whatever folder source the caller has handy. The
// server does not currently expose folders as a first-class entity
// (tracked as a roadmap feature); callers using a derived list pass
// an empty array and the helpers behave correctly.

export function getFolderById(folders: Folder[], id: string | null | undefined): Folder | undefined {
  if (!id) return undefined
  return folders.find(f => f.id === id)
}

export function getFolderPath(folders: Folder[], folderId: string | null): Folder[] {
  const path: Folder[] = []
  let current = getFolderById(folders, folderId)
  while (current) {
    path.unshift(current)
    current = getFolderById(folders, current.parentId)
  }
  return path
}

export function getChildFolders(folders: Folder[], parentId: string | null): Folder[] {
  return folders.filter(f => f.parentId === parentId)
}

export function getItemsInFolder(folderId: string | null, items: ContextItem[]): ContextItem[] {
  return items.filter(i => (i.folderId ?? null) === folderId)
}

export function countDirectChildren(folders: Folder[], folderId: string, items: ContextItem[]): number {
  const directItems = items.filter(i => (i.folderId ?? null) === folderId).length
  const directFolders = folders.filter(f => f.parentId === folderId).length
  return directItems + directFolders
}
