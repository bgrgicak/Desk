export const DESKTOP_RIGHT_PANEL_BREAKPOINT = 768

// Right panels start open at desktop widths and collapsed below the
// breakpoint, so phone/narrow-window users get the chat / preview pane
// uncluttered. The caller persists the actual open state per chat / item.
export function shouldOpenRightPanelsByDefault(viewportWidth?: number) {
  const width = viewportWidth ?? (typeof window === 'undefined' ? DESKTOP_RIGHT_PANEL_BREAKPOINT : window.innerWidth)
  return width >= DESKTOP_RIGHT_PANEL_BREAKPOINT
}

export function isSmallRightPanelViewport(viewportWidth?: number) {
  const width = viewportWidth ?? (typeof window === 'undefined' ? DESKTOP_RIGHT_PANEL_BREAKPOINT : window.innerWidth)
  return width < DESKTOP_RIGHT_PANEL_BREAKPOINT
}

export function rightPanelClassName(
  panelOpen: boolean,
  isSmallScreen: boolean,
  desktopWidthClass = 'w-[280px]',
) {
  const base = 'shrink-0 flex flex-col border-l overflow-hidden transition-all duration-300 bg-background'

  if (!panelOpen) return `${base} w-0 border-l-0`
  if (isSmallScreen) return `${base} absolute inset-y-0 right-0 z-40 w-full max-w-[320px] shadow-xl`
  return `${base} ${desktopWidthClass}`
}
