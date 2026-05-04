import { describe, it, expect } from 'vitest'
import { serverMessageToChatMessage } from './use-server-chat'
import type { ServerMessage } from '@/store/types'

function makeMessage(overrides: Partial<ServerMessage>): ServerMessage {
  return {
    id: 'msg_test',
    chatId: 'cht_test',
    role: 'user',
    content: { type: 'text', text: 'hello' },
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('serverMessageToChatMessage', () => {
  it('returns null for system role messages', () => {
    const msg = makeMessage({ role: 'system', content: { type: 'agent_turn', userMessageId: 'msg_x' } })
    expect(serverMessageToChatMessage(msg)).toBeNull()
  })

  it('returns null for summary kind messages', () => {
    const msg = makeMessage({ role: 'agent', kind: 'summary', content: { type: 'text', text: 'summary' } })
    expect(serverMessageToChatMessage(msg)).toBeNull()
  })

  it('returns null for events messages (agent run logs, not user-visible)', () => {
    const msg = makeMessage({ role: 'agent', content: { type: 'events', log: [] } })
    expect(serverMessageToChatMessage(msg)).toBeNull()
  })

  it('converts a user text message', () => {
    const msg = makeMessage({ role: 'user', content: { type: 'text', text: 'What is the file name?' } })
    const result = serverMessageToChatMessage(msg)
    expect(result).not.toBeNull()
    expect(result!.role).toBe('user')
    expect(result!.content).toBe('What is the file name?')
  })

  it('converts an agent text message and maps role to assistant', () => {
    const msg = makeMessage({ role: 'agent', model: 'claude-sonnet-4-5', content: { type: 'text', text: 'The file is notes.md.' } })
    const result = serverMessageToChatMessage(msg)
    expect(result).not.toBeNull()
    expect(result!.role).toBe('assistant')
    expect(result!.content).toBe('The file is notes.md.')
  })

  it('preserves the message id and timestamp', () => {
    const createdAt = '2026-04-30T10:00:00.000Z'
    const msg = makeMessage({ id: 'msg_abc', createdAt })
    const result = serverMessageToChatMessage(msg)
    expect(result!.id).toBe('msg_abc')
    expect(result!.timestamp).toEqual(new Date(createdAt))
  })
})
