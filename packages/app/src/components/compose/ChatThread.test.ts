import { describe, expect, it } from 'vitest'
import { isMessageVisible } from './messageVisibility'
import { currentChatMessagesData, findFailedAgentTurn, shouldShowToolOnlyRunFallback } from './ChatThread'
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
      expect(isMessageVisible(msg, false)).toBe(true)
      expect(isMessageVisible(msg, true)).toBe(true)
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
    }
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
