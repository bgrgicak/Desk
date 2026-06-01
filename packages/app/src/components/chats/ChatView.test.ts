import { describe, expect, it } from 'vitest'
import { isSmallChatViewport, shouldOpenChatSidebarsByDefault } from './chatViewUtils'

describe('chat sidebar responsive defaults', () => {
  it('starts chat sidebars closed below the desktop breakpoint', () => {
    expect(shouldOpenChatSidebarsByDefault(767)).toBe(false)
  })

  it('starts chat sidebars closed at the desktop breakpoint', () => {
    expect(shouldOpenChatSidebarsByDefault(768)).toBe(false)
    expect(shouldOpenChatSidebarsByDefault(1440)).toBe(false)
  })

  it('detects small chat viewports below the desktop breakpoint', () => {
    expect(isSmallChatViewport(767)).toBe(true)
    expect(isSmallChatViewport(768)).toBe(false)
  })
})
