import { describe, expect, it } from 'vitest'
import { appPreviewRefForContextItem } from './ContextDetail'
import { rightPanelClassName, shouldOpenRightPanelsByDefault } from '@/components/shared/rightPanelLayout'

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

describe('library item right panel layout', () => {
  it('defaults library item sidebars closed like chat sidebars', () => {
    expect(shouldOpenRightPanelsByDefault()).toBe(false)
  })

  it('fully collapses the right panel without hiding it behind desktop-only classes', () => {
    const className = rightPanelClassName(false, false, 'w-[380px]')

    expect(className).toContain('w-0')
    expect(className).toContain('border-l-0')
    expect(className.split(' ')).not.toContain('hidden')
    expect(className.split(' ')).not.toContain('lg:flex')
  })

  it('uses the library detail width on desktop and overlay styling on small screens', () => {
    expect(rightPanelClassName(true, false, 'w-[380px]')).toContain('w-[380px]')

    const mobileClassName = rightPanelClassName(true, true, 'w-[380px]')
    expect(mobileClassName).toContain('absolute')
    expect(mobileClassName).toContain('max-w-[320px]')
    expect(mobileClassName).not.toContain('w-[380px]')
  })
})
