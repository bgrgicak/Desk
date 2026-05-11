import type { AgentLogEntry, MessageContent, ServerMessage } from '@/store/types'

const HIDDEN_FROM_STREAM: ReadonlySet<MessageContent['type']> = new Set([
  'agent_turn',
  'summary_request',
  'reflection_request',
])

const TOOL_CONTENT_TYPES: ReadonlySet<MessageContent['type']> = new Set([
  'toolCall',
  'toolResult',
])

const DEVELOPER_ONLY_CONTENT_TYPES: ReadonlySet<MessageContent['type']> = new Set([
  'summary',
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

export function isRegularMessageVisible(m: ServerMessage): boolean {
  if (m.kind === 'task_run') return false
  if (m.content.type === 'summary') return false
  if (HIDDEN_FROM_STREAM.has(m.content.type)) return false
  if (TOOL_CONTENT_TYPES.has(m.content.type)) return false
  if (m.content.type === 'events') return eventsHasUserText(m.content.log)
  return true
}

export function isDeveloperOnlyMessageVisible(m: ServerMessage): boolean {
  if (HIDDEN_FROM_STREAM.has(m.content.type)) return false
  if (m.kind === 'task_run') return true
  if (DEVELOPER_ONLY_CONTENT_TYPES.has(m.content.type)) return true
  if (m.content.type === 'events') return !eventsHasUserText(m.content.log)
  return false
}

export function isMessageVisible(m: ServerMessage, developerMode: boolean): boolean {
  if (isRegularMessageVisible(m)) return true
  return developerMode && isDeveloperOnlyMessageVisible(m)
}
