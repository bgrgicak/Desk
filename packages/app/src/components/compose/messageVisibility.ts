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
