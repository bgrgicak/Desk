import { describe, expect, it } from 'vitest'
import { chatRightPanelClassName, shouldOpenChatSidebarsByDefault } from './chatViewUtils'

describe('chat sidebar responsive defaults', () => {
  it('starts chat sidebars closed below the desktop breakpoint', () => {
    expect(shouldOpenChatSidebarsByDefault(767)).toBe(false)
  })

  it('starts chat sidebars open at the desktop breakpoint', () => {
    expect(shouldOpenChatSidebarsByDefault(768)).toBe(true)
  })

  it('opens the mobile right panel as an overlay instead of shrinking chat', () => {
    const className = chatRightPanelClassName(true, true)

    expect(className).toContain('absolute')
    expect(className).toContain('w-full')
    expect(className).not.toContain('w-[280px]')
  })

  it('keeps the desktop right panel in the side-by-side layout', () => {
    const className = chatRightPanelClassName(true, false)

    expect(className).toContain('w-[280px]')
    expect(className).not.toContain('absolute')
  })
})
