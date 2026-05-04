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
  timestamp: Date
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

export interface TodoItem {
  id: string
  text: string
  done: boolean
  source: 'ai' | 'user'
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
  type: 'file' | 'link' | 'note'
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
}

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
  description?: string
  agentName: string
  status: 'todo' | 'active' | 'complete' | 'scheduled'
  statusText: string
  priority?: 'low' | 'medium' | 'high' | 'highest'
  assigneeId?: string
  startedAt: Date
  completedAt?: Date
  /** Server message id for lifecycle PATCHes (pause/resume/cancel) and
   * for scrolling the chat view to the originating message. */
  messageId?: string
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
  workspaceId?: string
  agentId?: string
  /** Persisted composer goal for this chat. */
  goal?: ChatGoalKind | null
  /**
   * Drives the chat-list icon (fallback signal). Newest user-action
   * message kind, falling back to `'chat'`.
   */
  kind?: ChatKind
  /**
   * Drives the chat-list icon (primary signal when set). Inferred from
   * the newest user-role text message — `app` / `data` / `site` / etc.
   */
  goalKind?: ChatGoalKind | null
}

// ── Settings / Connections (catalog of integrations the UI can render) ───────

export type ConnectionKind =
  | 'claude' | 'chatgpt'
  | 'google-drive' | 'notion' | 'github' | 'slack' | 'figma' | 'linear' | 'web-clipper'

export interface ConnectionMeta {
  name: string
  description: string
  /** Emoji used when no brand mark applies. */
  icon: string
}

export const CONNECTION_CATALOG: Record<ConnectionKind, ConnectionMeta> = {
  'claude':       { name: 'Claude',       description: 'Claude models via the Anthropic API', icon: '🅰️' },
  'chatgpt':      { name: 'ChatGPT',      description: 'OpenAI models via the OpenAI API',    icon: '🅶' },
  'google-drive': { name: 'Google Drive', description: 'Docs, Sheets and Slides',             icon: '📁' },
  'notion':       { name: 'Notion',       description: 'Pages and databases',                  icon: '📝' },
  'github':       { name: 'GitHub',       description: 'Repositories and issues',              icon: '🐙' },
  'slack':        { name: 'Slack',        description: 'Messages and channels',                icon: '💬' },
  'figma':        { name: 'Figma',        description: 'Design files and prototypes',          icon: '🎨' },
  'linear':       { name: 'Linear',       description: 'Issues, projects and cycles',          icon: '🔷' },
  'web-clipper':  { name: 'Web Clipper',  description: 'Save pages from your browser',         icon: '🌐' },
}

export interface Connection {
  id: string
  kind: ConnectionKind
  name: string
  apiKey?: string
  baseUrl?: string
  enabled: boolean
}

// ── Settings / Providers ──────────────────────────────────────────────────────

export type ProviderKind = 'claude' | 'chatgpt' | 'other'

export interface Provider {
  id: string
  kind: ProviderKind
  name: string
  apiKey: string
  organizationId?: string
  baseUrl?: string
}

export interface SettingsAgent {
  id: string
  name: string
  providerId: string
  model: string
  instructions: string
}

export const PROVIDER_MODELS: Record<ProviderKind, string[]> = {
  claude: ['Claude Sonnet 4', 'Claude Opus 4', 'Claude Haiku 3.5'],
  chatgpt: ['GPT-4o', 'GPT-4o mini', 'GPT-4 Turbo'],
  other: [],
}

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  other: 'Other',
}

// ── Compose scenarios (UI-only "Analyzing requirements…" sequence) ────────────
// TODO(api-gap): wire scripted status strings to WS `message.log_appended`
// once slice 12's event stream drives compose progression. Matrix §4.2.3.

export interface ComposeScenario {
  triggers: string[]
  statusMessages: string[]
  resultArtifact: Omit<Artifact, 'id' | 'createdAt' | 'updatedAt' | 'conversation'>
  finalResponse: string
}

export const COMPOSE_SCENARIOS: ComposeScenario[] = [
  {
    triggers: ['summarise', 'summarize', 'summary', 'recap'],
    statusMessages: ['Reading your files...', 'Pulling out the key points...', 'Writing the summary...'],
    resultArtifact: {
      name: 'Summary',
      type: 'document',
      agentName: 'Claude',
      agentModel: 'Claude Sonnet 4',
      content: '# Summary\n\nThis is a placeholder summary. Real content arrives from the agent.',
    },
    finalResponse: "Here's your summary. I've highlighted the key themes and action items.",
  },
  {
    triggers: ['build', 'create', 'make', 'app', 'tracker', 'dashboard', 'tool'],
    statusMessages: ['Understanding what you need...', 'Designing the interface...', 'Building the components...', 'Adding the finishing touches...'],
    resultArtifact: {
      name: 'New App',
      type: 'app',
      agentName: 'Claude',
      agentModel: 'Claude Sonnet 4',
      content: 'app',
    },
    finalResponse: "Your app is ready! I've built it with the features you described. You can start using it right away.",
  },
  {
    triggers: ['write', 'draft', 'document', 'doc', 'plan', 'strategy', 'brief', 'report', 'email', 'agenda', 'notes'],
    statusMessages: ['Thinking about the structure...', 'Writing the first draft...', 'Reviewing and polishing...'],
    resultArtifact: {
      name: 'New Document',
      type: 'document',
      agentName: 'Claude',
      agentModel: 'Claude Sonnet 4',
      content: '# New Document\n\nDraft body.',
    },
    finalResponse: "Your document is ready. Take a look and let me know if you'd like any changes.",
  },
  {
    triggers: ['image', 'design', 'logo', 'illustration', 'palette', 'visual'],
    statusMessages: ['Exploring visual directions...', 'Generating the design...'],
    resultArtifact: {
      name: 'New Design',
      type: 'image',
      agentName: 'Claude',
      agentModel: 'Claude Sonnet 4',
      content: 'image',
    },
    finalResponse: "Here's your design. Let me know if you want to adjust colors, layout, or style.",
  },
]

export function matchComposeScenario(input: string): ComposeScenario {
  const lower = input.toLowerCase()
  const matched = COMPOSE_SCENARIOS.find(s => s.triggers.some(t => lower.includes(t)))
  return matched || COMPOSE_SCENARIOS[2]
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

// Folder helpers — accept the folder list explicitly so they can be used
// against whatever derivedSlice selector returns (empty for now, see
// matrix §4.2.1).

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

export function countItemsRecursive(folders: Folder[], folderId: string, items: ContextItem[]): number {
  const descendantIds = new Set<string>([folderId])
  let added = true
  while (added) {
    added = false
    for (const f of folders) {
      if (f.parentId && descendantIds.has(f.parentId) && !descendantIds.has(f.id)) {
        descendantIds.add(f.id)
        added = true
      }
    }
  }
  return items.filter(i => i.folderId && descendantIds.has(i.folderId)).length
}
