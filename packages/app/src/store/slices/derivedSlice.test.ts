import { describe, it, expect } from 'vitest'
import reducer, {
  bumpFileChangeCounter,
  selectFileChangeCounter,
  markChatRunning,
  markChatIdle,
  clearWsKnownChatIds,
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

  it('adds to wsKnownChatIds on markChatRunning', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    expect(state.wsKnownChatIds).toEqual(['chat-1'])
  })

  it('adds to wsKnownChatIds on markChatIdle', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    state = reducer(state, markChatIdle('chat-1'))
    expect(state.wsKnownChatIds).toEqual(['chat-1'])
  })

  it('clearWsKnownChatIds empties the guard set', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    state = reducer(state, markChatIdle('chat-1'))
    expect(state.wsKnownChatIds).toEqual(['chat-1'])
    state = reducer(state, clearWsKnownChatIds())
    expect(state.wsKnownChatIds).toEqual([])
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

  it('hydrates running chat IDs from server response on cold start', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1', running: true },
      { id: 'chat-2', running: false },
      { id: 'chat-3', running: true },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1', 'chat-3'])
  })

  it('WS-known running chat is preserved when stale server says not running', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    // WS event fires — chat-ws is running
    state = reducer(state, markChatRunning('chat-ws'))
    // Stale getChats response arrives — server says chat-ws not running
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1', running: true },
      { id: 'chat-ws', running: false },
    ]))
    // chat-ws: WS said running → preserved even though server says not running
    // chat-1: NOT WS-known and server says running → added
    const running = selectRunningChatIds(root(state))
    expect(running).toContain('chat-ws')
    expect(running).toContain('chat-1')
  })

  it('ignores getChats response once WS has taken over (markChatIdle)', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    // Cold start: server says chat-1 is running
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1', running: true },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
    // WS says it finished
    state = reducer(state, markChatIdle('chat-1'))
    expect(selectRunningChatIds(root(state))).toEqual([])
    // Stale getChats refetch says it's still running — must be ignored
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1', running: true },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual([])
  })

  it('clearWsKnownChatIds re-enables full server hydration', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    // WS marks chat-1 idle (adds to wsKnownChatIds)
    state = reducer(state, markChatRunning('chat-1'))
    state = reducer(state, markChatIdle('chat-1'))
    // Simulate WS reconnect: clear the guard
    state = reducer(state, clearWsKnownChatIds())
    expect(state.wsKnownChatIds).toEqual([])
    // Server response is now trusted completely
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-2', running: true },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-2'])
  })

  it('handles empty chat list on cold start', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, makeChatsFulfilledAction([]))
    expect(selectRunningChatIds(root(state))).toEqual([])
  })

  it('handles chats without running field', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1' },
      { id: 'chat-2' },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual([])
  })

  it('reconnect cycle: WS events → disconnect → reconnect → server re-hydrates', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    // 1. Cold start: server says chat-1 is running
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1', running: true },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
    // 2. WS events take over
    state = reducer(state, markChatIdle('chat-1'))
    state = reducer(state, markChatRunning('chat-2'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-2'])
    // 3. Stale refetch arrives — chat-1 still shows running in DB snapshot,
    //    chat-2 not yet in snapshot. WS-known guard preserves both outcomes.
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1', running: true },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-2'])
    // 4. WS reconnects → clear the guard
    state = reducer(state, clearWsKnownChatIds())
    // 5. Fresh server response (post-reconnect) replaces state
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-3', running: true },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-3'])
  })

  it('clears wsKnownChatIds after fulfillment', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    expect(state.wsKnownChatIds).toEqual(['chat-1'])
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1', running: true },
    ]))
    expect(state.wsKnownChatIds).toEqual([])
  })

  // ── Race condition tests ──────────────────────────────────────────

  it('stale-refetch race: WS markChatIdle wins over stale server running=true', () => {
    // Scenario:
    // 1. Agent starts → WS markChatRunning
    // 2. In-flight fetch starts (server captures DB while agent is running)
    // 3. Agent finishes → WS markChatIdle (clears runningChatIds)
    // 4. Fetch completes with stale running=true
    //    → should NOT re-add the chat to runningChatIds

    let state = reducer(undefined, { type: '@@INIT' })
    // Step 1: WS marks chat running
    state = reducer(state, markChatRunning('chat-A'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-A'])

    // Step 3: WS marks chat idle (agent finished)
    state = reducer(state, markChatIdle('chat-A'))
    expect(selectRunningChatIds(root(state))).toEqual([])

    // Step 4: Stale fetch completes — server says running=true
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-A', running: true },
      { id: 'chat-B', running: false },
    ]))

    // chat-A should NOT be running — WS markChatIdle wins
    expect(selectRunningChatIds(root(state))).toEqual([])
  })

  it('stale-refetch race: WS markChatRunning wins over stale server running=false', () => {
    // Scenario:
    // 1. In-flight fetch starts (no running chats in DB yet)
    // 2. Agent starts → WS markChatRunning
    // 3. Fetch completes with stale running=false
    //    → should NOT remove the chat from runningChatIds

    let state = reducer(undefined, { type: '@@INIT' })
    // Step 2: WS marks chat running (during the fetch)
    state = reducer(state, markChatRunning('chat-A'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-A'])

    // Step 3: Stale fetch completes — server says not running
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-A', running: false },
    ]))

    // chat-A should still be running — WS markChatRunning wins
    expect(selectRunningChatIds(root(state))).toEqual(['chat-A'])
  })

  it('after clearWsKnownChatIds, server response is fully authoritative', () => {
    // Simulates WS reconnect: clearWsKnownChatIds is dispatched, then
    // the server refetch result should be trusted completely.

    let state = reducer(undefined, { type: '@@INIT' })
    // WS had marked a chat as running, but we missed the idle event
    state = reducer(state, markChatRunning('chat-stale'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-stale'])

    // WS reconnects: clear the guard
    state = reducer(state, clearWsKnownChatIds())

    // Server says chat-stale is NOT running — should be removed
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-stale', running: false },
      { id: 'chat-new', running: true },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-new'])
  })

  it('mix of WS-known and server-only chats are handled correctly', () => {
    let state = reducer(undefined, { type: '@@INIT' })

    // WS marks chat-1 running (will be WS-known)
    state = reducer(state, markChatRunning('chat-1'))

    // Server response has chat-1 running (stale but matches), chat-2
    // running (new), and chat-3 not running
    state = reducer(state, makeChatsFulfilledAction([
      { id: 'chat-1', running: true },
      { id: 'chat-2', running: true },
      { id: 'chat-3', running: false },
    ]))

    // chat-1: WS-known and running → kept
    // chat-2: NOT WS-known and server says running → added
    // chat-3: NOT WS-known and server says not running → not added
    const running = selectRunningChatIds(root(state))
    expect(running).toHaveLength(2)
    expect(running).toContain('chat-1')
    expect(running).toContain('chat-2')
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
    state = reducer(state, makeFulfilledAction('chat-1', [
      { content: { type: 'agent_turn' }, state: 'pending' },
      { content: { type: 'agent_turn' }, state: 'succeeded' },
    ]))
    expect(selectRunningChatIds(root(state))).toEqual([])
  })

  it('clears running state when a refetch shows the latest agent_turn finished', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, markChatRunning('chat-1'))
    expect(selectRunningChatIds(root(state))).toEqual(['chat-1'])
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
