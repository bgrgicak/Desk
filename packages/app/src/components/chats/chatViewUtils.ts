import {
  DESKTOP_RIGHT_PANEL_BREAKPOINT,
  isSmallRightPanelViewport,
  shouldOpenRightPanelsByDefault,
} from '@/components/shared/rightPanelLayout'

export const DESKTOP_SIDEBAR_BREAKPOINT = DESKTOP_RIGHT_PANEL_BREAKPOINT

export function shouldOpenChatSidebarsByDefault(viewportWidth?: number) {
  return shouldOpenRightPanelsByDefault(viewportWidth)
}

export function isSmallChatViewport(viewportWidth?: number) {
  return isSmallRightPanelViewport(viewportWidth)
}
