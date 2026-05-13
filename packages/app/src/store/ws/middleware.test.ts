import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { applyEventToCache, logEntryFromWsPayload, wsMiddleware } from './middleware'
import { bumpFileChangeCounter, bumpWorkspaceChangeCounter, markChatRunning, markChatIdle, markChatFailed } from '../slices/derivedSlice'
import { api } from '../api'

describe('applyEventToCache', () => {
  describe('message.log_appended parsing', () => {
    it('treats OpenCode stdout JSON as a live structured event', () => {
      expect(logEntryFromWsPayload({
        type: 'message.log_appended',
        payload: {
          messageId: 'msg_turn',
          kind: 'stdout',
          line: JSON.stringify({ type: 'reasoning', part: { text: 'Looking at the code.' } }),
        },
      })).toEqual({
        kind: 'event',
        event: { type: 'reasoning', part: { text: 'Looking at the code.' } },
      })
    })

    it('patches the active chat-message cache immediately for live progress', async () => {
      const store = configureStore({
        reducer: { [api.reducerPath]: api.reducer },
        middleware: (getDefault) => getDefault().concat(api.middleware),
      })
      await store.dispatch(api.util.upsertQueryData('getChatMessages', { chatId: 'cht_1', full: false }, {
        items: [{
          id: 'msg_turn', chatId: 'cht_1', role: 'system', state: 'running',
          content: { type: 'agent_turn', userMessageId: 'msg_user' },
          createdAt: new Date().toISOString(),
        }],
      }))

      applyEventToCache(store.dispatch, {
        type: 'message.log_appended',
        payload: {
          messageId: 'msg_turn',
          kind: 'stdout',
          line: JSON.stringify({ type: 'tool_use', part: { tool: 'bash' } }),
        },
      }, 'cht_1', store.getState)

      const entry = api.endpoints.getChatMessages.select({ chatId: 'cht_1', full: false })(store.getState())
      expect(entry.data?.items[0].progressLog).toEqual([
        { kind: 'event', event: { type: 'tool_use', part: { tool: 'bash' } } },
      ])
    })

    it('merges pending live progress when the chat cache loads after the log event', async () => {
      const store = configureStore({
        reducer: { [api.reducerPath]: api.reducer },
        middleware: (getDefault) => getDefault().concat(api.middleware, wsMiddleware),
      })

      applyEventToCache(store.dispatch, {
        type: 'message.log_appended',
        payload: {
          messageId: 'msg_turn_late_cache',
          kind: 'stdout',
          line: JSON.stringify({ type: 'tool_use', part: { tool: 'read' } }),
        },
      }, 'cht_1', store.getState)

      await store.dispatch(api.util.upsertQueryData('getChatMessages', { chatId: 'cht_1', full: false }, {
        items: [{
          id: 'msg_turn_late_cache', chatId: 'cht_1', role: 'system', state: 'running',
          content: { type: 'agent_turn', userMessageId: 'msg_user' },
          createdAt: new Date().toISOString(),
        }],
      }))

      const entry = api.endpoints.getChatMessages.select({ chatId: 'cht_1', full: false })(store.getState())
      expect(entry.data?.items[0].progressLog).toEqual([
        { kind: 'event', event: { type: 'tool_use', part: { tool: 'read' } } },
      ])
    })
  })

  describe('library.changed', () => {
    it('dispatches bumpFileChangeCounter with the changed path', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'library.changed',
        payload: { workspaceId: 'wks_1', path: 'notes/foo.md', op: 'updated' },
      })

      expect(dispatched).toContainEqual(bumpFileChangeCounter('notes/foo.md'))
    })

    it('dispatches bumpFileChangeCounter on added op', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'library.changed',
        payload: { workspaceId: 'wks_1', path: 'docs/new.txt', op: 'added' },
      })

      expect(dispatched).toContainEqual(bumpFileChangeCounter('docs/new.txt'))
    })

    it('dispatches bumpFileChangeCounter on removed op', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'library.changed',
        payload: { workspaceId: 'wks_1', path: 'old/file.md', op: 'removed' },
      })

      expect(dispatched).toContainEqual(bumpFileChangeCounter('old/file.md'))
    })
  })

  describe('workspace.synced', () => {
    it('dispatches bumpWorkspaceChangeCounter with the workspaceId', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'workspace.synced',
        payload: { workspaceId: 'wks_1' },
      })

      expect(dispatched).toContainEqual(bumpWorkspaceChangeCounter('wks_1'))
    })
  })

  describe('message.appended', () => {
    it('invalidates Chat tags for a regular text message', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.appended',
        payload: {
          id: 'msg_1', chatId: 'cht_1', role: 'agent',
          content: { type: 'text', text: 'hello' },
          createdAt: new Date().toISOString(),
        },
      })

      const invalidateActions = dispatched.filter(
        (a) => (a as { type?: string }).type?.includes('invalidateTags'),
      )
      // Should have at least the Chat + Message invalidation
      expect(invalidateActions.length).toBeGreaterThanOrEqual(2)
    })

    it('does NOT invalidate Chat tags for an agent_turn message', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.appended',
        payload: {
          id: 'msg_2', chatId: 'cht_1', role: 'system',
          content: { type: 'agent_turn', userMessageId: 'msg_1' },
          createdAt: new Date().toISOString(),
        },
      })

      // Should dispatch the message-cache update and Message CROSS invalidation,
      // but NOT Chat tag invalidation.
      const hasChatInvalidation = dispatched.some((a) => {
        try { const s = JSON.stringify(a); return s?.includes('"Chat"') && s?.includes('"cht_1"') }
        catch { return false }
      })
      expect(hasChatInvalidation).toBe(false)
    })

    it('does NOT invalidate Chat tags for a summary message', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.appended',
        payload: {
          id: 'msg_3', chatId: 'cht_1', role: 'agent',
          content: { type: 'summary', body: '# Summary' },
          createdAt: new Date().toISOString(),
        },
      })

      const hasChatInvalidation = dispatched.some((a) => {
        try { const s = JSON.stringify(a); return s?.includes('"Chat"') && s?.includes('"cht_1"') }
        catch { return false }
      })
      expect(hasChatInvalidation).toBe(false)
    })

    it('invalidates Chat tags for an artifactRef message', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.appended',
        payload: {
          id: 'msg_ar', chatId: 'cht_1', role: 'agent',
          content: { type: 'artifactRef', path: 'artifacts/test.md', name: 'test.md' },
          createdAt: new Date().toISOString(),
        },
      })

      const hasChatInvalidation = dispatched.some((a) => {
        try { const s = JSON.stringify(a); return s?.includes('"Chat"') && s?.includes('"cht_1"') }
        catch { return false }
      })
      expect(hasChatInvalidation).toBe(true)
    })

    it('does NOT invalidate Chat tags for a message with kind="summary"', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.appended',
        payload: {
          id: 'msg_sk', chatId: 'cht_1', role: 'agent',
          content: { type: 'events', log: [] },
          kind: 'summary',
          createdAt: new Date().toISOString(),
        },
      })

      const hasChatInvalidation = dispatched.some((a) => {
        try { const s = JSON.stringify(a); return s?.includes('"Chat"') && s?.includes('"cht_1"') }
        catch { return false }
      })
      expect(hasChatInvalidation).toBe(false)
    })

    it('does NOT invalidate Chat tags for the currently-viewed chat', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.appended',
        payload: {
          id: 'msg_vc', chatId: 'cht_viewed', role: 'agent',
          content: { type: 'text', text: 'hello from agent' },
          createdAt: new Date().toISOString(),
        },
      }, 'cht_viewed')

      const hasChatInvalidation = dispatched.some((a) => {
        try { const s = JSON.stringify(a); return s?.includes('"Chat"') && s?.includes('"cht_viewed"') }
        catch { return false }
      })
      expect(hasChatInvalidation).toBe(false)
    })

    it('DOES invalidate Chat tags for a non-viewed chat with regular message', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.appended',
        payload: {
          id: 'msg_nv', chatId: 'cht_other', role: 'agent',
          content: { type: 'text', text: 'hello from agent' },
          createdAt: new Date().toISOString(),
        },
      }, 'cht_viewed')

      const hasChatInvalidation = dispatched.some((a) => {
        try { const s = JSON.stringify(a); return s?.includes('"Chat"') && s?.includes('"cht_other"') }
        catch { return false }
      })
      expect(hasChatInvalidation).toBe(true)
    })

    it('fires markChatReadQuietly (no Chat tag invalidation) for a viewed-chat non-internal message', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      // Mock fetch — markChatReadQuietly calls it but we can't easily
      // verify the call without mocking the auth module; just verify
      // no Chat tag invalidation and that the cache was patched.
      const origFetch = globalThis.fetch
      globalThis.fetch = () => Promise.resolve(new Response('{}', { status: 200 }))

      try {
        applyEventToCache(dispatch, {
          type: 'message.appended',
          payload: {
            id: 'msg_qm', chatId: 'cht_viewed', role: 'agent',
            content: { type: 'events', log: [{ kind: 'stderr', line: 'hi' }] },
            createdAt: new Date().toISOString(),
          },
        }, 'cht_viewed')

        // Should NOT invalidate Chat tags
        const hasChatInvalidation = dispatched.some((a) => {
          try { const s = JSON.stringify(a); return s?.includes('"Chat"') && s?.includes('"cht_viewed"') }
          catch { return false }
        })
        expect(hasChatInvalidation).toBe(false)

        // markChatReadQuietly dispatches updateQueryData patches (thunks)
        // which appear as functions or objects with endpointName.
        // The Message CROSS invalidation is always dispatched, so we check
        // that MORE actions were dispatched than the baseline (message cache
        // update + CROSS invalidation = 2).
        expect(dispatched.length).toBeGreaterThan(2)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('bumps the viewed chat above the cached newest chat without invalidating Chat tags', async () => {
      const store = configureStore({
        reducer: { [api.reducerPath]: api.reducer },
        middleware: (getDefault) => getDefault().concat(api.middleware),
      })
      const messageCreatedAt = '2026-01-01T00:05:00.000Z'

      await store.dispatch(api.util.upsertQueryData('getChats', { workspaceId: 'wks_1' }, [
        {
          id: 'cht_viewed', workspaceId: 'wks_1', agentId: 'agt_1', title: 'Viewed',
          updatedAt: '2026-01-01T00:00:00.000Z', awaitingUser: false, unread: false,
          kind: 'chat', running: false, failed: false,
        },
        {
          id: 'cht_other', workspaceId: 'wks_1', agentId: 'agt_1', title: 'Other',
          updatedAt: '2099-01-01T00:00:00.000Z', awaitingUser: false, unread: false,
          kind: 'chat', running: false, failed: false,
        },
      ]))

      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return store.dispatch(action as never) }

      applyEventToCache(dispatch, {
        type: 'message.appended',
        payload: {
          id: 'msg_vc_bump', chatId: 'cht_viewed', role: 'user',
          content: { type: 'text', text: 'push me up' },
          createdAt: messageCreatedAt,
        },
      }, 'cht_viewed', store.getState)

      const entry = api.endpoints.getChats.select({ workspaceId: 'wks_1' })(store.getState())
      expect(Date.parse(entry.data?.find((chat) => chat.id === 'cht_viewed')?.updatedAt ?? '')).toBeGreaterThan(Date.parse('2099-01-01T00:00:00.000Z'))
      expect(entry.data?.map((chat) => chat.id)).toEqual(['cht_viewed', 'cht_other'])

      const hasChatInvalidation = dispatched.some((a) => {
        try { const s = JSON.stringify(a); return s?.includes('invalidateTags') && s?.includes('"Chat"') }
        catch { return false }
      })
      expect(hasChatInvalidation).toBe(false)
    })

    it('uses getState to patch workspace-scoped caches when unscoped cache is empty', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      const origFetch = globalThis.fetch
      globalThis.fetch = () => Promise.resolve(new Response('{}', { status: 200 }))

      // Mock getState to simulate a workspace-scoped getChats cache
      // containing the target chat with unread=true.
      const mockGetState = () => ({
        api: {
          queries: {
            'getChats({"workspaceId":"wks_1"})': {
              data: [
                { id: 'cht_viewed', workspaceId: 'wks_1', unread: true, title: 'Test', agentId: 'agt_1', updatedAt: new Date().toISOString(), awaitingUser: false },
              ],
            },
          },
        },
      })

      try {
        applyEventToCache(dispatch, {
          type: 'message.appended',
          payload: {
            id: 'msg_gs', chatId: 'cht_viewed', role: 'agent',
            content: { type: 'events', log: [{ kind: 'event', event: { type: 'text', part: { text: 'hi' } } }] },
            createdAt: new Date().toISOString(),
          },
        }, 'cht_viewed', mockGetState)

        // markChatReadQuietly should have dispatched updateQueryData for
        // the workspace-scoped cache (found via getState). Verify we got
        // more dispatches than the baseline (cache update + CROSS + unscoped patch).
        // With getState, we should also get the workspace-scoped patch.
        // At minimum: 1 message cache update + 1 unscoped patch + 1 workspace-scoped patch
        expect(dispatched.length).toBeGreaterThan(3)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('does NOT invalidate Chat tags for a summary_request message', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.appended',
        payload: {
          id: 'msg_4', chatId: 'cht_1', role: 'system',
          content: { type: 'summary_request' },
          createdAt: new Date().toISOString(),
        },
      })

      const hasChatInvalidation = dispatched.some((a) => {
        try { const s = JSON.stringify(a); return s?.includes('"Chat"') && s?.includes('"cht_1"') }
        catch { return false }
      })
      expect(hasChatInvalidation).toBe(false)
    })
  })

  describe('chat.updated', () => {
    it('suppresses unread=true for the viewed chat', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'chat.updated',
        payload: {
          id: 'cht_viewed', workspaceId: 'wks_1', agentId: 'agt_1',
          title: 'Test', updatedAt: new Date().toISOString(),
          awaitingUser: false, unread: true,
        },
      }, 'cht_viewed')

      // Verify dispatch was called (for cache patches).
      // The updateQueryData dispatches are thunks so we just verify
      // something was dispatched and no Chat tag invalidation occurred.
      expect(dispatched.length).toBeGreaterThanOrEqual(2)
      // No Chat tag invalidation for chat.updated events.
      const hasChatInvalidation = dispatched.some((a) => {
        try { const s = JSON.stringify(a); return s?.includes('invalidateTags') && s?.includes('"Chat"') }
        catch { return false }
      })
      expect(hasChatInvalidation).toBe(false)
    })

    it('dispatches extra cache patches via markChatReadQuietly for viewed chat with unread=true', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'chat.updated',
        payload: {
          id: 'cht_viewed', workspaceId: 'wks_1', agentId: 'agt_1',
          title: 'Test', updatedAt: new Date().toISOString(),
          awaitingUser: false, unread: true,
        },
      }, 'cht_viewed')

      // markChatReadQuietly dispatches patchChatUnreadInCache (1 unscoped
      // thunk — the workspace-scoped branch can't resolve workspaceId from
      // the mock dispatch), plus the chat.updated handler dispatches 2
      // updateQueryData thunks (workspace-scoped + unscoped).
      // Total: at least 3.
      expect(dispatched.length).toBeGreaterThanOrEqual(3)

      // Compared to the non-viewed case, the viewed case should dispatch
      // MORE actions (the extra markChatReadQuietly patch).
      const nonViewedDispatched: unknown[] = []
      const nonViewedDispatch = (action: unknown) => { nonViewedDispatched.push(action); return action }
      applyEventToCache(nonViewedDispatch, {
        type: 'chat.updated',
        payload: {
          id: 'cht_other', workspaceId: 'wks_1', agentId: 'agt_1',
          title: 'Other', updatedAt: new Date().toISOString(),
          awaitingUser: false, unread: true,
        },
      }, 'cht_viewed')
      expect(dispatched.length).toBeGreaterThan(nonViewedDispatched.length)
    })

    it('does NOT fire markChatReadQuietly for viewed chat with unread=false', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }
      const origFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = (async () => {
        fetchCalled = true
        return new Response(null, { status: 200 })
      }) as typeof fetch
      try {
        applyEventToCache(dispatch, {
          type: 'chat.updated',
          payload: {
            id: 'cht_viewed', workspaceId: 'wks_1', agentId: 'agt_1',
            title: 'Test', updatedAt: new Date().toISOString(),
            awaitingUser: false, unread: false,
          },
        }, 'cht_viewed')

        expect(fetchCalled).toBe(false)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('dispatches cache patches for non-viewed chats', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'chat.updated',
        payload: {
          id: 'cht_other', workspaceId: 'wks_1', agentId: 'agt_1',
          title: 'Other Chat', updatedAt: new Date().toISOString(),
          awaitingUser: false, unread: true,
        },
      }, 'cht_viewed')

      // Both workspace-scoped and unscoped cache patches
      expect(dispatched.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('running chat tracking', () => {
    it('dispatches markChatRunning for a pending agent_turn', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.appended',
        payload: {
          id: 'msg_at1', chatId: 'cht_1', role: 'system',
          content: { type: 'agent_turn', userMessageId: 'msg_u1' },
          state: 'pending',
          createdAt: new Date().toISOString(),
        },
      })

      expect(dispatched).toContainEqual(markChatRunning('cht_1'))
    })

    it('dispatches markChatRunning for a running agent_turn', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.updated',
        payload: {
          id: 'msg_at1', chatId: 'cht_1', role: 'system',
          content: { type: 'agent_turn', userMessageId: 'msg_u1' },
          state: 'running',
          createdAt: new Date().toISOString(),
        },
      })

      expect(dispatched).toContainEqual(markChatRunning('cht_1'))
    })

    it('dispatches markChatIdle when agent_turn succeeds', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.updated',
        payload: {
          id: 'msg_at1', chatId: 'cht_1', role: 'system',
          content: { type: 'agent_turn', userMessageId: 'msg_u1' },
          state: 'succeeded',
          createdAt: new Date().toISOString(),
        },
      })

      expect(dispatched).toContainEqual(markChatIdle('cht_1'))
    })

    it('dispatches markChatFailed when agent_turn fails', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.updated',
        payload: {
          id: 'msg_at1', chatId: 'cht_1', role: 'system',
          content: { type: 'agent_turn', userMessageId: 'msg_u1' },
          state: 'failed',
          createdAt: new Date().toISOString(),
        },
      })

      expect(dispatched).toContainEqual(markChatFailed('cht_1'))
    })

    it('does not dispatch running actions for non-agent_turn messages', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'message.appended',
        payload: {
          id: 'msg_t1', chatId: 'cht_1', role: 'agent',
          content: { type: 'text', text: 'hello' },
          state: 'succeeded',
          createdAt: new Date().toISOString(),
        },
      })

      const hasRunning = dispatched.some(
        (a) => (a as { type?: string }).type?.includes('markChat'),
      )
      expect(hasRunning).toBe(false)
    })
  })

  describe('chat deletion cleans up running state', () => {
    it('dispatches markChatIdle when a chat is deleted', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      applyEventToCache(dispatch, {
        type: 'chat.deleted',
        payload: { chatId: 'cht_1', workspaceId: 'ws_1' },
      })

      const idleActions = dispatched.filter(
        (a) => (a as { type?: string }).type === 'derived/markChatIdle',
      )
      expect(idleActions).toHaveLength(1)
      expect((idleActions[0] as { payload: string }).payload).toBe('cht_1')
    })
  })

  describe('artifact.created', () => {
    it('dispatches pushArtifactUpdate with the artifact details', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      const now = new Date().toISOString()
      applyEventToCache(dispatch, {
        type: 'artifact.created',
        payload: {
          path: 'workspaces/wks_1/chats/cht_1/report.md',
          name: 'report.md',
          mime: 'text/markdown',
          size: 512,
          createdAt: now,
        },
      })

      const updateActions = dispatched.filter(
        (a) => (a as { type?: string }).type === 'derived/pushArtifactUpdate',
      )
      expect(updateActions.length).toBeGreaterThan(0)
      const payload = (updateActions[0] as { payload: { message: string } }).payload
      expect(payload.message).toContain('report.md')
    })
  })
})
