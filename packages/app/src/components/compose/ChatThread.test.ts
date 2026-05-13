import { describe, expect, it } from 'vitest'
import { isDeveloperOnlyMessageVisible, isMessageVisible, isRegularMessageVisible } from './messageVisibility'
import { currentChatMessagesData, findActiveAgentTurn, findFailedAgentTurn, liveDeveloperProgressMessage, progressTextFromLog, shouldShowNewAssistantBadge, shouldShowToolOnlyRunFallback } from './ChatThread'
import type { ListMessagesResponse, ServerMessage } from '@/store/types'

function message(content: ServerMessage['content'], overrides: Partial<ServerMessage> = {}): ServerMessage {
  return {
    id: 'msg_test',
    chatId: 'cht_test',
    role: 'agent',
    content,
    createdAt: '2026-05-04T10:00:00.000Z',
    ...overrides,
  }
}

describe('isMessageVisible', () => {
  const representativeMessages: ServerMessage[] = [
    message({ type: 'text', text: 'Hello' }, { role: 'user', id: 'text' }),
    message({ type: 'artifactRef', path: 'artifact.md' }, { id: 'artifact' }),
    message({ type: 'events', log: [{ kind: 'event', event: { type: 'text', part: { text: 'Visible reply' } } }] }, { id: 'events-text' }),
  ]

  it('keeps developer mode as a superset of regular chat-visible messages', () => {
    for (const msg of representativeMessages) {
      expect(isRegularMessageVisible(msg)).toBe(true)
      expect(isMessageVisible(msg, false)).toBe(true)
      expect(isMessageVisible(msg, true)).toBe(true)
    }
  })

  it('keeps developer mode visible for every regular-visible message by construction', () => {
    const allContentKinds: ServerMessage[] = [
      message({ type: 'text', text: 'Hello' }, { role: 'user', id: 'text' }),
      message({ type: 'artifactRef', path: 'artifact.md' }, { id: 'artifact' }),
      message({ type: 'events', log: [{ kind: 'event', event: { type: 'text', part: { text: 'Visible reply' } } }] }, { id: 'events-text' }),
      message({ type: 'toolCall', toolName: 'file.read', args: { path: 'x' } }, { id: 'tool-call' }),
      message({ type: 'toolResult', toolName: 'file.read', result: 'ok' }, { id: 'tool-result' }),
      message({ type: 'events', log: [{ kind: 'stderr', line: 'boom' }] }, { id: 'events-stderr' }),
      message({ type: 'summary', body: '# Chat Summary' }, { id: 'summary' }),
      message({ type: 'summary_request' }, { role: 'system', id: 'summary-request' }),
      message({ type: 'reflection_request', workspaceId: 'wks_test' }, { role: 'system', id: 'reflection-request' }),
      message({ type: 'agent_turn', userMessageId: 'user-1' }, { role: 'system', id: 'agent-turn' }),
    ]

    for (const msg of allContentKinds) {
      if (isRegularMessageVisible(msg)) {
        expect(isMessageVisible(msg, true), msg.id).toBe(true)
        expect(isDeveloperOnlyMessageVisible(msg), msg.id).toBe(false)
      }
    }
  })

  it('shows summary messages only in developer mode', () => {
    const summary = message({ type: 'summary', body: '# Chat Summary' })

    expect(isMessageVisible(summary, false)).toBe(false)
    expect(isMessageVisible(summary, true)).toBe(true)
  })

  it('shows tool rows and stderr-only event rows only in developer mode', () => {
    const toolCall = message({ type: 'toolCall', toolName: 'file.read', args: { path: 'x' } })
    const toolResult = message({ type: 'toolResult', toolName: 'file.read', result: 'ok' })
    const stderrEvents = message({ type: 'events', log: [{ kind: 'stderr', line: 'boom' }] })

    for (const msg of [toolCall, toolResult, stderrEvents]) {
      expect(isMessageVisible(msg, false)).toBe(false)
      expect(isMessageVisible(msg, true)).toBe(true)
      expect(isDeveloperOnlyMessageVisible(msg)).toBe(true)
    }
  })

  it('shows task-run prompts only in developer mode', () => {
    const taskRun = message(
      { type: 'text', text: 'Run the task now' },
      { role: 'user', id: 'task-run', kind: 'task_run' },
    )

    expect(isMessageVisible(taskRun, false)).toBe(false)
    expect(isMessageVisible(taskRun, true)).toBe(true)
    expect(isDeveloperOnlyMessageVisible(taskRun)).toBe(true)
  })

  it('keeps summary requests hidden even in developer mode', () => {
    const request = message({ type: 'summary_request' }, { role: 'system' })

    expect(isMessageVisible(request, false)).toBe(false)
    expect(isMessageVisible(request, true)).toBe(false)
  })

  it('keeps reflection requests hidden even in developer mode', () => {
    const request = message({ type: 'reflection_request', workspaceId: 'wks_test' }, { role: 'system' })

    expect(isMessageVisible(request, false)).toBe(false)
    expect(isMessageVisible(request, true)).toBe(false)
  })
})

describe('currentChatMessagesData', () => {
  const compact: ListMessagesResponse = {
    items: [message({ type: 'toolResult', toolName: 'read', result: null }, { id: 'compact-tool' })],
  }
  const full: ListMessagesResponse = {
    items: [message({ type: 'summary', body: 'Full summary' }, { id: 'full-summary' })],
  }

  it('does not render a previous regular/timeline payload as developer-mode data while full is loading', () => {
    expect(currentChatMessagesData('cht_test:full', 'cht_test:timeline', undefined, compact)).toBeUndefined()
  })

  it('keeps cached data for same-view refetches and prefers current data when available', () => {
    expect(currentChatMessagesData('cht_test:timeline', 'cht_test:timeline', undefined, compact)).toBe(compact)
    expect(currentChatMessagesData('cht_test:full', 'cht_test:timeline', full, compact)).toBe(full)
  })
})

describe('findFailedAgentTurn', () => {
  it('returns the failed agent_turn when the most recent one has state=failed', () => {
    const items = [
      message({ type: 'text', text: 'Hello' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'failed' }),
    ]
    const result = findFailedAgentTurn(items)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('2')
    expect(result!.state).toBe('failed')
  })

  it('returns null when the most recent agent_turn succeeded', () => {
    const items = [
      message({ type: 'text', text: 'Hello' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'succeeded' }),
    ]
    expect(findFailedAgentTurn(items)).toBeNull()
  })

  it('returns null when the most recent agent_turn is pending', () => {
    const items = [
      message({ type: 'text', text: 'Hello' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'pending' }),
    ]
    expect(findFailedAgentTurn(items)).toBeNull()
  })

  it('returns null when the most recent agent_turn is running', () => {
    const items = [
      message({ type: 'text', text: 'Hello' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'running' }),
    ]
    expect(findFailedAgentTurn(items)).toBeNull()
  })

  it('returns null when there are no agent_turn messages', () => {
    const items = [
      message({ type: 'text', text: 'Hello' }, { role: 'user', id: '1' }),
      message({ type: 'text', text: 'Reply' }, { role: 'agent', id: '2' }),
    ]
    expect(findFailedAgentTurn(items)).toBeNull()
  })

  it('returns null for empty message list', () => {
    expect(findFailedAgentTurn([])).toBeNull()
  })

  it('only considers the most recent agent_turn, not older ones', () => {
    const items = [
      message({ type: 'text', text: 'Hello' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'failed' }),
      message({ type: 'text', text: 'Try again' }, { role: 'user', id: '3' }),
      message({ type: 'agent_turn', userMessageId: '3' }, { role: 'system', id: '4', state: 'succeeded' }),
    ]
    // The most recent agent_turn succeeded, so no banner should show
    expect(findFailedAgentTurn(items)).toBeNull()
  })

  it('ignores non-agent_turn messages after the failed turn', () => {
    const items = [
      message({ type: 'text', text: 'Hello' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'failed' }),
      message({ type: 'events', log: [{ kind: 'stderr', line: 'error details' }] }, { role: 'agent', id: '3' }),
    ]
    // The events message is a child of the agent_turn but isn't an agent_turn itself,
    // so findFailedAgentTurn should still find the failed agent_turn
    const result = findFailedAgentTurn(items)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('2')
  })
})

describe('findActiveAgentTurn', () => {
  it('returns the active agent_turn when the most recent one is running', () => {
    const items = [
      message({ type: 'text', text: 'Hello' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'running' }),
    ]

    expect(findActiveAgentTurn(items)?.id).toBe('2')
  })

  it('only considers the most recent agent_turn, not older stuck ones', () => {
    const items = [
      message({ type: 'text', text: 'Old request' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'running' }),
      message({ type: 'text', text: 'New request' }, { role: 'user', id: '3' }),
      message({ type: 'agent_turn', userMessageId: '3' }, { role: 'system', id: '4', state: 'succeeded' }),
    ]

    expect(findActiveAgentTurn(items)).toBeNull()
  })
})

describe('shouldShowNewAssistantBadge', () => {
  it('shows the regular assistant new badge when the latest visible assistant message is unread', () => {
    const assistantMessage = message({ type: 'text', text: 'Done' }, { id: 'agent-1' })

    expect(shouldShowNewAssistantBadge(assistantMessage, 'agent-1', true, null)).toBe(true)
  })

  it('suppresses the regular blue new badge when the unread state is a failed run', () => {
    const assistantMessage = message({ type: 'text', text: 'Working on it' }, { id: 'agent-1' })
    const failedTurn = message(
      { type: 'agent_turn', userMessageId: 'user-1' },
      { role: 'system', id: 'turn-1', state: 'failed' },
    )

    expect(shouldShowNewAssistantBadge(assistantMessage, 'agent-1', true, failedTurn)).toBe(false)
  })
})

describe('progressTextFromLog', () => {
  it('surfaces the latest reasoning text without changing tool-row rendering', () => {
    expect(progressTextFromLog([
      { kind: 'event', event: { type: 'tool_use', part: { tool: 'read' } } },
      { kind: 'event', event: { type: 'reasoning', part: { text: 'Checking where the loader is rendered.' } } },
    ])).toBe('Checking where the loader is rendered.')
  })

  it('falls back to tool progress labels when no reasoning text is present', () => {
    expect(progressTextFromLog([
      { kind: 'event', event: { type: 'tool_use', part: { tool: 'bash' } } },
    ])).toBe('Running')
  })

  it('surfaces generic OpenCode tool events by tool name', () => {
    expect(progressTextFromLog([
      { kind: 'event', event: { type: 'tool', part: { name: 'read' } } },
    ])).toBe('Reading')
  })

  it('prefers nested MCP browser tool labels when available', () => {
    expect(progressTextFromLog([
      { kind: 'event', event: { type: 'tool_use', part: { tool: 'mcp', args: { tool: 'playwright_browser_navigate' } } } },
    ])).toBe('Navigating')
  })

  it('prefers top-level nested MCP browser tool labels when available', () => {
    expect(progressTextFromLog([
      { kind: 'event', event: { type: 'tool_use', part: { tool: 'mcp' }, args: { tool: 'playwright_browser_evaluate' } } },
    ])).toBe('Inspecting')
  })

  it('uses generic tool activity labels when no specific tool name is available', () => {
    expect(progressTextFromLog([
      { kind: 'event', event: { type: 'tool_execution_update' } },
    ])).toBe('Taking a break')
  })

  it('ignores runtime step events when choosing live progress text', () => {
    expect(progressTextFromLog([
      { kind: 'event', event: { type: 'tool_use', part: { tool: 'read' } } },
      { kind: 'event', event: { type: 'step_finish' } },
    ])).toBe('Reading')
  })

  it('falls back to Thinking through the status indicator when no mapped progress text exists', () => {
    expect(progressTextFromLog([
      { kind: 'event', event: { type: 'unknown_runtime_event' } },
    ])).toBeNull()
  })

  it('maps stderr to its curated loader label without surfacing raw shell output', () => {
    expect(progressTextFromLog([
      { kind: 'stderr', line: 'sh: 1: echo: echo: I/O error' },
    ])).toBe('Making mistakes')
  })

  it('maps unparsed runtime lines to its curated loader label without surfacing raw output', () => {
    expect(progressTextFromLog([
      { kind: 'unparsed', line: 'raw runtime output' },
    ])).toBe('Wondering')
  })

  it('does not invent labels for unmapped tool names', () => {
    expect(progressTextFromLog([
      { kind: 'event', event: { type: 'tool_call', part: { name: 'unknown_tool' } } },
    ])).toBeNull()
  })
})

describe('liveDeveloperProgressMessage', () => {
  const activeTurn = message(
    { type: 'agent_turn', userMessageId: 'user-1' },
    {
      role: 'system',
      id: 'turn-1',
      state: 'running',
      progressLog: [
        { kind: 'event', event: { type: 'text', part: { text: 'Draft answer' } } },
        { kind: 'event', event: { type: 'tool_use', part: { tool: 'read' } } },
        { kind: 'event', event: { type: 'step_finish' } },
        { kind: 'stderr', line: 'diagnostic line' },
      ],
    },
  )

  it('builds a temporary events message from the active turn in developer mode', () => {
    const liveMessage = liveDeveloperProgressMessage(activeTurn, true)

    expect(liveMessage?.role).toBe('agent')
    expect(liveMessage?.content).toEqual({
      type: 'events',
      log: [
        { kind: 'event', event: { type: 'tool_use', part: { tool: 'read' } } },
        { kind: 'stderr', line: 'diagnostic line' },
      ],
    })
  })

  it('does not surface live tool rows outside developer mode', () => {
    expect(liveDeveloperProgressMessage(activeTurn, false)).toBeNull()
  })
})

describe('shouldShowToolOnlyRunFallback', () => {
  it('shows a fallback when the latest successful turn has only hidden tool output', () => {
    const items = [
      message({ type: 'text', text: 'Please do it' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'succeeded' }),
      message({ type: 'toolCall', toolName: 'file.read', args: { path: 'x' } }, { role: 'agent', id: '3' }),
      message({ type: 'toolResult', toolName: 'file.read', result: 'ok' }, { role: 'agent', id: '4' }),
    ]

    expect(shouldShowToolOnlyRunFallback(items, false)).toBe(true)
  })

  it('does not show a fallback when the run produced visible assistant text', () => {
    const items = [
      message({ type: 'text', text: 'Please do it' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'succeeded' }),
      message({ type: 'text', text: 'Done.' }, { role: 'agent', id: '3' }),
    ]

    expect(shouldShowToolOnlyRunFallback(items, false)).toBe(false)
  })

  it('does not show a fallback in developer mode because tool output is visible', () => {
    const items = [
      message({ type: 'text', text: 'Please do it' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'succeeded' }),
      message({ type: 'toolCall', toolName: 'file.read', args: { path: 'x' } }, { role: 'agent', id: '3' }),
    ]

    expect(shouldShowToolOnlyRunFallback(items, true)).toBe(false)
  })

  it('waits for hidden tool output before showing the fallback', () => {
    const items = [
      message({ type: 'text', text: 'Please do it' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'succeeded' }),
    ]

    expect(shouldShowToolOnlyRunFallback(items, false)).toBe(false)
  })

  it('does not show a stale fallback after a later visible message', () => {
    const items = [
      message({ type: 'text', text: 'Please do it' }, { role: 'user', id: '1' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '2', state: 'succeeded' }),
      message({ type: 'toolCall', toolName: 'file.read', args: { path: 'x' } }, { role: 'agent', id: '3' }),
      message({ type: 'text', text: 'One more thing' }, { role: 'user', id: '4' }),
    ]

    expect(shouldShowToolOnlyRunFallback(items, false)).toBe(false)
  })
})
