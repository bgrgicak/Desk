import { describe, it, expect } from 'vitest'
import { applyEventToCache } from './middleware'
import { bumpFileChangeCounter, bumpWorkspaceChangeCounter, markChatRunning, markChatIdle } from '../slices/derivedSlice'

describe('applyEventToCache', () => {
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

    it('dispatches markChatIdle when agent_turn fails', () => {
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

      expect(dispatched).toContainEqual(markChatIdle('cht_1'))
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
