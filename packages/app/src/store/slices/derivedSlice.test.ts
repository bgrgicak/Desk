import { describe, it, expect } from 'vitest'
import reducer, {
  bumpFileChangeCounter,
  selectFileChangeCounter,
  markChatRunning,
  markChatIdle,
  selectRunningChatIds,
} from './derivedSlice'
import { api } from '../api'

describe('bumpFileChangeCounter', () => {
  it('starts at 0 for an unknown path', () => {
    const state = reducer(undefined, { type: '@@INIT' })
    expect(selectFileChangeCounter({ derived: state } as never, 'some/path.md')).toBe(0)
  })

  it('increments counter for the given path', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, bumpFileChangeCounter('notes/foo.md'))
    expect(selectFileChangeCounter({ derived: state } as never, 'notes/foo.md')).toBe(1)
  })

  it('increments again on subsequent bumps', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, bumpFileChangeCounter('notes/foo.md'))
    state = reducer(state, bumpFileChangeCounter('notes/foo.md'))
    expect(selectFileChangeCounter({ derived: state } as never, 'notes/foo.md')).toBe(2)
  })

  it('keeps counters isolated per path', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, bumpFileChangeCounter('a.md'))
    state = reducer(state, bumpFileChangeCounter('a.md'))
    state = reducer(state, bumpFileChangeCounter('b.md'))
    expect(selectFileChangeCounter({ derived: state } as never, 'a.md')).toBe(2)
    expect(selectFileChangeCounter({ derived: state } as never, 'b.md')).toBe(1)
  })
})

describe('running chat tracking', () => {
  const root = (s: ReturnType<typeof reducer>) => ({ derived: s }) as never

  it('starts with no running chats', () => {
    const state = reducer(undefined, { type: '@@INIT' })
    expect(selectRunningChatIds(root(state))).toEqual([])
  })

  it('marks a chat as running', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
  })

  it('does not duplicate a chat already marked running', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    state = reducer(state, markChatRunning('chat-1'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
  })

  it('tracks multiple running chats', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    state = reducer(state, markChatRunning('chat-2'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1', 'chat-2'])
  })

  it('removes a chat when marked idle', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    state = reducer(state, markChatRunning('chat-2'))
    state = reducer(state, markChatIdle('chat-1'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-2'])
  })

  it('is a no-op to mark an already-idle chat idle', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    state = reducer(state, markChatIdle('chat-2'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
  })
})

describe('cold-start hydration via getChatMessages', () => {
  const root = (s: ReturnType<typeof reducer>) => ({ derived: s }) as never

  /** Build a fake fulfilled action that matches api.endpoints.getChatMessages.matchFulfilled */
  function makeFulfilledAction(chatId: string, items: Array<{ content?: { type: string }; state?: string }>) {
    return {
      type: `${api.reducerPath}/executeQuery/fulfilled`,
      payload: { items },
      meta: {
        arg: {
          type: 'query' as const,
          endpointName: 'getChatMessages',
          originalArgs: { chatId },
          queryCacheKey: `getChatMessages({"chatId":"${chatId}"})`,
        },
        requestId: 'test-req-id',
        requestStatus: 'fulfilled' as const,
        fulfilledTimeStamp: Date.now(),
      },
    }
  }

  it('marks a chat running when fetched messages contain a running agent_turn', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, makeFulfilledAction('chat-1', [
      { content: { type: 'text' }, state: 'succeeded' },
      { content: { type: 'agent_turn' }, state: 'running' },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
  })

  it('marks a chat running when fetched messages contain a pending agent_turn', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, makeFulfilledAction('chat-1', [
      { content: { type: 'agent_turn' }, state: 'pending' },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
  })

  it('does not mark a chat running when all agent_turns are terminal', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, makeFulfilledAction('chat-1', [
      { content: { type: 'agent_turn' }, state: 'succeeded' },
      { content: { type: 'agent_turn' }, state: 'failed' },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual([])
  })

  it('clears running state when a refetch shows no active agent_turns', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
    // Simulate a refetch where all turns have completed
    state = reducer(state, makeFulfilledAction('chat-1', [
      { content: { type: 'agent_turn' }, state: 'succeeded' },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual([])
  })
})
