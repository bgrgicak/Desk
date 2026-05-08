export const DESKTOP_SIDEBAR_BREAKPOINT = 768

export function shouldOpenChatSidebarsByDefault(viewportWidth?: number) {
  const width = viewportWidth ?? (typeof window === 'undefined' ? DESKTOP_SIDEBAR_BREAKPOINT : window.innerWidth)
  return width >= DESKTOP_SIDEBAR_BREAKPOINT
}

export function chatRightPanelClassName(panelOpen: boolean, isSmallScreen: boolean) {
  const base = 'shrink-0 flex flex-col border-l overflow-hidden transition-all duration-300 bg-background'

  if (!panelOpen) return `${base} w-0 border-l-0`
  if (isSmallScreen) return `${base} absolute inset-y-0 right-0 z-40 w-full max-w-[320px] shadow-xl`
  return `${base} w-[280px]`
}
