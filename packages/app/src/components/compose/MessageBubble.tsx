import { memo, useState, type MouseEvent } from 'react'
import { Bot, ChevronRight, FileText, Folder, Wrench, AlertTriangle, Paperclip, ListTodo, Reply, MessagesSquare } from 'lucide-react'
import type { AgentEvent, AgentLogEntry, AttachmentRef, MessageContent, ServerMessage } from '@/store/types'
import { appAttachmentToPreview } from '@/components/context/AppPreview'
import { getRelativeTime } from '@/data/ui-types'
import { humanSize } from '@/store/selectors/library'
import { MarkdownContent } from '@/components/MarkdownContent'
import { InlineArtifactPreview } from '@/components/shared/InlineArtifactPreview'
import { useGetSummaryHistoryQuery } from '@/store/api'
import { diffLines, type DiffSegment } from '@/lib/summary-diff'
import { buildPath, NEW_CHAT_ID } from '@/router/nav'
import { Link } from 'react-router-dom'
import { isRegularMessageVisible, isStructuredToolPayloadLine, isUserVisibleDiagnosticLine, userVisibleDiagnosticTextForEvent } from './messageVisibility'

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
}

export const MessageBubble = memo(function MessageBubble({
  message,
  workspaceId,
  workspacePath,
  isFirstInGroup = true,
  isNew = false,
  agentName,
  onAttachmentClick,
  agentHeaderClassName,
  hideAgentHeader = false,
  developerMode = false,
  currentChatId,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const modelLabel = agentName ?? 'Agent'
  const timestamp = new Date(message.createdAt)
  const hasAttachments = !!message.attachments && message.attachments.length > 0
  const showThread = isRegularMessageVisible(message) && !!workspaceId
    && message.threadChatId !== currentChatId

  if (isUser) {
    if (message.kind === 'task_run' && message.content.type === 'text') {
      return <TaskRunChip prompt={message.content.text} />
    }
    return (
      <div className="group flex w-full min-w-0 max-w-full items-start gap-1.5">
        {showThread && (
          <div className="shrink-0 self-end">
            <ThreadButton message={message} workspaceId={workspaceId!} />
          </div>
        )}
        <div className="flex-1 min-w-0 flex flex-col items-end gap-1.5">
          {hasAttachments && (
            <div className="flex w-full min-w-0 max-w-full flex-col items-end gap-1.5 overflow-hidden">
              {message.attachments!.map(att => (
                <AttachmentCard
                  key={att.path}
                  attachment={att}
                  workspaceId={workspaceId}
                  align="right"
                  onClick={onAttachmentClick ? () => onAttachmentClick(att) : undefined}
                />
              ))}
            </div>
          )}
          {message.content.type === 'text' && message.content.text && (
            <div className="max-w-[80%] min-w-0 break-words bg-secondary text-foreground text-sm leading-relaxed px-3.5 py-2.5 rounded-lg rounded-br-[2px]">
              <MarkdownContent text={message.content.text} workspacePath={workspacePath} workspaceId={workspaceId} />
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`group min-w-0 max-w-full ${isFirstInGroup ? '' : '-mt-4'}`}>
      <div className="flex items-start gap-1.5">
        <div className={`flex-1 min-w-0 ${isFirstInGroup ? 'space-y-1.5' : ''}`}>
          {isFirstInGroup && !hideAgentHeader && (
            <div className={`flex items-center gap-3 ${agentHeaderClassName ?? ''}`}>
              <div className="flex items-center gap-1">
                <Bot className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                <span className="text-xs text-muted-foreground">{modelLabel}</span>
              </div>
              <span className="text-xs text-muted-foreground">{getRelativeTime(timestamp)}</span>
              {isNew && (
                <div className="flex items-center gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                  <span className="text-xs text-blue-500">New</span>
                </div>
              )}
            </div>
          )}
          {hasAttachments && (
            <div className="flex w-full min-w-0 max-w-full flex-col items-start gap-1.5 overflow-hidden">
              {message.attachments!.map(att => (
                <AttachmentCard key={att.path} attachment={att} workspaceId={workspaceId} />
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
        </div>
        {showThread && (
          <div className="shrink-0 self-end">
            <ThreadButton message={message} workspaceId={workspaceId!} />
          </div>
        )}
      </div>
    </div>
  )
})

function ThreadButton({
  message,
  workspaceId,
  className,
}: {
  message: ServerMessage
  workspaceId: string
  className?: string
}) {
  const hasThread = !!message.threadChatId
  const to = hasThread
    ? buildPath(workspaceId, 'tasks', { chat: message.threadChatId! })
    : buildPath(workspaceId, 'tasks', { chat: NEW_CHAT_ID, startThread: `${message.chatId}:${message.id}` })

  return (
    <Link
      to={to}
      state={hasThread ? undefined : { anchorMessage: message }}
      title={hasThread ? 'Open thread' : 'Reply in thread'}
      className={[
        'p-1 rounded transition-colors hover:bg-muted/40',
        hasThread
          ? 'text-muted-foreground/70 hover:text-foreground'
          : 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground/50 hover:text-muted-foreground',
        className ?? '',
      ].join(' ')}
    >
      {hasThread
        ? <MessagesSquare className="h-3.5 w-3.5" />
        : <Reply className="h-3.5 w-3.5" />
      }
    </Link>
  )
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
    <div className="rounded-lg border border-dashed bg-muted/20 p-3">
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

function ArtifactRefRow({ workspaceId, path, name, mime, params, onClick }: { workspaceId?: string; path: string; name?: string; mime?: string | null; params?: Record<string, string>; onClick?: () => void }) {
  const label = name ?? basenamePath(path)
  const Icon = isDirectoryArtifact(mime) ? Folder : FileText
  const className = 'inline-flex max-w-full min-w-0 items-center gap-2 self-start overflow-hidden rounded-md border bg-background px-2.5 py-1.5 text-left text-xs align-top'
  const href = artifactRefHref(workspaceId, path, mime, params)
  const inner = (
    <>
      <Icon className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium sm:flex-none">{label}</span>
      {name && <span className="hidden min-w-0 truncate text-muted-foreground sm:inline">{path}</span>}
    </>
  )
  const fallback = href ? (
    <a
      href={href}
      onClick={e => { if (plainLeftClick(e)) onClick?.() }}
      className={`${className} hover:bg-muted/40 transition-colors`}
      data-testid="artifact-inline-fallback"
    >
      {inner}
    </a>
  ) : !onClick ? <div className={className} data-testid="artifact-inline-fallback">{inner}</div> : (
    <button
      type="button"
      onClick={onClick}
      className={`${className} hover:bg-muted/40 transition-colors`}
      data-testid="artifact-inline-fallback"
    >
      {inner}
    </button>
  )
  if (!workspaceId) return fallback
  return (
    <InlineArtifactPreview
      workspaceId={workspaceId}
      path={path}
      name={label}
      mime={mime}
      params={params}
      onOpen={onClick}
      openHref={href}
      fallback={fallback}
    />
  )
}

function AttachmentCard({
  attachment,
  workspaceId,
  align = 'left',
  onClick,
}: {
  attachment: AttachmentRef
  workspaceId?: string
  align?: AttachmentAlignment
  onClick?: () => void
}) {
  const appPreview = appAttachmentToPreview(attachment.path)
  const className =
    `inline-flex min-w-0 max-w-full items-center gap-2 ${attachmentAlignmentClass(align)} overflow-hidden rounded-lg border bg-background px-3 py-2 text-left text-xs align-top sm:max-w-[320px]`
  const Icon = attachment.kind === 'directory' ? Folder : Paperclip
  // Subtext: byte count when known, falling back to the workspace path.
  // Directories don't carry a useful size, so we keep the path there.
  const subtext =
    attachment.kind !== 'directory' && typeof attachment.size === 'number'
      ? humanSize(attachment.size)
      : attachment.path
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
  if (appPreview && effectiveWorkspaceId) {
    return (
      <div className={`max-w-full ${attachmentAlignmentClass(align)}`}>
        <InlineArtifactPreview
          workspaceId={effectiveWorkspaceId}
          path={attachment.path}
          name={attachment.name}
          mime={attachment.mime}
          params={attachment.params}
          onOpen={onClick}
          openHref={href}
          fallback={href ? (
            <a
              href={href}
              onClick={e => { if (plainLeftClick(e)) onClick?.() }}
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
        onClick={e => { if (plainLeftClick(e)) onClick?.() }}
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

function TaskRunChip({ prompt }: { prompt: string }) {
  const preview = prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt
  return (
    <CollapsibleChip icon={<ListTodo className="h-3 w-3" />} label={`task run: ${preview}`}>
      <pre className="text-[11px] leading-snug whitespace-pre-wrap break-words">{prompt}</pre>
    </CollapsibleChip>
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

export function eventDisplayChunks(log: AgentLogEntry[], developerMode: boolean): EventDisplayChunk[] {
  // Render entries in log order (old → new). Consecutive text deltas fold
  // into single paragraphs. Consecutive tool events fold into a single
  // collapsed group so they don't dominate the thread in dev mode.
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

  for (const entry of log) {
    if (entry.kind === 'event') {
      sawEvent = true
      if (entry.event.type === 'text') {
        const id = eventPartId(entry.event)
        if (id && hiddenReasoningTextIds.has(id)) continue
        const t = entry.event.part?.text
        if (typeof t === 'string') appendText(t)
      } else {
        const diagnostic = userVisibleDiagnosticTextForEvent(entry.event)
        if (diagnostic && developerMode) appendStderr(diagnostic)
        else if (developerMode) appendEvent(entry)
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
        if (c.kind === 'diagnostic') return <DiagnosticBlock key={i} lines={c.lines} />
        return <StderrBlock key={i} lines={c.lines} />
      })}
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
  return text.replaceAll('/home/agent', `~/Desk/${workspacePath}`)
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

  // opencode tool_use format: {type:'tool_use', part:{tool:'read', state:{input:{filePath:'...'}}}}
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
