import {
  DESKTOP_RIGHT_PANEL_BREAKPOINT,
  isSmallRightPanelViewport,
  rightPanelClassName,
  shouldOpenRightPanelsByDefault,
} from '@/components/shared/rightPanelLayout'

export const DESKTOP_SIDEBAR_BREAKPOINT = DESKTOP_RIGHT_PANEL_BREAKPOINT

export function shouldOpenChatSidebarsByDefault() {
  return shouldOpenRightPanelsByDefault()
}

export function isSmallChatViewport(viewportWidth?: number) {
  return isSmallRightPanelViewport(viewportWidth)
}

export function chatRightPanelClassName(panelOpen: boolean, isSmallScreen: boolean) {
  return rightPanelClassName(panelOpen, isSmallScreen)
}
