import type { AgentEvent, AgentLogEntry, MessageContent, ServerMessage } from '@/store/types'

/**
 * Latest agent_turn whose state is still `pending` or `running`, or
 * null if the most recent agent_turn has terminated (succeeded / failed
 * / cancelled / paused) or there is none.
 *
 * This is the chat-view's loader signal — the sidebar reuses it via
 * `selectIsChatRunning` so the two surfaces can't disagree on whether
 * a turn is in flight.
 */
export function findActiveAgentTurn(items: ServerMessage[]): ServerMessage | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]
    if (m.content.type === 'agent_turn') {
      return m.state === 'pending' || m.state === 'running' ? m : null
    }
  }
  return null
}

const HIDDEN_FROM_STREAM: ReadonlySet<MessageContent['type']> = new Set([
  'agent_turn',
  'summary_request',
  'reflection_request',
  // `feedback` rows are user 👍 / 👎 reactions persisted as system
  // messages so reflections can see them. They're plumbing, not chat
  // content — the thumb button's active state is the user-facing
  // signal in the timeline.
  'feedback',
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

export function isUserVisibleDiagnosticLine(line: string): boolean {
  if (isStructuredToolPayloadLine(line)) return false
  return /\b(error|failed|failure|exception|traceback|not found|permission denied|unauthori[sz]ed|forbidden|invalid|cannot|can't)\b/i.test(line)
}

export function isStructuredToolPayloadLine(line: string): boolean {
  const trimmed = line
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\[[0-9;]*m/g, '')
    .trimStart()
  return /^(?:<|&lt;)(path|type|content|skill_content|system-reminder|env|available_skills)\b/i.test(trimmed)
    || /(?:<|&lt;)\/path(?:>|&gt;)\s*(?:<|&lt;)type(?:>|\s|&gt;)/i.test(trimmed)
    || /(?:<|&lt;)skill_content\b/i.test(trimmed)
}

export function firstUserVisibleDiagnosticString(value: unknown): string | null {
  if (typeof value === 'string') return isUserVisibleDiagnosticLine(value) ? value : null
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUserVisibleDiagnosticString(item)
      if (found) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  const preferredKeys = new Set(['message', 'error', 'details', 'detail', 'text', 'reason', 'data'])
  for (const key of preferredKeys) {
    const found = firstUserVisibleDiagnosticString(record[key])
    if (found) return found
  }
  for (const [key, child] of Object.entries(record)) {
    if (preferredKeys.has(key)) continue
    const found = firstUserVisibleDiagnosticString(child)
    if (found) return found
  }
  return null
}

export function userVisibleDiagnosticTextForEvent(event: AgentEvent): string | null {
  if (!isDiagnosticEventType(event.type)) return null
  const direct = firstUserVisibleDiagnosticString(event.part) ?? firstUserVisibleDiagnosticString(event)
  if (direct) return direct
  return isUserVisibleDiagnosticLine(event.type) ? event.type : null
}

function isDiagnosticEventType(type: string): boolean {
  return /\b(error|failed|failure|exception|traceback)\b/i.test(type)
}

function reasoningPartIds(log: AgentLogEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of log) {
    if (entry.kind !== 'event' || entry.event.type !== 'reasoning') continue
    const id = entry.event.part?.id
    if (typeof id === 'string') ids.add(id)
  }
  return ids
}

function eventPartId(event: AgentEvent): string | undefined {
  const id = event.part?.id
  return typeof id === 'string' ? id : undefined
}

function eventsHasUserText(log: AgentLogEntry[]): boolean {
  let sawEvent = false
  const hiddenReasoningTextIds = reasoningPartIds(log)
  for (const entry of log) {
    if (entry.kind === 'event') {
      sawEvent = true
      if (entry.event.type === 'text') {
        const id = eventPartId(entry.event)
        if (id && hiddenReasoningTextIds.has(id)) continue
        const t = entry.event.part?.text
        if (typeof t === 'string' && t.trim().length > 0) return true
      }
    } else if (entry.kind === 'unparsed' && !sawEvent) {
      if (entry.line.trim().length > 0) return true
    }
  }
  return false
}

const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'tool_use',
  'tool-call',
  'tool_call',
  'tool-result',
  'tool_result',
])

/** True when the log contains a real tool action — used to surface a
 *  compact "what the agent did" activity line in normal mode (stderr-
 *  only / reasoning-only logs stay developer-only). */
export function eventsHasToolActivity(log: AgentLogEntry[]): boolean {
  for (const entry of log) {
    if (entry.kind === 'event' && TOOL_EVENT_TYPES.has(entry.event.type)) return true
  }
  return false
}

export function isRegularMessageVisible(m: ServerMessage): boolean {
  if (m.kind === 'task_run') return false
  if (m.content.type === 'summary') return false
  if (HIDDEN_FROM_STREAM.has(m.content.type)) return false
  if (TOOL_CONTENT_TYPES.has(m.content.type)) return false
  if (m.content.type === 'events') {
    return eventsHasUserText(m.content.log) || eventsHasToolActivity(m.content.log)
  }
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
