import { describe, expect, it } from 'vitest'
import { isMessageVisible } from './messageVisibility'
import { findFailedAgentTurn } from './ChatThread'
import type { ServerMessage } from '@/store/types'

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
  it('shows summary messages only in developer mode', () => {
    const summary = message({ type: 'summary', body: '# Chat Summary' })

    expect(isMessageVisible(summary, false)).toBe(false)
    expect(isMessageVisible(summary, true)).toBe(true)
  })

  it('keeps summary requests hidden even in developer mode', () => {
    const request = message({ type: 'summary_request' }, { role: 'system' })

    expect(isMessageVisible(request, false)).toBe(false)
    expect(isMessageVisible(request, true)).toBe(false)
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
