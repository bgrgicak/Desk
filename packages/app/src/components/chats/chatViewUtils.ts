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

// The chat right panel is a docked sibling column that pushes the chat
// content left when open. When closed it collapses to zero width; the inner
// content unmounts so it doesn't tab-stop or steal scroll. On small screens
// it becomes a full-width overlay on top of the chat instead of squeezing it.
// The panel itself is transparent (no bg, no border) — it sits on the shell's
// blob backdrop just like the sidebar does.
export function chatRightPanelClassName(panelOpen: boolean, isSmallScreen: boolean) {
  // Width matches the AppShell sidebar (290 px) so the layout reads as a
  // mirrored three-column split: sidebar / chat / files+tasks.
  const base = 'shrink-0 flex flex-col overflow-hidden transition-all duration-300'
  if (!panelOpen) return `${base} w-0`
  if (isSmallScreen) return `${base} absolute inset-y-0 right-0 z-40 w-full max-w-[290px]`
  return `${base} w-[290px]`
}
