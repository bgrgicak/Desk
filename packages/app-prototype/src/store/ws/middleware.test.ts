import { describe, it, expect } from 'vitest'
import { applyEventToCache } from './middleware'
import { bumpFileChangeCounter } from '../slices/derivedSlice'

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

  describe('artifact.created', () => {
    it('dispatches pushArtifactUpdate with the artifact details', () => {
      const dispatched: unknown[] = []
      const dispatch = (action: unknown) => { dispatched.push(action); return action }

      const now = new Date().toISOString()
      applyEventToCache(dispatch, {
        type: 'artifact.created',
        payload: {
          id: 'file_1',
          path: 'workspaces/wks_1/chats/cht_1/report.md',
          name: 'report.md',
          mimeType: 'text/markdown',
          size: 512,
          workspaceId: 'wks_1',
          createdAt: now,
          updatedAt: now,
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
