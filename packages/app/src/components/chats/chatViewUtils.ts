import {
  DESKTOP_RIGHT_PANEL_BREAKPOINT,
  isSmallRightPanelViewport,
} from '@/components/shared/rightPanelLayout'

export const DESKTOP_SIDEBAR_BREAKPOINT = DESKTOP_RIGHT_PANEL_BREAKPOINT

export function shouldOpenChatSidebarsByDefault(_viewportWidth?: number) {
  return false
}

export function isSmallChatViewport(viewportWidth?: number) {
  return isSmallRightPanelViewport(viewportWidth)
}
