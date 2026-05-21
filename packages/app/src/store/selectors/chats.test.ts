import { describe, expect, it } from 'vitest'
import { GOAL_KEYS } from '@agent-desk/shared'
import { narrowChatGoal, toUiChat } from './chats'
import type { ServerChat } from '../types'

describe('narrowChatGoal', () => {
  it('returns null for undefined / empty', () => {
    expect(narrowChatGoal(undefined)).toBeNull()
    expect(narrowChatGoal('')).toBeNull()
  })

  it('passes through every value in GOAL_KEYS unchanged', () => {
    // Pins the contract: anything the shared enum advertises is a
    // valid UI kind.  If GOAL_KEYS ever grows, this test pulls it
    // through the helper without an explicit list to maintain.
    for (const key of GOAL_KEYS) {
      expect(narrowChatGoal(key)).toBe(key)
    }
  })

  it('returns null for any unknown string (the server is looser than the UI)', () => {
    expect(narrowChatGoal('not-a-real-goal')).toBeNull()
    expect(narrowChatGoal('DATA')).toBeNull() // case-sensitive
    expect(narrowChatGoal('image ')).toBeNull() // trailing space
  })
})

describe('toUiChat', () => {
  const baseServerChat: ServerChat = {
    id: 'cht_test',
    workspaceId: 'wks_test',
    agentId: 'agt_test',
    title: 'Test chat',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-02-02T00:00:00.000Z',
    
    unread: true,
  }

  it('parses createdAt / updatedAt strings into Date instances', () => {
    const ui = toUiChat(baseServerChat)
    expect(ui.createdAt).toBeInstanceOf(Date)
    expect(ui.updatedAt).toBeInstanceOf(Date)
    expect(ui.createdAt.toISOString()).toBe('2025-01-01T00:00:00.000Z')
    expect(ui.updatedAt.toISOString()).toBe('2025-02-02T00:00:00.000Z')
  })

  it('threads lastMessage through, falling back to "" when omitted', () => {
    expect(toUiChat({ ...baseServerChat, lastMessage: 'hello world' }).lastMessage)
      .toBe('hello world')
    expect(toUiChat(baseServerChat).lastMessage).toBe('')
  })

  it('passes the chat-list meta fields through', () => {
    const ui = toUiChat({
      ...baseServerChat,
      kind: 'task',
      running: true,
      failed: false,
      lastMessage: 'preview',
    })
    expect(ui.kind).toBe('task')
    expect(ui.running).toBe(true)
    expect(ui.failed).toBe(false)
    expect(ui.lastMessage).toBe('preview')
  })

  it('narrows a known goal and drops an unknown one to null', () => {
    expect(toUiChat({ ...baseServerChat, goal: 'data' }).goal).toBe('data')
    expect(toUiChat({ ...baseServerChat, goal: 'not-real' }).goal).toBeNull()
    expect(toUiChat({ ...baseServerChat, goal: undefined }).goal).toBeNull()
  })

  it('leaves artifactIds and messages empty (populated by other slices)', () => {
    const ui = toUiChat(baseServerChat)
    expect(ui.artifactIds).toEqual([])
    expect(ui.messages).toEqual([])
  })
})
