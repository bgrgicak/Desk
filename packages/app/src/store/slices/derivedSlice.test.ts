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

describe('cold-start hydration via getChats', () => {
  const root = (s: ReturnType<typeof reducer>) => ({ derived: s }) as never

  /** Build a fake fulfilled action that matches api.endpoints.getChats.matchFulfilled */
  function makeChatsFulfilledAction(chats: Array<{ id: string; running?: boolean }>) {
    const action = {
      type: `${api.reducerPath}/executeQuery/fulfilled`,
      payload: chats,
      meta: {
        arg: {
          type: 'query' as const,
          endpointName: 'getChats',
          originalArgs: { workspaceId: 'ws-1' },
          queryCacheKey: 'getChats({"workspaceId":"ws-1"})',
        },
        requestId: 'test-req-id',
        requestStatus: 'fulfilled' as const,
        fulfilledTimeStamp: Date.now(),
      },
    }
    // Verify the action shape matches the RTK Query matcher
    expect(api.endpoints.getChats.matchFulfilled(action)).toBe(true)
    return action
  }

  it('hydrates running chat IDs from server response', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1', running: true },
      { id: 'chat-2', running: false },
      { id: 'chat-3', running: true },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1', 'chat-3'])
  })

  it('clears stale running IDs not in server response', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-stale'))
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1', running: true },
      { id: 'chat-2', running: false },
    ]))
    // chat-stale was not in the server response at all, so it should be removed
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
  })

  it('does not duplicate IDs already known from WS events', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1', running: true },
      { id: 'chat-2', running: true },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1', 'chat-2'])
  })

  it('handles empty chat list', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    state = reducer(state, makeChatsFulfilledAction([]))
    expect(selectRunningChatIds(root(state))).toEqual([])
  })

  it('handles chats without running field (e.g. from WS events)', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1' },
      { id: 'chat-2' },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual([])
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

  it('marks a chat running when the latest agent_turn is running', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, makeFulfilledAction('chat-1', [
      { content: { type: 'text' }, state: 'succeeded' },
      { content: { type: 'agent_turn' }, state: 'running' },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
  })

  it('marks a chat running when the latest agent_turn is pending', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, makeFulfilledAction('chat-1', [
      { content: { type: 'agent_turn' }, state: 'pending' },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
  })

  it('does not mark a chat running when the latest agent_turn is terminal', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, makeFulfilledAction('chat-1', [
      { content: { type: 'agent_turn' }, state: 'succeeded' },
      { content: { type: 'agent_turn' }, state: 'failed' },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual([])
  })

  it('ignores orphaned older agent_turns when the latest is terminal', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    // Messages ordered by created_at: old pending turn, then newer succeeded turn
    state = reducer(state, makeFulfilledAction('chat-1', [
      { content: { type: 'agent_turn' }, state: 'pending' },
      { content: { type: 'agent_turn' }, state: 'succeeded' },
    ]))
    // The latest agent_turn is 'succeeded', so the chat should NOT be running
    expect(selectRunningChatIds(root(state))).toEqual([])
  })

  it('clears running state when a refetch shows the latest agent_turn finished', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
    // Simulate a refetch where the latest turn has completed
    state = reducer(state, makeFulfilledAction('chat-1', [
      { content: { type: 'agent_turn' }, state: 'succeeded' },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual([])
  })
})

describe('cold-start hydration with real store', () => {
  it('populates runningChatIds when getChats fulfilled action is dispatched to the full store', async () => {
    const { configureStore } = await import('@reduxjs/toolkit')

    const store = configureStore({
      reducer: {
        derived: reducer,
        [api.reducerPath]: api.reducer,
      },
      middleware: (getDefault) => getDefault().concat(api.middleware),
    })

    // Simulate the fulfilled action as it would arrive from RTK Query
    const action = {
      type: `${api.reducerPath}/executeQuery/fulfilled`,
      payload: [
        { id: 'chat-a', running: true, workspaceId: 'ws-1', agentId: 'ag-1', title: 'Running', updatedAt: new Date().toISOString() },
        { id: 'chat-b', running: false, workspaceId: 'ws-1', agentId: 'ag-1', title: 'Idle', updatedAt: new Date().toISOString() },
        { id: 'chat-c', running: true, workspaceId: 'ws-1', agentId: 'ag-1', title: 'Also running', updatedAt: new Date().toISOString() },
      ],
      meta: {
        arg: {
          type: 'query' as const,
          endpointName: 'getChats',
          originalArgs: { workspaceId: 'ws-1' },
          queryCacheKey: 'getChats({"workspaceId":"ws-1"})',
        },
        requestId: 'real-store-test',
        requestStatus: 'fulfilled' as const,
        fulfilledTimeStamp: Date.now(),
      },
    }

    store.dispatch(action)

    const state = store.getState()
    expect(selectRunningChatIds(state as never)).toEqual(['chat-a', 'chat-c'])
  })
})
