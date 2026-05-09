import { describe, expect, it } from 'vitest'
import { chatRightPanelClassName, isSmallChatViewport, shouldOpenChatSidebarsByDefault } from './chatViewUtils'

describe('chat sidebar responsive defaults', () => {
  it('starts chat sidebars closed by default on every viewport', () => {
    expect(shouldOpenChatSidebarsByDefault()).toBe(false)
  })

  it('detects small chat viewports below the desktop breakpoint', () => {
    expect(isSmallChatViewport(767)).toBe(true)
    expect(isSmallChatViewport(768)).toBe(false)
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
