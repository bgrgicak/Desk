import { memo, useState, type MouseEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ChevronRight, FileText, Folder, Wrench, AlertTriangle, Paperclip, ListTodo, Reply, MessagesSquare, Copy, ThumbsUp, ThumbsDown, Check } from 'lucide-react'
import { cn } from '@roomy-ai/ui'
import type { AgentEvent, AgentLogEntry, AttachmentRef, MessageContent, ServerMessage } from '@/store/types'
import { appAttachmentToPreview } from '@/components/context/AppPreview'
import { getRelativeTime } from '@/data/ui-types'
import { fileTypeLabel } from '@/data/file-kind'
import { humanSize } from '@/store/selectors/library'
import { MarkdownContent } from '@/components/MarkdownContent'
import { InlineArtifactPreview, UnsupportedFileCard } from '@/components/shared/InlineArtifactPreview'
import { TaskResultCard } from './TaskResultCard'
import { useDeleteLibraryFileMutation, useGetSummaryHistoryQuery, usePostMessageFeedbackMutation } from '@/store/api'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { openArtifact, selectIsArtifactInPanel } from '@/store/slices/previewPanelSlice'
import { diffLines, type DiffSegment } from '@/lib/summary-diff'
import { buildPath, NEW_CHAT_ID } from '@/router/nav'
import { Link } from 'react-router-dom'
import { useChatNav } from '@/components/chats/ChatNavContext'
import { isRegularMessageVisible, isStructuredToolPayloadLine, isUserVisibleDiagnosticLine, userVisibleDiagnosticTextForEvent } from './messageVisibility'
import { MessageThreadButton } from './MessageThreadButton'

interface MessageBubbleProps {
  message: ServerMessage
  workspaceId?: string
  /**
   * Filesystem path of the workspace, used to rewrite sandbox paths inside
   * markdown links and tool output. Passed in by the parent — historically
   * each bubble subscribed to `useGetWorkspacesQuery` itself, but with N
   * bubbles in a long thread that fans out into N RTK Query subscribers
   * notified on every workspace update. Look it up once at the thread
   * level and pass it down.
   */
  workspacePath?: string
  isFirstInGroup?: boolean
  /** When false, this message is part of a group and a later message
   *  from the same sender follows shortly after — so the actions row
   *  (copy / reply / feedback / timestamp) is suppressed and only
   *  surfaces on the group's last message. Defaults to `true` so
   *  standalone usages keep their actions row. */
  isLastInGroup?: boolean
  /** All messages belonging to this message's group, supplied only to
   *  the group's last message (the one that renders the actions row).
   *  The copy action aggregates over these so a grouped artifact card +
   *  follow-up reply copies as one (text + a reference per artifact).
   *  When absent the copy action falls back to this single message. */
  groupMessages?: ServerMessage[]
  isNew?: boolean
  /** Agent name to display in the message header. */
  agentName?: string
  /** Fires when the user clicks an attachment chip — caller opens it. */
  onAttachmentClick?: (attachment: AttachmentRef) => void
  /** Keeps agent metadata aligned when the message content uses a wider row. */
  agentHeaderClassName?: string
  hideAgentHeader?: boolean
  /** When false, internal tool-call/stderr entries inside `events` content
   *  are stripped — only the agent's text reply surfaces. ChatView already
   *  filters out fully-tool `events` rows at the list level. */
  developerMode?: boolean
  /** The chat currently being viewed. Used to suppress the thread button on
   *  the anchor message when the user is already inside that thread. */
  currentChatId?: string
  /** Attachment paths to suppress from the rendered chip list. Used in
   *  contexts where the file is already prominently displayed (e.g. the
   *  library file-detail view) so repeating it as an attachment is redundant. */
  hideAttachmentPaths?: string[]
}

export const MessageBubble = memo(function MessageBubble({
  message,
  workspaceId,
  workspacePath,
  isFirstInGroup = true,
  isLastInGroup = true,
  groupMessages,
  isNew = false,
  agentName,
  onAttachmentClick,
  agentHeaderClassName,
  hideAgentHeader = false,
  developerMode = false,
  currentChatId,
  hideAttachmentPaths,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const modelLabel = agentName ?? 'Agent'
  const timestamp = new Date(message.createdAt)
  const visibleAttachments = message.attachments?.filter(
    att => !hideAttachmentPaths?.includes(att.path),
  ) ?? []
  const hasAttachments = visibleAttachments.length > 0
  const showThread = isRegularMessageVisible(message) && !!workspaceId
    && message.threadChatId !== currentChatId
    // ArtifactRef messages render as inline previews (chat-forms fragments,
    // app embeds). The thread-button sibling forces the preview into a
    // narrower flex column, which is what kept fragment iframes from
    // reaching the full chat-column width. Threading still works through
    // the surrounding turn — just not from the artifactRef row itself.
    && message.content.type !== 'artifactRef'
  // Surface the larger "X replies" affordance under the message when
  // a thread already exists; the inline Reply icon in the actions row
  // is reserved for *starting* a thread from a message that has none.
  const showThreadButton = showThread && !!message.threadChatId && !!workspaceId

  // A task definition (the AI creating a task, or one surfaced in the
  // conversation) renders as an inline Task result card regardless of
  // author — except when we're already inside that task's own thread,
  // where the same anchor message renders as the thread's header
  // (title + full description, no status badge or View button) so it
  // doesn't visually duplicate the "you are in this task" affordance.
  if (message.kind === 'task') {
    if (message.threadChatId && message.threadChatId === currentChatId) {
      return <TaskAnchorHeader message={message} />
    }
    return <TaskResultCard message={message} workspaceId={workspaceId} />
  }

  if (isUser) {
    if (message.kind === 'task_run' && message.content.type === 'text') {
      return <TaskRunChip prompt={message.content.text} />
    }
    return (
      <div className="group min-w-0 max-w-full flex flex-col items-end">
        {hasAttachments && (
          <div className="flex w-full min-w-0 max-w-full flex-col items-end gap-1.5 overflow-hidden mb-1.5">
            {visibleAttachments.map(att => (
              <AttachmentCard
                key={att.path}
                attachment={att}
                workspaceId={workspaceId}
                chatId={message.chatId}
                align="right"
                onClick={onAttachmentClick ? () => onAttachmentClick(att) : undefined}
              />
            ))}
          </div>
        )}
        {message.content.type === 'text' && message.content.text && (
          // Note: we deliberately don't apply `mix-blend-multiply`
          // here. The chat thread's scroll container uses
          // `mask-image` for the top/bottom edge fade, which creates
          // a new stacking context — that stops any blend mode on a
          // descendant from reaching the AppShell-level
          // BackgroundBlobs, so it has no visible effect. If we ever
          // want the blend back, either replace the mask with a
          // non-stacking-context fade (e.g. a duplicated local blob
          // layer + sibling gradient strips) or hoist the bubble out
          // of the masked subtree.
          <div className="max-w-[80%] min-w-0 break-words bg-secondary text-foreground text-sm leading-relaxed px-3.5 py-2.5 rounded-lg rounded-br-[2px]">
            <MarkdownContent text={message.content.text} workspacePath={workspacePath} workspaceId={workspaceId} />
          </div>
        )}
        {isLastInGroup && <UserMessageActions messages={groupMessages ?? [message]} timestamp={timestamp} />}
      </div>
    )
  }

  // The agent header (Bot icon + model name + timestamp + "New" badge)
  // used to live above the message; it's been retired in favour of the
  // hover-revealed actions row below. `modelLabel`, `isNew`,
  // `agentHeaderClassName`, and `hideAgentHeader` remain on the prop
  // surface for callers that still set them, but no longer render.
  // `isFirstInGroup` previously controlled a `-mt-4` collapse for
  // consecutive grouped messages — now obsolete because the thread no
  // longer uses `space-y-*` between messages (each message brings its
  // own trailing actions row, which provides the natural separation).
  void modelLabel
  void isNew
  void agentHeaderClassName
  void hideAgentHeader
  void isFirstInGroup

  return (
    <div className="group min-w-0 max-w-full">
      {hasAttachments && (
        <div className="flex w-full min-w-0 max-w-full flex-col items-start gap-1.5 overflow-hidden mb-1.5">
          {visibleAttachments.map(att => (
            <AttachmentCard
              key={att.path}
              attachment={att}
              workspaceId={workspaceId}
              chatId={message.chatId}
              onClick={onAttachmentClick ? () => onAttachmentClick(att) : undefined}
            />
          ))}
        </div>
      )}
      <MessageContentView
        content={message.content}
        chatId={message.chatId}
        messageId={message.id}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        developerMode={developerMode}
        onAttachmentClick={onAttachmentClick}
      />
      {isLastInGroup && (
        // One row below the message holding the thread button (always
        // visible, left) and the hover-revealed actions (12 px gap to
        // the right of the button). The row is left-aligned in both
        // cases: with a thread button the actions sit just to its
        // right; without one they sit at the left edge under the
        // message rather than being pushed to the far right gutter.
        <div className="mt-3 flex items-center gap-3">
          {showThreadButton && (
            <MessageThreadButton
              threadChatId={message.threadChatId!}
              workspaceId={workspaceId!}
            />
          )}
          <AgentMessageActions
            messages={groupMessages ?? [message]}
            message={message}
            workspaceId={workspaceId}
            timestamp={timestamp}
            // The inline Reply icon is for *starting* a thread; once
            // one exists, the bigger button to its left carries the
            // affordance.
            showThread={showThread && !showThreadButton}
          />
        </div>
      )}
    </div>
  )
})

// ── Agent-message actions ──────────────────────────────────────────────────
//
// Hover-revealed cluster that sits to the RIGHT of an agent message,
// in the gutter freed up by the 80 % content cap. Carries the timestamp
// followed by copy / 👍 / 👎, with an optional inline reply icon for
// messages that don't yet have a thread.

interface AgentMessageActionsProps {
  /** The message that owns this actions row (drives feedback +
   *  threading targets). */
  message: ServerMessage
  /** Every message in the group, copied together as one. Defaults to
   *  just `message` for standalone (ungrouped) usages. */
  messages: ServerMessage[]
  workspaceId?: string
  timestamp: Date
  /** Whether to surface the small inline reply/open-thread icon.
   *  Suppressed when the message already has a bigger thread button
   *  below — the two affordances would be redundant. */
  showThread: boolean
}

function AgentMessageActions({
  message,
  messages,
  workspaceId,
  timestamp,
  showThread,
}: AgentMessageActionsProps) {
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  const [postFeedback] = usePostMessageFeedbackMutation()

  const handleCopy = () => copyMessagesToClipboard(messages, workspaceId)

  const handleFeedback = (kind: 'up' | 'down') => {
    if (feedback === kind) return
    const previous = feedback
    setFeedback(kind)
    toast.success(
      kind === 'up'
        ? 'Thanks for the positive feedback'
        : "Thanks for the feedback — we'll do better",
    )
    // The reaction is persisted as a system message so the workspace's
    // daily reflection can see which replies the user marked helpful
    // or unhelpful. Roll back the local active state if the request
    // fails so the icons match server truth.
    postFeedback({ chatId: message.chatId, messageId: message.id, rating: kind })
      .unwrap()
      .catch(() => {
        setFeedback(previous)
      })
  }

  const hasThread = !!message.threadChatId
  const chatNav = useChatNav()
  // Thread-button target: prefer context-provided builders (e.g. home screen);
  // fall back to workspace-scoped room paths when no override is set.
  const threadTo = (() => {
    if (hasThread) {
      return (
        chatNav.buildThreadHref(message.threadChatId!) ??
        (workspaceId ? buildPath(workspaceId, 'tasks', { chat: message.threadChatId! }) : null)
      )
    }
    return (
      chatNav.buildNewThreadHref(message.chatId, message.id) ??
      (workspaceId
        ? buildPath(workspaceId, 'tasks', { chat: NEW_CHAT_ID, startThread: `${message.chatId}:${message.id}` })
        : null)
    )
  })()

  return (
    <div
      className={cn(
        'h-5 flex items-center gap-0.5',
        'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100',
        'transition-opacity',
      )}
    >
      <span className="text-xs text-muted-foreground mr-1">{getRelativeTime(timestamp)}</span>
      <ActionIconButton title="Copy message" onClick={handleCopy}>
        <Copy className="h-3.5 w-3.5" />
      </ActionIconButton>
      {showThread && threadTo && (
        <Link
          to={threadTo}
          state={hasThread ? undefined : { anchorMessage: message }}
          title={hasThread ? 'Open thread' : 'Reply in thread'}
          className="flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
        >
          {hasThread
            ? <MessagesSquare className="h-3.5 w-3.5" />
            : <Reply className="h-3.5 w-3.5" />}
        </Link>
      )}
      <ActionIconButton
        title="Helpful"
        onClick={() => handleFeedback('up')}
        active={feedback === 'up'}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </ActionIconButton>
      <ActionIconButton
        title="Not helpful"
        onClick={() => handleFeedback('down')}
        active={feedback === 'down'}
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </ActionIconButton>
    </div>
  )
}

function ActionIconButton({
  title,
  onClick,
  active = false,
  children,
}: {
  title: string
  onClick: () => void
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'flex items-center justify-center h-5 w-5 rounded transition-colors',
        active
          ? 'text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]',
      )}
    >
      {children}
    </button>
  )
}

// ── User-message actions ───────────────────────────────────────────────────
//
// Mirror of the agent actions, scoped to what the user can do with
// their own message: copy + timestamp. There's no reply/thread
// affordance — threading from your own message isn't a meaningful
// action. The cluster sits in the freed-up gutter to the LEFT of the
// bubble (parent flex row handles the gap).

function UserMessageActions({
  messages,
  timestamp,
}: {
  messages: ServerMessage[]
  timestamp: Date
}) {
  return (
    <div
      className={cn(
        'mt-2 h-5 flex items-center justify-end gap-0.5',
        'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100',
        'transition-opacity',
      )}
    >
      <span className="text-xs text-muted-foreground mr-1">{getRelativeTime(timestamp)}</span>
      <ActionIconButton title="Copy message" onClick={() => copyMessagesToClipboard(messages)}>
        <Copy className="h-3.5 w-3.5" />
      </ActionIconButton>
    </div>
  )
}

// ── Shared copy helper ─────────────────────────────────────────────────────

/** Copy a group of messages to the clipboard as one block and surface a
 *  toast for confirmation / failure. Shared by both `AgentMessageActions`
 *  and `UserMessageActions` so the UX matches. A single-message group is
 *  the common case (one bubble); grouped agent turns (e.g. an artifact
 *  card + a follow-up reply) copy together. */
async function copyMessagesToClipboard(messages: ServerMessage[], workspaceId?: string): Promise<void> {
  const text = copyTextForMessages(messages, workspaceId)
  if (!text) {
    toast.error('Nothing to copy from this message')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Copied to clipboard')
  } catch (err) {
    toast.error('Failed to copy', {
      description: err instanceof Error ? err.message : undefined,
    })
  }
}

/** Build the copyable text for a message group: each message's text
 *  joined by blank lines, with artifact references contributing a
 *  markdown link to the artifact (a reference, not its contents).
 *  Returns `null` when nothing copyable remains. */
export function copyTextForMessages(messages: ServerMessage[], workspaceId?: string): string | null {
  const parts: string[] = []
  for (const message of messages) {
    const text = copyMessageText(message)
    if (text) {
      parts.push(text)
    } else if (message.content.type === 'artifactRef') {
      parts.push(artifactReferenceLink(message.content, workspaceId))
    }
  }
  const joined = parts.join('\n\n').trim()
  return joined || null
}

/** A `[name](url)` markdown link for an artifact reference. Falls back
 *  to the bare name when no href can be resolved (no workspace). The URL
 *  is absolute when a window origin is available so it stays clickable
 *  when pasted outside the app. */
function artifactReferenceLink(
  content: Extract<MessageContent, { type: 'artifactRef' }>,
  workspaceId?: string,
): string {
  const label = content.name ?? basenamePath(content.path)
  const href = artifactRefHref(content.workspaceId ?? workspaceId, content.path, content.mime, content.params)
  if (!href) return label
  const url = typeof window !== 'undefined' ? `${window.location.origin}${href}` : href
  return `[${label}](${url})`
}

/** Extract a copyable text representation from a message. Returns
 *  `null` when the message has no text content (e.g. a bare artifact
 *  reference or a summary-only entry). */
function copyMessageText(message: ServerMessage): string | null {
  const content = message.content
  if (content.type === 'text') return content.text.trim() || null
  if (content.type === 'events') {
    const text = content.log
      .map(entry => {
        if (entry.kind === 'event' && entry.event.type === 'text') {
          const t = entry.event.part?.text
          return typeof t === 'string' ? t : ''
        }
        return ''
      })
      .join('')
      .trim()
    return text || null
  }
  return null
}

function MessageContentView({
  content,
  chatId,
  messageId,
  workspaceId,
  workspacePath,
  developerMode,
  onAttachmentClick,
}: {
  content: MessageContent
  chatId: string
  messageId: string
  workspaceId?: string
  workspacePath?: string
  developerMode: boolean
  onAttachmentClick?: (attachment: AttachmentRef) => void
}) {
  switch (content.type) {
    case 'text':
      return <MarkdownContent text={content.text} workspacePath={workspacePath} workspaceId={workspaceId} />
    case 'artifactRef':
      return (
        <ArtifactRefRow
          workspaceId={content.workspaceId ?? workspaceId}
          chatId={chatId}
          path={content.path}
          name={content.name}
          mime={content.mime}
          params={content.params}
          onClick={onAttachmentClick
            ? () => onAttachmentClick({
                path: content.path,
                name: content.name ?? basenamePath(content.path),
                mime: content.mime,
                kind: isDirectoryArtifact(content.mime) ? 'directory' : 'file',
                workspaceId: content.workspaceId,
                params: content.params,
              })
            : undefined}
        />
      )
    case 'events':
      return <EventsView log={content.log} developerMode={developerMode} workspacePath={workspacePath} workspaceId={workspaceId} />
    case 'toolCall':
      // Filtered upstream when developerMode is false; defensive guard here.
      if (!developerMode) return null
      return <ToolCallChip toolName={content.toolName} args={content.args} />
    case 'toolResult':
      if (!developerMode) return null
      return <ToolResultChip toolName={content.toolName} result={content.result} />
    case 'summary':
      if (!developerMode) return null
      return <SummaryView chatId={chatId} messageId={messageId} body={content.body} workspacePath={workspacePath} workspaceId={workspaceId} />
    case 'summary_request':
    case 'reflection_request':
    case 'agent_turn':
      // Filtered out of the bubble stream upstream. summary_request /
      // reflection_request / agent_turn drive background runs and typing state.
      // Render nothing if a stray row reaches this layer.
      return null
  }
}

function SummaryView({ chatId, messageId, body, workspacePath, workspaceId }: { chatId: string; messageId: string; body: string; workspacePath?: string; workspaceId?: string }) {
  const [showDiff, setShowDiff] = useState(false)
  // Lazy-load history only when the diff toggle is on so a chat with
  // many summaries doesn't hammer the API on render.
  const { data: history } = useGetSummaryHistoryQuery(
    { chatId, messageId },
    { skip: !showDiff },
  )
  const previousBody = history?.versions[0]?.body
  const segments: DiffSegment[] | null = showDiff && typeof previousBody === 'string'
    ? diffLines(previousBody, body)
    : null

  return (
    <div className="my-5 rounded-lg border border-dashed bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" />
          Chat summary
        </div>
        <button
          type="button"
          onClick={() => setShowDiff(v => !v)}
          className="text-xs underline-offset-2 hover:underline"
          data-testid="summary-diff-toggle"
        >
          {showDiff ? 'Show summary' : 'Show diff vs previous'}
        </button>
      </div>
      {segments ? (
        <SummaryDiffView segments={segments} />
      ) : showDiff && history && history.versions.length === 0 ? (
        <div className="text-xs italic text-muted-foreground" data-testid="summary-diff-empty">
          No prior version to diff against — this is the first materialized summary.
        </div>
      ) : (
        <MarkdownContent text={body} workspacePath={workspacePath} workspaceId={workspaceId} />
      )}
    </div>
  )
}

/**
 * Renders summary diff segments inline. Whole-line removes get a red
 * background, adds get green, equal context stays neutral. The
 * monospace font keeps line breaks aligned with the source markdown.
 */
function SummaryDiffView({ segments }: { segments: DiffSegment[] }) {
  return (
    <pre
      className="whitespace-pre-wrap rounded border bg-background/60 p-2 font-mono text-xs leading-snug"
      data-testid="summary-diff"
    >
      {segments.map((seg, i) => {
        const cls =
          seg.kind === 'remove'
            ? 'bg-red-100/80 text-red-900 dark:bg-red-900/40 dark:text-red-100'
            : seg.kind === 'add'
              ? 'bg-emerald-100/80 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100'
              : ''
        const prefix = seg.kind === 'remove' ? '- ' : seg.kind === 'add' ? '+ ' : '  '
        return (
          <span
            key={i}
            className={`block ${cls}`}
            data-testid={`summary-diff-${seg.kind}`}
          >
            {seg.text
              .split('\n')
              .map(line => prefix + line)
              .join('\n')}
          </span>
        )
      })}
    </pre>
  )
}

function basenamePath(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function isDirectoryArtifact(mime?: string | null) {
  return mime === 'inode/directory'
}

export function artifactRefHref(workspaceId: string | undefined, path: string, mime?: string | null, params?: Record<string, string>) {
  if (!workspaceId) return undefined
  if (appAttachmentToPreview(path)) {
    return buildPath(workspaceId, 'context', {
      item: path,
      artifactParams: params ? JSON.stringify(params) : null,
    })
  }
  return buildPath(workspaceId, 'context', {
    item: isDirectoryArtifact(mime) ? null : path,
    folder: isDirectoryArtifact(mime) ? path : null,
    artifactParams: params ? JSON.stringify(params) : null,
  })
}

function plainLeftClick(e: MouseEvent<HTMLAnchorElement>) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
}

function ArtifactRefRow({ workspaceId, chatId, path, name, mime, params, onClick }: { workspaceId?: string; chatId?: string; path: string; name?: string; mime?: string | null; params?: Record<string, string>; onClick?: () => void }) {
  const label = name ?? basenamePath(path)
  const href = artifactRefHref(workspaceId, path, mime, params)
  const dispatch = useAppDispatch()
  // Highlighted = this artifact is currently mounted in the side
  // preview panel. The card flips into its active-state styling while
  // the panel shows the same file.
  const isActive = useAppSelector(s => selectIsArtifactInPanel(s, workspaceId, path))
  // The preview card's Delete affordance forwards here. It hits the
  // library-file delete mutation; the mock layer intercepts both the
  // request *and* purges any chat messages referencing the path so
  // the artifactRef bubble disappears alongside the file.
  const [deleteLibraryFile] = useDeleteLibraryFileMutation()
  const handleDelete = workspaceId
    ? async () => {
        await deleteLibraryFile({ workspaceId, path }).unwrap()
      }
    : undefined
  // Clicking the card body dispatches `openArtifact` so the preview
  // panel mounts (or swaps to) this file. The previous in-app navigation
  // (file detail route) stays available as a fallback when there's no
  // workspace context — that path can't be panel-mounted because the
  // panel needs the workspace id to fetch content.
  const handlePreview = workspaceId
    ? () => {
        dispatch(openArtifact({
          workspaceId,
          path,
          name: label,
          mime,
          params,
        }))
      }
    : onClick
  const fallback = (
    <UnsupportedFileCard
      name={label}
      path={path}
      mime={mime}
      workspaceId={workspaceId}
      openHref={href}
      isActive={isActive}
      onPreview={handlePreview}
      onDelete={handleDelete}
    />
  )
  // Global app previews (path starts with /opt/roomy-apps/) don't need a
  // workspaceId — only a chatId — so allow rendering without workspaceId
  // in that case. Other previews still require a workspaceId.
  const isGlobalPreviewPath = appAttachmentToPreview(path)?.scope === 'global'
  if (!workspaceId && !isGlobalPreviewPath) return fallback
  return (
    <InlineArtifactPreview
      workspaceId={workspaceId}
      chatId={chatId}
      path={path}
      name={label}
      mime={mime}
      params={params}
      onOpen={onClick}
      openHref={href}
      fallback={fallback}
      onDelete={handleDelete}
    />
  )
}

function AttachmentCard({
  attachment,
  workspaceId,
  chatId,
  align = 'left',
  onClick,
}: {
  attachment: AttachmentRef
  workspaceId?: string
  chatId?: string
  align?: AttachmentAlignment
  onClick?: () => void
}) {
  const appPreview = appAttachmentToPreview(attachment.path)
  const className =
    `inline-flex min-w-0 max-w-full items-center gap-2 ${attachmentAlignmentClass(align)} overflow-hidden rounded-lg border bg-background px-3 py-2 text-left text-xs align-top sm:max-w-[320px]`
  const Icon = attachment.kind === 'directory' ? Folder : Paperclip
  // Subtext: byte count when known. Otherwise describe the file by its
  // type (App, Image, …) rather than exposing the raw — often
  // chat-scoped, hidden — path. Plain directories read as "Folder".
  const subtext =
    attachment.kind !== 'directory' && typeof attachment.size === 'number'
      ? humanSize(attachment.size)
      : attachment.kind === 'directory' && !appPreview
        ? 'Folder'
        : fileTypeLabel(attachment.name, attachment.mime, !!appPreview)
  const inner = (
    <>
      <Icon className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{attachment.name}</p>
        <p className="text-[11px] text-muted-foreground truncate">{subtext}</p>
      </div>
    </>
  )
  const effectiveWorkspaceId = attachment.workspaceId ?? workspaceId
  const href = artifactRefHref(effectiveWorkspaceId, attachment.path, attachment.mime, attachment.params)
  const canRenderAppPreview = appPreview && (
    appPreview.scope === 'global' ? !!chatId : !!effectiveWorkspaceId
  )
  if (canRenderAppPreview) {
    return (
      <div className={`max-w-full ${attachmentAlignmentClass(align)}`}>
        <InlineArtifactPreview
          workspaceId={effectiveWorkspaceId}
          chatId={chatId}
          path={attachment.path}
          name={attachment.name}
          mime={attachment.mime}
          params={attachment.params}
          onOpen={onClick}
          openHref={href}
          fallback={href ? (
            <a
              href={href}
              onClick={e => { if (plainLeftClick(e) && onClick) { e.preventDefault(); onClick() } }}
              className={`${className} hover:bg-muted/40 transition-colors`}
            >
              {inner}
            </a>
          ) : !onClick ? <div className={className}>{inner}</div> : (
            <button
              type="button"
              onClick={onClick}
              className={`${className} hover:bg-muted/40 transition-colors`}
            >
              {inner}
            </button>
          )}
        />
      </div>
    )
  }
  if (href) {
    return (
      <a
        href={href}
        onClick={e => { if (plainLeftClick(e) && onClick) { e.preventDefault(); onClick() } }}
        className={`${className} hover:bg-muted/40 transition-colors`}
      >
        {inner}
      </a>
    )
  }
  if (!onClick) {
    return <div className={className}>{inner}</div>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${className} hover:bg-muted/40 transition-colors`}
    >
      {inner}
    </button>
  )
}

type AttachmentAlignment = 'left' | 'right'

export function attachmentAlignmentClass(align: AttachmentAlignment) {
  return align === 'right' ? 'self-end ml-auto' : 'self-start mr-auto'
}

/** The task anchor rendered as the first item of its own thread —
 *  a quiet bordered block with the task title and full description.
 *  No status badge, no View button, no kebab: the user is already
 *  inside the task's thread so the action surface lives on the
 *  Tasks page card and the right-panel header above the messages. */
function TaskAnchorHeader({ message }: { message: ServerMessage }) {
  const title = message.title?.trim()
    || (message.content.type === 'text' ? message.content.text.split('\n')[0].trim() : '')
    || 'Task'
  let body: string | undefined
  if (message.content.type === 'text') {
    const text = message.content.text.trim()
    if (message.title && text === message.title.trim()) {
      body = undefined
    } else if (message.title && text.startsWith(`${message.title.trim()}\n`)) {
      body = text.slice(message.title.trim().length).trim()
    } else if (message.title) {
      body = text
    } else {
      const [, ...rest] = text.split('\n')
      body = rest.join('\n').trim() || undefined
    }
  }
  return (
    <div className="rounded-lg border border-foreground/10 bg-foreground/5 px-4 py-3">
      <div className="text-sm font-medium text-foreground">{title}</div>
      {body ? (
        <div className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{body}</div>
      ) : null}
    </div>
  )
}

function TaskRunChip({ prompt }: { prompt: string }) {
  const preview = prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt
  return (
    <div className="my-5">
      <CollapsibleChip icon={<ListTodo className="h-3 w-3" />} label={`task run: ${preview}`}>
        <pre className="text-[11px] leading-snug whitespace-pre-wrap break-words">{prompt}</pre>
      </CollapsibleChip>
    </div>
  )
}

function ToolCallChip({ toolName, args }: { toolName: string; args: Record<string, unknown> }) {
  return (
    <CollapsibleChip icon={<Wrench className="h-3 w-3" />} label={`called ${toolName}`}>
      <pre className="text-[11px] leading-snug whitespace-pre-wrap break-words">
        {safeStringify(args)}
      </pre>
    </CollapsibleChip>
  )
}

function ToolResultChip({ toolName, result }: { toolName: string; result: unknown }) {
  const preview = summarizeResult(result)
  return (
    <CollapsibleChip icon={<Wrench className="h-3 w-3" />} label={`${toolName} → ${preview}`}>
      <pre className="text-[11px] leading-snug whitespace-pre-wrap break-words">
        {safeStringify(result)}
      </pre>
    </CollapsibleChip>
  )
}

export type EventDisplayChunk =
  | { kind: 'text'; text: string }
  | { kind: 'events'; entries: AgentLogEntry[] }
  | { kind: 'stderr'; lines: string[] }
  | { kind: 'diagnostic'; lines: string[] }
  | { kind: 'activity'; events: AgentEvent[] }

export function eventDisplayChunks(log: AgentLogEntry[], developerMode: boolean): EventDisplayChunk[] {
  // Render entries in log order (old → new). Consecutive text deltas fold
  // into single paragraphs. Consecutive tool events fold into a single
  // collapsed group so they don't dominate the thread in dev mode.
  const TOOL_EVENT_TYPES = new Set([
    'tool_use', 'tool-call', 'tool_call', 'tool-result', 'tool_result',
  ])

  const chunks: EventDisplayChunk[] = []
  let sawEvent = false
  const hiddenReasoningTextIds = reasoningPartIds(log)

  const appendText = (s: string) => {
    const last = chunks[chunks.length - 1]
    if (last && last.kind === 'text') last.text += s
    else chunks.push({ kind: 'text', text: s })
  }
  const appendStderr = (line: string) => {
    const last = chunks[chunks.length - 1]
    if (last && last.kind === 'stderr') last.lines.push(line)
    else chunks.push({ kind: 'stderr', lines: [line] })
  }
  const appendDiagnostic = (line: string) => {
    const last = chunks[chunks.length - 1]
    if (last && last.kind === 'diagnostic') last.lines.push(line)
    else chunks.push({ kind: 'diagnostic', lines: [line] })
  }
  const appendEvent = (entry: AgentLogEntry) => {
    const last = chunks[chunks.length - 1]
    if (last && last.kind === 'events') last.entries.push(entry)
    else chunks.push({ kind: 'events', entries: [entry] })
  }
  const appendActivity = (event: AgentEvent) => {
    const last = chunks[chunks.length - 1]
    if (last && last.kind === 'activity') last.events.push(event)
    else chunks.push({ kind: 'activity', events: [event] })
  }

  for (const entry of log) {
    if (entry.kind === 'event') {
      sawEvent = true
      if (entry.event.type === 'text') {
        const id = eventPartId(entry.event)
        if (id && hiddenReasoningTextIds.has(id)) continue
        const t = entry.event.part?.text
        if (typeof t === 'string') appendText(t)
      } else if (developerMode) {
        const diagnostic = userVisibleDiagnosticTextForEvent(entry.event)
        if (diagnostic) appendStderr(diagnostic)
        else appendEvent(entry)
      } else if (TOOL_EVENT_TYPES.has(entry.event.type)) {
        // Normal mode: surface a compact "what the agent did" line so
        // tool activity isn't invisible (raw payloads stay dev-only).
        appendActivity(entry.event)
      }
    } else if (entry.kind === 'stderr') {
      if (developerMode) {
        if (isStructuredToolPayloadLine(entry.line) || !isUserVisibleDiagnosticLine(entry.line)) appendDiagnostic(entry.line)
        else appendStderr(entry.line)
      }
    } else if (entry.kind === 'unparsed') {
      if (developerMode && sawEvent) {
        // Once a structured event stream exists, raw stdout is diagnostic log
        // material rather than assistant prose. Keep it in dev mode, but don't
        // style ordinary tool/stdout payloads as errors.
        appendDiagnostic(entry.line)
      } else if (!sawEvent) {
        // Unparsed stdout from drivers that don't emit JSON events (fake
        // driver, plain-text tests) — treat as text-like output.
        appendText(entry.line)
      }
    }
  }

  return chunks
}

function reasoningPartIds(log: AgentLogEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of log) {
    if (entry.kind !== 'event' || entry.event.type !== 'reasoning') continue
    const id = eventPartId(entry.event)
    if (id) ids.add(id)
  }
  return ids
}

function eventPartId(event: AgentEvent): string | undefined {
  const id = event.part?.id
  return typeof id === 'string' ? id : undefined
}

function EventsView({ log, developerMode, workspacePath, workspaceId }: { log: AgentLogEntry[]; developerMode: boolean; workspacePath?: string; workspaceId?: string }) {
  const chunks = eventDisplayChunks(log, developerMode)

  return (
    <div className="space-y-2">
      {chunks.map((c, i) => {
        if (c.kind === 'text') {
          if (!c.text.trim()) return null
          return <MarkdownContent key={i} text={c.text.trim()} workspacePath={workspacePath} workspaceId={workspaceId} />
        }
        if (c.kind === 'events') {
          return <EventGroup key={i} entries={c.entries} workspacePath={workspacePath} />
        }
        if (c.kind === 'activity') {
          return <ActivityList key={i} events={c.events} workspacePath={workspacePath} />
        }
        if (c.kind === 'diagnostic') return <DiagnosticBlock key={i} lines={c.lines} />
        return <StderrBlock key={i} lines={c.lines} />
      })}
    </div>
  )
}

/**
 * Normal-mode "what the agent did" lines. Same shape as the live
 * "Thinking…" status row, but each entry is a completed action, so the
 * spinner is replaced by a muted check. (The live spinner version is
 * still rendered by ChatThread's StatusIndicator while a turn runs.)
 */
function ActivityList({ events, workspacePath }: { events: AgentEvent[]; workspacePath?: string }) {
  const lines: string[] = []
  for (const ev of events) {
    const label = labelForEvent(ev, workspacePath)
    if (label && lines[lines.length - 1] !== label) lines.push(label)
  }
  if (lines.length === 0) return null
  return (
    <div className="space-y-0.5">
      {lines.map((label, i) => (
        <div key={i} className="flex items-center gap-2 py-1">
          <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{label}</span>
        </div>
      ))}
    </div>
  )
}

function EventGroup({ entries, workspacePath }: { entries: AgentLogEntry[]; workspacePath?: string }) {
  const [open, setOpen] = useState(false)
  if (entries.length === 0) return null
  const count = entries.length
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
      >
        <Wrench className="h-2.5 w-2.5" />
        <span>{count} tool event{count === 1 ? '' : 's'}</span>
        <ChevronRight className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {entries.map((entry, i) => entry.kind === 'event' && (
            <CollapsibleChip key={i} icon={<Wrench className="h-3 w-3" />} label={labelForEvent(entry.event, workspacePath)}>
              <pre className="text-[11px] leading-snug whitespace-pre-wrap break-words">
                {translateSandboxPaths(safeStringify(entry.event), workspacePath)}
              </pre>
            </CollapsibleChip>
          ))}
        </div>
      )}
    </div>
  )
}

function StderrBlock({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false)
  const preview = lines[0]?.trim()
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 text-xs">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left text-destructive hover:bg-destructive/10 transition-colors"
      >
        <AlertTriangle className="h-3 w-3" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {preview || `${lines.length} diagnostic/error line${lines.length === 1 ? '' : 's'}`}
        </span>
        <ChevronRight className={`h-3 w-3 ml-auto transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <pre className="px-2.5 pb-2 pt-0 text-[11px] leading-snug whitespace-pre-wrap break-words font-mono">
          {lines.join('\n')}
        </pre>
      )}
    </div>
  )
}

function DiagnosticBlock({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false)
  const preview = lines[0]?.trim()
  return (
    <div className="rounded-md border border-border bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left text-muted-foreground hover:bg-muted/40 transition-colors"
      >
        <Wrench className="h-3 w-3" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {preview || `${lines.length} diagnostic line${lines.length === 1 ? '' : 's'}`}
        </span>
        <ChevronRight className={`h-3 w-3 ml-auto transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <pre className="px-2.5 pb-2 pt-0 text-[11px] leading-snug whitespace-pre-wrap break-words font-mono text-muted-foreground">
          {lines.join('\n')}
        </pre>
      )}
    </div>
  )
}

function CollapsibleChip({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left text-muted-foreground hover:bg-muted/40 transition-colors"
      >
        {icon}
        <span className="truncate">{label}</span>
        <ChevronRight className={`h-3 w-3 ml-auto shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <div className="px-2.5 pb-2 pt-0">{children}</div>}
    </div>
  )
}

function translateSandboxPaths(text: string, workspacePath?: string): string {
  if (!workspacePath) return text
  return text.replaceAll('/home/agent', `~/Roomy/${workspacePath}`)
}

/** Extract the most relevant file path from a tool_use event's input object. */
function pickToolFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const obj = input as Record<string, unknown>
  for (const key of ['filePath', 'file_path', 'path', 'file']) {
    const v = obj[key]
    if (typeof v === 'string' && v.startsWith('/home/agent')) return v
  }
  return undefined
}

function labelForEvent(ev: AgentEvent, workspacePath?: string): string {
  const t = ev.type

  // pi tool_use format: {type:'tool_use', part:{tool:'read', state:{input:{filePath:'...'}}}}
  if (t === 'tool_use') {
    const tool = pickString(ev.part, 'tool') ?? 'tool'
    const state = (ev.part as Record<string, unknown> | undefined)?.state
    const input = (state as Record<string, unknown> | undefined)?.input
    const filePath = pickToolFilePath(input)
    if (filePath && workspacePath) {
      const display = translateSandboxPaths(filePath, workspacePath)
      return `${tool}: ${display}`
    }
    return `called ${tool}`
  }

  if (t === 'tool-call' || t === 'tool_call') {
    const name = pickString(ev.part, 'name') ?? pickString(ev, 'name') ?? 'tool'
    return `called ${name}`
  }
  if (t === 'tool-result' || t === 'tool_result') {
    const name = pickString(ev.part, 'name') ?? pickString(ev, 'name') ?? 'tool'
    return `${name} result`
  }
  if (t === 'reasoning') return 'reasoning'
  if (t === 'finish') return 'finish'
  return t
}

function pickString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

function summarizeResult(result: unknown): string {
  if (result == null) return 'ok'
  if (typeof result === 'string') return result.length > 80 ? result.slice(0, 80) + '…' : result
  if (typeof result === 'number' || typeof result === 'boolean') return String(result)
  return 'result'
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
