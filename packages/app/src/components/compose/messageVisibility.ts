import type { AgentLogEntry, MessageContent, ServerMessage } from '@/store/types'

const HIDDEN_FROM_STREAM: ReadonlySet<MessageContent['type']> = new Set([
  'agent_turn',
  'summary_request',
])

const TOOL_CONTENT_TYPES: ReadonlySet<MessageContent['type']> = new Set([
  'toolCall',
  'toolResult',
])

function eventsHasUserText(log: AgentLogEntry[]): boolean {
  let sawEvent = false
  for (const entry of log) {
    if (entry.kind === 'event') {
      sawEvent = true
      if (entry.event.type === 'text') {
        const t = entry.event.part?.text
        if (typeof t === 'string' && t.trim().length > 0) return true
      }
    } else if (entry.kind === 'unparsed' && !sawEvent) {
      if (entry.line.trim().length > 0) return true
    }
  }
  return false
}

export function isMessageVisible(m: ServerMessage, developerMode: boolean): boolean {
  if (m.kind === 'task_run' && !developerMode) return false
  if (m.content.type === 'summary') return developerMode
  if (HIDDEN_FROM_STREAM.has(m.content.type)) return false
  if (developerMode) return true
  if (TOOL_CONTENT_TYPES.has(m.content.type)) return false
  if (m.content.type === 'events') return eventsHasUserText(m.content.log)
  return true
}

// ── Copy-to-clipboard helpers ─────────────────────────────────────────────────

/** Extract the user-visible text from an events log (text deltas + unparsed
 *  fallback lines, same logic as EventsView in non-dev mode). */
function extractEventsText(log: AgentLogEntry[]): string {
  const parts: string[] = []
  let sawEvent = false
  for (const entry of log) {
    if (entry.kind === 'event') {
      sawEvent = true
      if (entry.event.type === 'text') {
        const t = entry.event.part?.text
        if (typeof t === 'string') parts.push(t)
      }
    } else if (entry.kind === 'unparsed' && !sawEvent) {
      parts.push(entry.line)
    }
  }
  return parts.join('').trim()
}

/** Extract the plain-text body of a single message, or `null` if it has no
 *  copyable text (e.g. an artifact-ref card). */
function messageToText(m: ServerMessage): string | null {
  switch (m.content.type) {
    case 'text':
      return m.content.text || null
    case 'events': {
      const t = extractEventsText(m.content.log)
      return t || null
    }
    default:
      return null
  }
}

/** Convert a list of messages into clipboard text.
 *
 *  Only messages visible to regular (non-dev) users are included — system
 *  messages, tool calls, summaries, summary requests, and agent_turn
 *  triggers are always excluded regardless of the caller's dev-mode setting.
 */
export function messagesToClipboardText(messages: ServerMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    // Always use developerMode=false so the copy matches the regular user view
    if (!isMessageVisible(m, false)) continue
    const text = messageToText(m)
    if (!text) continue

    const label = m.role === 'user' ? 'You' : 'Agent'
    lines.push(`${label}: ${text}`)
  }
  return lines.join('\n\n')
}
