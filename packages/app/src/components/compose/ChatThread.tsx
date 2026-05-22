import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { MessageBubble } from './MessageBubble'
import { StatusIndicator } from './StatusIndicator'
import { FailedRunBanner } from './FailedRunBanner'
import { findActiveAgentTurn, firstUserVisibleDiagnosticString, isMessageVisible, isStructuredToolPayloadLine, isUserVisibleDiagnosticLine, userVisibleDiagnosticTextForEvent } from './messageVisibility'
import { useGetChatMessagesQuery, useGetWorkspacesQuery } from '@/store/api'
import type { ListMessagesResponse } from '@/store/types'
import type { AgentEvent, AgentLogEntry, AttachmentRef, ServerMessage } from '@/store/types'

// ── ChatThread ────────────────────────────────────────────────────────────────

/** Distance from the top (px) at which we trigger loading older messages. */
const SCROLL_TOP_THRESHOLD = 120

// Consecutive same-role messages whose timestamps fall within this
// window are treated as a single group: only the group's last message
// surfaces the trailing actions row, and copying that row copies the
// whole group (text + a reference for each artifact). 3 s is wide
// enough to catch an agent's artifact card plus the follow-up sentence
// it writes a beat later — together they read as one expression.
const GROUP_WINDOW_MS = 3000

export function sameMessageGroup(a: ServerMessage | undefined, b: ServerMessage | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.role === b.role &&
    Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) <= GROUP_WINDOW_MS
  )
}

/**
 * Finds the most recent failed `agent_turn` in the message list.
 * Returns the failed message, or `null` if the latest agent turn is not
 * in a failed state (e.g. succeeded, running, or pending).
 *
 * Exported for testing.
 */
export function findFailedAgentTurn(items: ServerMessage[]): ServerMessage | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]
    if (m.content.type === 'agent_turn') {
      return m.state === 'failed' ? m : null
    }
  }
  return null
}

export function findFailedOrDiagnosticAgentTurn(items: ServerMessage[]): ServerMessage | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const turn = items[i]
    if (turn.content.type !== 'agent_turn') continue
    if (turn.state === 'failed') return turn
    if (turn.state !== 'succeeded') return null

    const later = items.slice(i + 1)
    const producedVisibleMessage = later.some(m => isMessageVisible(m, false))
    if (producedVisibleMessage) return null

    return failureDetailForAgentTurn(items, turn) ? turn : null
  }
  return null
}

// `findActiveAgentTurn` moved to ./messageVisibility so non-component
// callers (store selectors) can reuse it without dragging TSX into
// the store layer. Re-exported for existing importers and tests.
export { findActiveAgentTurn }

export function failureDetailForAgentTurn(items: ServerMessage[], failedTurn: ServerMessage | null): string | null {
  if (!failedTurn) return null
  const diagnostics: string[] = []
  collectDiagnostics(failedTurn.progressLog, diagnostics)

  const failedTurnIndex = items.findIndex(m => m.id === failedTurn.id)
  if (failedTurnIndex >= 0) {
    for (const m of items.slice(failedTurnIndex + 1)) {
      if (m.content.type === 'agent_turn') break
      if (m.role === 'agent') collectMessageDiagnostics(m, diagnostics)
    }
  }

  return chooseFailureDetail(diagnostics)
}

export function isFailedRunDiagnosticMessage(message: ServerMessage, items: ServerMessage[], failedTurn: ServerMessage | null): boolean {
  if (!failedTurn || message.role !== 'agent') return false
  if (message.content.type !== 'text' || !isUserVisibleDiagnosticLine(message.content.text)) return false

  const failedTurnIndex = items.findIndex(m => m.id === failedTurn.id)
  const messageIndex = items.findIndex(m => m.id === message.id)
  if (failedTurnIndex < 0 || messageIndex <= failedTurnIndex) return false

  for (const m of items.slice(failedTurnIndex + 1, messageIndex)) {
    if (m.content.type === 'agent_turn') return false
  }
  return true
}

function collectMessageDiagnostics(message: ServerMessage, diagnostics: string[]): void {
  if (message.content.type === 'events') {
    collectDiagnostics(message.content.log, diagnostics)
    return
  }
  if (message.content.type === 'text' && isUserVisibleDiagnosticLine(message.content.text)) {
    for (const line of splitDiagnosticLines(message.content.text)) {
      if (isUserVisibleDiagnosticLine(line)) diagnostics.push(line)
    }
    return
  }
  if (message.content.type === 'toolResult') {
    const diagnostic = firstUserVisibleDiagnosticString(message.content.result)
    if (diagnostic) diagnostics.push(diagnostic)
  }
}

function collectDiagnostics(log: AgentLogEntry[] | undefined, diagnostics: string[]): void {
  if (!log?.length) return
  const stderrFallbacks: string[] = []
  const matchedBefore = diagnostics.length
  for (const entry of log) {
    let raw: string | null = null
    if (entry.kind === 'event') {
      raw = userVisibleDiagnosticTextForEvent(entry.event)
    } else if (isUserVisibleDiagnosticLine(entry.line)) {
      raw = entry.line
    } else if (entry.kind === 'stderr' && !isStructuredToolPayloadLine(entry.line)) {
      stderrFallbacks.push(entry.line)
    }
    if (!raw) continue
    for (const line of splitDiagnosticLines(raw)) {
      if (line) diagnostics.push(line)
    }
  }
  if (diagnostics.length > matchedBefore) return
  for (const raw of stderrFallbacks) {
    for (const line of splitDiagnosticLines(raw)) {
      if (line) diagnostics.push(line)
    }
  }
}

function splitDiagnosticLines(raw: string): string[] {
  return raw
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

function chooseFailureDetail(diagnostics: string[]): string | null {
  const unique = Array.from(new Set(diagnostics))
  const specific = unique.find(line => !/unexpected error,? check log file/i.test(line)) ?? unique[0]
  if (!specific) return null
  return specific.length > 220 ? `${specific.slice(0, 217)}…` : specific
}

/**
 * A successful agent turn can be visually silent in the normal chat stream when
 * the run only emitted tool/event rows that are hidden outside developer mode.
 * In that case render an explicit completion fallback so the chat doesn't look
 * like the agent ignored the user.
 */
export function shouldShowToolOnlyRunFallback(items: ServerMessage[], developerMode: boolean): boolean {
  if (developerMode) return false

  for (let i = items.length - 1; i >= 0; i--) {
    const turn = items[i]
    if (turn.content.type !== 'agent_turn') continue
    if (turn.state !== 'succeeded') return false

    let sawHiddenToolOutput = false
    for (const later of items.slice(i + 1)) {
      if (isMessageVisible(later, false)) return false
      if (messageHasUserVisibleDiagnostic(later)) return false
      if (
        later.role === 'agent' &&
        (later.content.type === 'toolCall' || later.content.type === 'toolResult' || later.content.type === 'events')
      ) {
        sawHiddenToolOutput = true
      }
    }
    return sawHiddenToolOutput
  }

  return false
}

function messageHasUserVisibleDiagnostic(message: ServerMessage): boolean {
  const diagnostics: string[] = []
  collectMessageDiagnostics(message, diagnostics)
  return diagnostics.length > 0
}

export function chatMessagesQueryKey(chatId: string, developerMode: boolean): string {
  return `${chatId}:${developerMode ? 'full' : 'timeline'}`
}

export function shouldShowNewAssistantBadge(
  message: ServerMessage,
  lastAssistantId: string | null,
  showNewBadge: boolean,
  failedAgentTurn: ServerMessage | null,
): boolean {
  return showNewBadge && !failedAgentTurn && message.id === lastAssistantId
}

export function progressTextFromLog(log: AgentLogEntry[] | undefined): string | null {
  if (!log?.length) return null
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    if (entry.kind === 'event') {
      const text = progressTextForEvent(entry.event)
      if (text) return text
    } else if (entry.kind === 'stderr') {
      return 'Making mistakes'
    } else if (entry.kind === 'unparsed') {
      return 'Wondering'
    }
  }
  return null
}

export function liveDeveloperProgressMessage(
  activeAgentTurn: ServerMessage | null,
  developerMode: boolean,
): ServerMessage | null {
  if (!developerMode || !activeAgentTurn?.progressLog?.length) return null

  const log = activeAgentTurn.progressLog.filter(isLiveDeveloperProgressEntry)
  if (log.length === 0) return null

  return {
    ...activeAgentTurn,
    id: `${activeAgentTurn.id}:live-progress`,
    role: 'agent',
    content: { type: 'events', log },
  }
}

/**
 * Build a transient assistant message from the streaming text the model
 * has produced so far. Rendered as a regular MessageBubble while the
 * turn is in flight so the user sees the answer growing word-by-word
 * (the same way a finalized message bubble looks) instead of a generic
 * "Thinking…" status indicator. Returns null when no text has streamed
 * yet, in which case the caller should keep showing the status text.
 */
export function liveAssistantTextMessage(
  activeAgentTurn: ServerMessage | null,
): ServerMessage | null {
  // Do not render in-flight text deltas as a regular assistant bubble.
  // pi can briefly stream reasoning content as a `text` delta before a
  // later part update classifies the same part as `reasoning`; rendering here
  // makes private reasoning flash in the normal chat until the tool/reasoning
  // event catches up. Finalized messages are still rendered from persisted text
  // after the full log can be filtered safely.
  void activeAgentTurn
  return null
}

function isLiveDeveloperProgressEntry(entry: AgentLogEntry): boolean {
  if (entry.kind === 'stderr') return true
  if (entry.kind !== 'event') return false
  const type = entry.event.type
  return type !== 'text' && type !== 'step_start' && type !== 'step_finish'
}

const TOOL_PROGRESS_LABELS: Record<string, string> = {
  apply_patch: 'Patching',
  bash: 'Running',
  edit: 'Editing',
  glob: 'Searching',
  grep: 'Checking',
  mcp: 'Calling',
  read: 'Reading',
  skill: 'Learning',
  todowrite: 'Planning',
  webfetch: 'Browsing',
}

const NESTED_TOOL_PROGRESS_LABELS: Record<string, string> = {
  playwright_browser_evaluate: 'Inspecting',
  playwright_browser_navigate: 'Navigating',
}

const GENERIC_TOOL_PROGRESS_LABELS: Record<string, string> = {
  tool_use: 'Crafting',
  tool_execution_update: 'Taking a break',
  tool: 'Building',
}

function progressTextForEvent(event: AgentEvent): string | null {
  if (event.type === 'text') return null
  if (event.type === 'step_start' || event.type === 'step_finish') return null
  if (event.type === 'reasoning') return null
  if (event.type === 'tool_use') {
    return progressTextForToolEvent(event) ?? GENERIC_TOOL_PROGRESS_LABELS.tool_use
  }
  if (event.type === 'tool_call' || event.type === 'tool-call') {
    return progressTextForToolEvent(event)
  }
  if (event.type === 'tool_result' || event.type === 'tool-result') {
    return progressTextForToolEvent(event)
  }
  if (event.type === 'tool' || event.type === 'tool_execution_update') {
    return progressTextForToolEvent(event) ?? GENERIC_TOOL_PROGRESS_LABELS[event.type]
  }
  return null
}

function progressTextForToolEvent(event: AgentEvent): string | null {
  const tool = pickToolName(event)
  if (tool === 'mcp') {
    const nestedTool = pickNestedToolName(event)
    if (nestedTool) return NESTED_TOOL_PROGRESS_LABELS[nestedTool] ?? TOOL_PROGRESS_LABELS.mcp
  }
  if (tool && TOOL_PROGRESS_LABELS[tool]) return TOOL_PROGRESS_LABELS[tool]
  if (event.type === 'tool' || event.type === 'tool_execution_update' || event.type === 'tool_use') {
    return GENERIC_TOOL_PROGRESS_LABELS[event.type] ?? null
  }
  return null
}

function pickToolName(event: AgentEvent): string | undefined {
  return pickProgressString(event.part, 'tool')
    ?? pickProgressString(event.part, 'name')
    ?? pickProgressString(event.part, 'command')
    ?? pickProgressString(event, 'tool')
    ?? pickProgressString(event, 'name')
    ?? pickProgressString(event, 'command')
}

function pickNestedToolName(event: AgentEvent): string | undefined {
  const args = event.part && typeof event.part === 'object'
    ? (event.part as Record<string, unknown>).args
    : undefined
  const topLevelArgs = typeof event.args === 'object' ? event.args : undefined
  return pickProgressString(args, 'tool')
    ?? pickProgressString(topLevelArgs, 'tool')
    ?? pickProgressString(event.part, 'args.tool')
    ?? pickProgressString(event, 'args.tool')
}

function pickProgressString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * RTK Query's `data` intentionally keeps the previous successful result while a
 * new arg is loading. That is useful for same-view refetches, but it is wrong
 * when switching regular ⇄ developer mode: compact/timeline payloads have
 * redacted tools and no summaries, so rendering them under developer-mode
 * visibility makes tool calls appear inconsistently until the full request wins.
 */
export function currentChatMessagesData(
  queryKey: string,
  lastResolvedQueryKey: string,
  currentData: ListMessagesResponse | undefined,
  cachedData: ListMessagesResponse | undefined,
): ListMessagesResponse | undefined {
  if (currentData) return currentData
  return lastResolvedQueryKey === queryKey ? cachedData : undefined
}

export interface ChatThreadProps {
  chatId: string
  workspaceId?: string
  /** When true the messages query is skipped (used for the "new chat" stub). */
  skipQuery?: boolean
  agentName?: string
  developerMode?: boolean
  /** Additional "sending" state from the parent's mutation (POST /messages). */
  isSending?: boolean
  highlightMessageId?: string
  /** CSS classes for the inner message list container. */
  innerClassName?: string
  /** CSS classes for regular message rows within the list container. */
  messageClassName?: string | ((message: ServerMessage) => string | undefined)
  /** CSS classes for the typing/status row. */
  statusClassName?: string
  /** CSS classes for the agent name/time row. */
  agentHeaderClassName?: string
  /** CSS classes for content rendered after the final assistant message. */
  lastAssistantSlotClassName?: string
  /** Rendered above the message list (e.g. "Open in chat" link). */
  headerSlot?: ReactNode
  /** Rendered below the scroll area (e.g. ChatInput). */
  footerSlot?: ReactNode
  /** Replaces the default "No messages yet" empty state. */
  emptySlot?: ReactNode
  onAttachmentClick?: (attachment: AttachmentRef) => void
  /** Called after the last assistant message (e.g. inline artifact cards). */
  lastAssistantSlot?: (messageId: string) => ReactNode
  showNewBadge?: boolean
  /** Optional additional filter applied after the default visibility check.
   *  Return false to hide a message from this thread instance.
   *  Should be a stable reference (module-level constant or memoized) to avoid
   *  unnecessary message-list recomputations. */
  filterMessage?: (m: ServerMessage) => boolean
}

export function ChatThread({
  chatId,
  workspaceId,
  skipQuery = false,
  agentName,
  developerMode = false,
  isSending = false,
  highlightMessageId,
  innerClassName = 'space-y-6 p-4',
  messageClassName,
  statusClassName,
  agentHeaderClassName,
  lastAssistantSlotClassName,
  headerSlot,
  footerSlot,
  emptySlot,
  onAttachmentClick,
  lastAssistantSlot,
  showNewBadge = false,
  filterMessage,
}: ChatThreadProps) {
  // ── Scrollback state ─────────────────────────────────────────────────
  const [beforeCursor, setBeforeCursor] = useState<string | undefined>(undefined)

  // Reset scrollback state when the message source changes. Regular and
  // developer mode use different server views/cursors, so carrying a regular
  // scrollback cursor into developer mode can make the full view briefly load
  // the wrong page and surface tool rows inconsistently.
  const threadKey = `${chatId}:${developerMode ? 'full' : 'timeline'}`
  const prevThreadKeyRef = useRef(threadKey)
  if (prevThreadKeyRef.current !== threadKey) {
    prevThreadKeyRef.current = threadKey
    setBeforeCursor(undefined)
  }

  // Initial load — newest page (no cursor). Use `data` (not `currentData`)
  // so we keep showing the previous chat's messages while the next chat's
  // request is in flight, instead of blanking out and remounting the
  // textarea/dropzone mid-interaction.
  const queryKey = chatMessagesQueryKey(chatId, developerMode)
  const lastResolvedQueryKeyRef = useRef(queryKey)
  const { data, currentData, isError } = useGetChatMessagesQuery(
    { chatId, full: developerMode },
    { skip: skipQuery },
  )
  if (currentData) lastResolvedQueryKeyRef.current = queryKey
  const activeData = currentChatMessagesData(queryKey, lastResolvedQueryKeyRef.current, currentData, data)

  // Load older page when beforeCursor is set.
  const { isFetching: isFetchingOlder } = useGetChatMessagesQuery(
    { chatId, before: beforeCursor!, full: developerMode },
    { skip: skipQuery || !beforeCursor },
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollbarWidth, setScrollbarWidth] = useState(0)
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  // Per-id stable ref callback. The naïve inline `ref={el => ...}` form
  // creates a new function identity on every render, so React calls the
  // callback with null and then the same element again on every re-render
  // of the parent — at N messages this is one of the dominant per-render
  // costs once a thread gets long. Memoizing per id keeps the callback
  // identity stable so React skips the spurious null/element pair.
  const messageRefCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map())
  const getMessageRefCallback = (id: string) => {
    let cb = messageRefCallbacks.current.get(id)
    if (!cb) {
      cb = (el: HTMLDivElement | null) => {
        if (el) messageRefs.current.set(id, el)
        else {
          messageRefs.current.delete(id)
          messageRefCallbacks.current.delete(id)
        }
      }
      messageRefCallbacks.current.set(id, cb)
    }
    return cb
  }
  /** Tracks whether we should auto-scroll to bottom (user is at the bottom). */
  const isAtBottomRef = useRef(true)
  /** When loading older messages, stores the scroll-height before prepend so
   *  we can restore the scroll position after the DOM updates. */
  const scrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)

  const allItems = activeData?.items ?? []
  const prevCursor = activeData?.prevCursor
  const isInitialLoading = !skipQuery && !activeData && !isError

  // Resolve the workspace's filesystem path once for the whole thread so
  // every MessageBubble doesn't have to subscribe to the workspaces cache
  // individually. With N messages, the per-bubble subscription used to
  // fan out into N RTK Query notifications on every workspace update.
  const { data: workspaces } = useGetWorkspacesQuery()
  const workspacePath = workspaces?.find(w => w.id === workspaceId)?.path

  const activeAgentTurn = useMemo(
    () => findActiveAgentTurn(allItems),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeData],
  )
  const hasPendingTrigger = activeAgentTurn !== null
  const isTyping = hasPendingTrigger || isSending

  const statusText = useMemo(() => {
    return progressTextFromLog(activeAgentTurn?.progressLog)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentTurn])

  const liveDeveloperMessage = useMemo(
    () => liveDeveloperProgressMessage(activeAgentTurn, developerMode),
    [activeAgentTurn, developerMode],
  )

  const liveAssistantText = useMemo(
    () => liveAssistantTextMessage(activeAgentTurn),
    [activeAgentTurn],
  )

  // Detect the most recent failed turn, or a visually silent turn that only
  // produced hidden diagnostics, to show an inline error banner instead of the
  // generic tool-only completion fallback.
  const failedAgentTurn = useMemo(() => {
    if (isTyping) return null
    return findFailedOrDiagnosticAgentTurn(allItems)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeData, isTyping])

  const failedAgentTurnDetail = useMemo(
    () => failureDetailForAgentTurn(allItems, failedAgentTurn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeData, failedAgentTurn],
  )

  const showToolOnlyFallback = useMemo(
    () => !isTyping && !failedAgentTurn && shouldShowToolOnlyRunFallback(allItems, developerMode),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeData, developerMode, isTyping, failedAgentTurn],
  )

  const messages: ServerMessage[] = useMemo(
    () => {
      const visible = allItems.filter(m => {
        if (!isMessageVisible(m, developerMode)) return false
        return developerMode || !isFailedRunDiagnosticMessage(m, allItems, failedAgentTurn)
      })
      return filterMessage ? visible.filter(filterMessage) : visible
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeData, developerMode, filterMessage, failedAgentTurn],
  )

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'agent') return messages[i].id
    }
    return null
  }, [messages])

  const resolvedStatusClassName = statusClassName ?? (typeof messageClassName === 'string' ? messageClassName : undefined)

  // Keep fixed footer content centered against the scrollable message viewport.
  // Classic scrollbars reduce the scroll area's client width, while the footer
  // sits outside that scroller; exposing the measured gutter lets callers apply
  // the same right inset so message/input columns don't drift by scrollbar width.
  // The scroll container reserves that gutter even while content is short, which
  // keeps the message column and composer from jumping between pending/idle states.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const updateScrollbarWidth = () => {
      setScrollbarWidth(Math.max(0, el.offsetWidth - el.clientWidth))
    }

    updateScrollbarWidth()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateScrollbarWidth) : null
    observer?.observe(el)
    window.addEventListener('resize', updateScrollbarWidth)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateScrollbarWidth)
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setScrollbarWidth(Math.max(0, el.offsetWidth - el.clientWidth))
  }, [messages.length, isTyping, showToolOnlyFallback, liveDeveloperMessage, failedAgentTurn])

  // ── Scroll position management ───────────────────────────────────────
  // Track message count to detect when older messages were prepended.
  const prevMessageCountRef = useRef(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // Handle highlighted message scrolling.
    if (highlightMessageId) {
      const msgEl = messageRefs.current.get(highlightMessageId)
      if (msgEl) {
        msgEl.scrollIntoView({ block: 'center' })
        return
      }
    }

    // If older messages were prepended (count grew AND we captured a scroll
    // anchor), restore scroll position so the user's viewport doesn't jump.
    if (scrollAnchorRef.current && messages.length > prevMessageCountRef.current) {
      const { scrollHeight: prevHeight, scrollTop: prevTop } = scrollAnchorRef.current
      const newHeight = el.scrollHeight
      el.scrollTop = prevTop + (newHeight - prevHeight)
      scrollAnchorRef.current = null
      prevMessageCountRef.current = messages.length
      return
    }

    prevMessageCountRef.current = messages.length

    // Auto-scroll to bottom when at/near the bottom — but only if
    // there's actually a thread of messages. When the chat is empty
    // (new-chat first paint), the scroll-to-bottom pushes the
    // empty-state H2 ("What would you like to create?") above the
    // viewport on short screens; messages.length === 0 means there's
    // nothing to follow, so the scroll is purely harmful.
    if (isAtBottomRef.current && messages.length > 0) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, isTyping, failedAgentTurn, highlightMessageId])

  // On initial load, scroll to bottom.
  const hasInitialScrolled = useRef(false)
  useEffect(() => {
    if (!isInitialLoading && messages.length > 0 && !hasInitialScrolled.current) {
      hasInitialScrolled.current = true
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    }
  }, [isInitialLoading, messages.length])

  // Reset initial scroll flag when the chat or backing message view changes.
  useEffect(() => {
    hasInitialScrolled.current = false
  }, [chatId, developerMode])

  // ── Load older messages on scroll-to-top ─────────────────────────────
  const loadOlderMessages = useCallback(() => {
    if (!prevCursor || isFetchingOlder) return
    // Capture current scroll position before the DOM changes.
    if (scrollRef.current) {
      scrollAnchorRef.current = {
        scrollHeight: scrollRef.current.scrollHeight,
        scrollTop: scrollRef.current.scrollTop,
      }
    }
    setBeforeCursor(prevCursor)
  }, [prevCursor, isFetchingOlder])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    // Track whether we're at the bottom (within 40px tolerance).
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40

    // Load older messages when scrolled near the top.
    if (el.scrollTop < SCROLL_TOP_THRESHOLD) {
      loadOlderMessages()
    }
  }, [loadOlderMessages])

  if (isInitialLoading) {
    return (
      <div className="flex flex-col flex-1 min-w-0 min-h-0 w-full max-w-full overflow-hidden">
        {headerSlot}
        <div className="flex flex-1 min-h-0 items-center justify-center text-sm text-muted-foreground" data-testid="chat-thread-loading">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading chat…</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex flex-col flex-1 min-w-0 min-h-0 w-full max-w-full overflow-hidden"
      style={{ '--chat-thread-scrollbar-width': `${scrollbarWidth}px` } as CSSProperties}
    >
      {headerSlot}
      <div
        ref={scrollRef}
        className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
        // Top + bottom edge mask: messages fade as they scroll up past
        // the top bar and as they scroll down behind the composer.
        // Mask is on the scrolling element itself (not an overlay) so it
        // tracks the content, not a fixed strip near the chrome.
        //
        // Heads-up for anyone tempted to also put `mix-blend-mode` on a
        // descendant bubble: `mask-image` here creates a new stacking
        // context, which traps blends inside the masked subtree and
        // stops them reaching the AppShell-level BackgroundBlobs.
        // Either the mask goes, or the blend mode does.
        style={{
          maskImage: 'linear-gradient(to bottom, transparent 0, black 48px, black calc(100% - 48px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 48px, black calc(100% - 48px), transparent 100%)',
        }}
        onScroll={handleScroll}
      >
        <div className={`min-w-0 max-w-full ${innerClassName}`}>
          {/* Loading-older indicator */}
          {isFetchingOlder && (
            <div className="flex justify-center py-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {isError && (
            <p className="text-xs text-destructive text-center pt-4">
              Failed to load messages. Try refreshing.
            </p>
          )}
          {messages.length === 0 && !isInitialLoading && !isError && (
            emptySlot ?? (
              <p className="text-xs text-muted-foreground text-center pt-4" data-testid="task-chat-empty">
                No messages yet. Ask a question or request changes.
              </p>
            )
          )}
          {messages.map((msg, i) => {
            // Consecutive same-role messages sent within GROUP_WINDOW_MS
            // are treated as a single group: only the group's last
            // message surfaces the actions row, so the bubbles sit
            // tight (no per-message actions reserved space). Artifact
            // refs and event logs participate in groups too, so a
            // sequence like "text → file → text" sent in one breath
            // reads as one expression.
            const prev: typeof msg | undefined = messages[i - 1]
            const next: typeof msg | undefined = messages[i + 1]
            const isFirstInGroup = !sameMessageGroup(prev, msg)
            const isLastInGroup = !sameMessageGroup(msg, next)
            // The last message in a group carries the consolidated copy
            // action, so hand it the whole group (walk back over the run
            // of same-group messages) — copying then yields the group's
            // combined text plus a reference to each artifact in it.
            let groupMessages: ServerMessage[] | undefined
            if (isLastInGroup && !isFirstInGroup) {
              groupMessages = [msg]
              for (let j = i; j > 0 && sameMessageGroup(messages[j - 1], messages[j]); j--) {
                groupMessages.unshift(messages[j - 1])
              }
            }
            return (
            <div
              key={msg.id}
              className="min-w-0 max-w-full"
              data-message-id={msg.id}
              ref={getMessageRefCallback(msg.id)}
              // Messages followed by a same-group sibling sit 12 px apart
              // (vs the 24 px `space-y-6` gap between groups), so a group
              // reads as one. Inline override beats the space-y utility's
              // `margin-block-end` without an !important class.
              style={!isLastInGroup ? { marginBlockEnd: '12px' } : undefined}
            >
              <div className={`min-w-0 ${typeof messageClassName === 'function' ? (messageClassName(msg) ?? '') : (messageClassName ?? '')}`}>
                <MessageBubble
                  message={msg}
                  workspaceId={workspaceId}
                  workspacePath={workspacePath}
                  currentChatId={chatId}
                  agentName={agentName}
                  isFirstInGroup={isFirstInGroup}
                  isLastInGroup={isLastInGroup}
                  groupMessages={groupMessages}
                  isNew={shouldShowNewAssistantBadge(msg, lastAssistantId, showNewBadge, failedAgentTurn)}
                  onAttachmentClick={onAttachmentClick}
                  agentHeaderClassName={agentHeaderClassName}
                  hideAgentHeader={msg.content.type === 'artifactRef'}
                  developerMode={developerMode}
                />
              </div>
              {lastAssistantSlot && msg.id === lastAssistantId && (
                <div className={lastAssistantSlotClassName}>
                  {lastAssistantSlot(msg.id)}
                </div>
              )}
            </div>
            )
          })}
          {showToolOnlyFallback && (
            <div className={resolvedStatusClassName}>
              <ToolOnlyRunFallback />
            </div>
          )}
          {liveDeveloperMessage && (
            <div className={resolvedStatusClassName}>
              <MessageBubble
                message={liveDeveloperMessage}
                workspaceId={workspaceId}
                workspacePath={workspacePath}
                agentName={agentName}
                isFirstInGroup
                onAttachmentClick={onAttachmentClick}
                agentHeaderClassName={agentHeaderClassName}
                developerMode={developerMode}
              />
            </div>
          )}
          {liveAssistantText && (
            <div className={resolvedStatusClassName}>
              <MessageBubble
                message={liveAssistantText}
                workspaceId={workspaceId}
                workspacePath={workspacePath}
                agentName={agentName}
                isFirstInGroup
                onAttachmentClick={onAttachmentClick}
                agentHeaderClassName={agentHeaderClassName}
                developerMode={false}
              />
            </div>
          )}
          {isTyping && !liveAssistantText && (
            <div className={resolvedStatusClassName}>
              <StatusIndicator text={statusText} isTyping={isTyping} />
            </div>
          )}
          {failedAgentTurn && (
            <div className={resolvedStatusClassName}>
              <FailedRunBanner
                chatId={failedAgentTurn.chatId}
                messageId={failedAgentTurn.id}
                failureDetail={failedAgentTurnDetail}
                isNew={showNewBadge}
              />
            </div>
          )}
        </div>
      </div>
      {footerSlot}
    </div>
  )
}

function ToolOnlyRunFallback() {
  return (
    <div className="min-w-0 max-w-full space-y-1.5" data-testid="tool-only-run-fallback">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3 text-muted-foreground/60 shrink-0" />
          <span className="text-xs text-muted-foreground">Desk</span>
        </div>
      </div>
      <div className="rounded-lg bg-muted/50 px-3.5 py-2.5 text-sm text-muted-foreground">
        Done — I used tools for this run and didn&apos;t write a separate reply.
      </div>
    </div>
  )
}
