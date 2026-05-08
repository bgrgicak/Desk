import { describe, expect, it } from 'vitest'
import { appPreviewRefForContextItem } from './ContextDetail'

describe('appPreviewRefForContextItem', () => {
  it('routes chat .app directories through the chat AppPreview path', () => {
    expect(
      appPreviewRefForContextItem({
        id: '.chats/cht_abc/artifacts/todo.app',
        type: 'app',
      }),
    ).toEqual({ scope: 'chat', chatId: 'cht_abc', appName: 'todo' })
  })

  it('keeps library .app directories on the library AppPreview path', () => {
    expect(
      appPreviewRefForContextItem({
        id: 'todo.app',
        type: 'app',
      }),
    ).toEqual({ scope: 'library', appName: 'todo', appPath: 'todo.app' })
  })

  it('keeps nested library fragments on the exact app path', () => {
    expect(
      appPreviewRefForContextItem({
        id: 'Projects/Q2/todo.app/dist/fragments/list',
        type: 'file',
      }),
    ).toEqual({ scope: 'library', appName: 'todo', appPath: 'Projects/Q2/todo.app', fragment: 'list' })
  })

  it('ignores non-app files', () => {
    expect(
      appPreviewRefForContextItem({
        id: 'notes.md',
        type: 'file',
      }),
    ).toBeNull()
  })
})
