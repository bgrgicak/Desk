import { describe, expect, it } from 'vitest'
import { isMessageVisible } from './ChatThread'
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
  it('shows note messages only in developer mode', () => {
    const note = message({ type: 'note', body: '# Chat Summary' })

    expect(isMessageVisible(note, false)).toBe(false)
    expect(isMessageVisible(note, true)).toBe(true)
  })

  it('keeps ai note requests hidden even in developer mode', () => {
    const request = message({ type: 'ai_note_request' }, { role: 'system' })

    expect(isMessageVisible(request, false)).toBe(false)
    expect(isMessageVisible(request, true)).toBe(false)
  })
})
