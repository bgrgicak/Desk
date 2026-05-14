import { describe, expect, it } from 'vitest'
import { canRenderInline, inlineAppPreviewFor } from './InlineArtifactPreview'

describe('inlineAppPreviewFor', () => {
  it('previews bare .app artifact refs as library apps', () => {
    expect(inlineAppPreviewFor('task-list.app', 'task-list.app', 'inode/directory')).toEqual({
      scope: 'library',
      appName: 'task-list',
      appPath: 'task-list.app',
    })
  })

  it('previews chat artifact .app refs as chat apps', () => {
    expect(
      inlineAppPreviewFor(
        '.chats/cht_abc/artifacts/task-list.app',
        'task-list.app',
        'inode/directory',
      ),
    ).toEqual({ scope: 'chat', chatId: 'cht_abc', appName: 'task-list' })
  })

  it('previews app manifest refs through the same app resolver', () => {
    expect(
      inlineAppPreviewFor('task-list.app/desk.app.json', 'desk.app.json', 'application/json'),
    ).toEqual({ scope: 'library', appName: 'task-list', appPath: 'task-list.app' })
  })

  it('previews app fragment refs through the same app resolver', () => {
    expect(
      inlineAppPreviewFor(
        'task-list.app/dist/fragments/list/index.html',
        'index.html',
        'text/html',
      ),
    ).toEqual({ scope: 'library', appName: 'task-list', appPath: 'task-list.app', fragment: 'list' })
  })

  it('ignores non-app refs', () => {
    expect(inlineAppPreviewFor('notes.md', 'notes.md', 'text/markdown')).toBeNull()
  })
})

describe('canRenderInline', () => {
  it.each(['app', 'html', 'image', 'text', 'pdf', 'docx', 'video', 'audio'] as const)(
    'supports %s previews inline',
    (kind) => {
      expect(canRenderInline(kind)).toBe(true)
    },
  )

  it('rejects unknown previews', () => {
    expect(canRenderInline('unknown')).toBe(false)
  })
})
