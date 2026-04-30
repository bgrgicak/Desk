import { useState } from 'react'
import { Bot, ChevronRight, FileText, Folder, Wrench, AlertTriangle, Paperclip, ListTodo } from 'lucide-react'
import type { AgentEvent, AgentLogEntry, AttachmentRef, MessageContent, ServerMessage } from '@/store/types'
import { getRelativeTime } from '@/data/ui-types'
import { MarkdownContent } from '@/components/MarkdownContent'

interface MessageBubbleProps {
  message: ServerMessage
  isFirstInGroup?: boolean
  isNew?: boolean
  /** Agent name to display in the message header. */
  agentName?: string
  /** Fires when the user clicks an attachment chip — caller opens it. */
  onAttachmentClick?: (attachment: AttachmentRef) => void
  /** When false, internal tool-call/stderr entries inside `events` content
   *  are stripped — only the agent's text reply surfaces. ChatView already
   *  filters out fully-tool `events` rows at the list level. */
  developerMode?: boolean
}

export function MessageBubble({
  message,
  isFirstInGroup = true,
  isNew = false,
  agentName,
  onAttachmentClick,
  developerMode = true,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const modelLabel = agentName ?? 'Agent'
  const timestamp = new Date(message.createdAt)
  const hasAttachments = !!message.attachments && message.attachments.length > 0

  if (isUser) {
    if (message.kind === 'task_run' && message.content.type === 'text') {
      return <TaskRunChip prompt={message.content.text} />
    }
    return (
      <div className="flex flex-col items-end gap-1.5">
        {hasAttachments && (
          <div className="flex flex-col gap-1.5">
            {message.attachments!.map(att => (
              <AttachmentCard
                key={att.path}
                attachment={att}
                onClick={onAttachmentClick ? () => onAttachmentClick(att) : undefined}
              />
            ))}
          </div>
        )}
        {message.content.type === 'text' && message.content.text && (
          <div className="max-w-[80%] bg-secondary text-foreground text-sm leading-relaxed px-3.5 py-2.5 rounded-lg rounded-br-[2px] whitespace-pre-wrap">
            {message.content.text}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={isFirstInGroup ? 'space-y-1.5' : '-mt-4'}>
      {isFirstInGroup && (
        <div className="flex items-center gap-3">
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
        <div className="flex flex-col gap-1.5">
          {message.attachments!.map(att => (
            <AttachmentCard key={att.path} attachment={att} />
          ))}
        </div>
      )}
      <MessageContentView content={message.content} developerMode={developerMode} />
    </div>
  )
}

function MessageContentView({ content, developerMode }: { content: MessageContent; developerMode: boolean }) {
  switch (content.type) {
    case 'text':
      return <MarkdownContent text={content.text} />
    case 'artifactRef':
      return <ArtifactRefRow path={content.path} name={content.name} />
    case 'events':
      return <EventsView log={content.log} developerMode={developerMode} />
    case 'toolCall':
      // Filtered upstream when developerMode is false; defensive guard here.
      if (!developerMode) return null
      return <ToolCallChip toolName={content.toolName} args={content.args} />
    case 'toolResult':
      if (!developerMode) return null
      return <ToolResultChip toolName={content.toolName} result={content.result} />
    case 'note':
    case 'ai_note_request':
    case 'agent_turn':
      // Filtered out of the bubble stream upstream — notes surface in the
      // Artifacts panel; ai_note_request / agent_turn drive the typing
      // indicator. Render nothing if a stray row reaches this layer.
      return null
  }
}

function ArtifactRefRow({ path, name }: { path: string; name?: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs">
      <FileText className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
      <span className="truncate font-medium">{name ?? path}</span>
      {name && <span className="text-muted-foreground truncate">{path}</span>}
    </div>
  )
}

function AttachmentCard({
  attachment,
  onClick,
}: {
  attachment: AttachmentRef
  onClick?: () => void
}) {
  const className =
    'inline-flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs max-w-[320px] text-left'
  const Icon = attachment.kind === 'directory' ? Folder : Paperclip
  const inner = (
    <>
      <Icon className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{attachment.name}</p>
        <p className="text-[11px] text-muted-foreground truncate">{attachment.path}</p>
      </div>
    </>
  )
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

function EventsView({ log, developerMode }: { log: AgentLogEntry[]; developerMode: boolean }) {
  // Render entries in log order (old → new). Consecutive text deltas fold
  // into single paragraphs. Consecutive tool events fold into a single
  // collapsed group so they don't dominate the thread in dev mode.
  type Chunk =
    | { kind: 'text'; text: string }
    | { kind: 'events'; entries: AgentLogEntry[] }
    | { kind: 'stderr'; lines: string[] }

  const chunks: Chunk[] = []
  let sawEvent = false

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
  const appendEvent = (entry: AgentLogEntry) => {
    const last = chunks[chunks.length - 1]
    if (last && last.kind === 'events') last.entries.push(entry)
    else chunks.push({ kind: 'events', entries: [entry] })
  }

  for (const entry of log) {
    if (entry.kind === 'event') {
      sawEvent = true
      if (entry.event.type === 'text') {
        const t = entry.event.part?.text
        if (typeof t === 'string') appendText(t)
      } else if (developerMode) {
        appendEvent(entry)
      }
    } else if (entry.kind === 'stderr') {
      if (developerMode) appendStderr(entry.line)
    } else if (!sawEvent) {
      // Unparsed stdout from drivers that don't emit JSON events (fake
      // driver, plain-text tests) — treat as text-like output.
      appendText(entry.line)
    }
  }

  return (
    <div className="space-y-2">
      {chunks.map((c, i) => {
        if (c.kind === 'text') {
          if (!c.text.trim()) return null
          return <MarkdownContent key={i} text={c.text.trim()} />
        }
        if (c.kind === 'events') {
          return <EventGroup key={i} entries={c.entries} />
        }
        return <StderrBlock key={i} lines={c.lines} />
      })}
    </div>
  )
}

function EventGroup({ entries }: { entries: AgentLogEntry[] }) {
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
            <CollapsibleChip key={i} icon={<Wrench className="h-3 w-3" />} label={labelForEvent(entry.event)}>
              <pre className="text-[11px] leading-snug whitespace-pre-wrap break-words">
                {safeStringify(entry.event)}
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
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 text-xs">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left text-destructive hover:bg-destructive/10 transition-colors"
      >
        <AlertTriangle className="h-3 w-3" />
        <span className="font-medium">{lines.length} stderr line{lines.length === 1 ? '' : 's'}</span>
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

function labelForEvent(ev: AgentEvent): string {
  const t = ev.type
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
