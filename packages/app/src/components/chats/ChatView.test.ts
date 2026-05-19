import { describe, expect, it } from 'vitest'
import { chatRightPanelClassName, isSmallChatViewport, shouldOpenChatSidebarsByDefault } from './chatViewUtils'

describe('chat sidebar responsive defaults', () => {
  it('starts chat sidebars closed below the desktop breakpoint', () => {
    expect(shouldOpenChatSidebarsByDefault(767)).toBe(false)
  })

  it('starts chat sidebars open at the desktop breakpoint', () => {
    expect(shouldOpenChatSidebarsByDefault(768)).toBe(true)
  })

  it('detects small chat viewports below the desktop breakpoint', () => {
    expect(isSmallChatViewport(767)).toBe(true)
    expect(isSmallChatViewport(768)).toBe(false)
  })

  it('opens the mobile right panel as an absolute full-width overlay over the chat', () => {
    const className = chatRightPanelClassName(true, true)

    expect(className).toContain('absolute')
    expect(className).toContain('max-w-[290px]')
    expect(className).not.toContain('shrink-0 w-[290px]')
  })

  it('opens the desktop right panel as a 290px docked sibling column', () => {
    const className = chatRightPanelClassName(true, false)

    expect(className).toContain('w-[290px]')
    expect(className).toContain('shrink-0')
    expect(className).not.toContain('absolute')
  })

  it('collapses the panel to zero width when closed', () => {
    const closed = chatRightPanelClassName(false, false)

    expect(closed).toContain('w-0')
    expect(closed).not.toContain('w-[290px]')
  })
})
