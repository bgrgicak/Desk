import { useLayoutEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { VisuallyHidden } from 'radix-ui'
import { useGlobalPalette } from './GlobalPaletteProvider'
import { GlobalPaletteSearch } from './GlobalPaletteSearch'
import type { NavTarget, SettingsTarget } from './searchTargets'

export interface GlobalPaletteNavActions {
  activeWorkspaceId?: string
  onNavigatePage: (target: NavTarget) => void
  onNavigateSettings: (target: SettingsTarget) => void
  onNavigateWorkspace: (workspaceId: string) => void
  onSelectChat: (chat: { id: string; workspaceId: string }) => void
  onSelectFile: (file: { path: string; workspaceId: string }) => void
}

const MAX_HEIGHT = 640
const MOBILE_EDGE_MARGIN = 16
const DESKTOP_TOP_OFFSET = 128
const DESKTOP_BOTTOM_MARGIN = 32

function getAvailablePaletteHeight() {
  if (typeof window === 'undefined') return MAX_HEIGHT

  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  const isDesktop = window.matchMedia('(min-width: 640px)').matches
  const reserved = isDesktop
    ? DESKTOP_TOP_OFFSET + DESKTOP_BOTTOM_MARGIN
    : MOBILE_EDGE_MARGIN * 2

  return Math.min(MAX_HEIGHT, Math.max(240, Math.floor(viewportHeight - reserved)))
}

/**
 * Measures its child's natural height. Used by the dialog shell to animate
 * height between view swaps. Capped at MAX_HEIGHT — when content is taller,
 * the inner area scrolls.
 */
function useContentHeight(deps: unknown[]): [React.RefObject<HTMLDivElement | null>, number, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(0)
  const [maxHeight, setMaxHeight] = useState(getAvailablePaletteHeight)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let frame: number | null = null
    const measure = () => {
      const next = Math.min(el.scrollHeight, maxHeight)
      setH(next)
    }
    const scheduleMeasure = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = null
        measure()
      })
    }
    measure()
    const ro = new ResizeObserver(scheduleMeasure)
    const mo = new MutationObserver(scheduleMeasure)
    ro.observe(el)
    mo.observe(el, { childList: true, subtree: true, attributes: true })
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, maxHeight])

  useLayoutEffect(() => {
    const updateMaxHeight = () => setMaxHeight(getAvailablePaletteHeight())
    updateMaxHeight()
    window.addEventListener('resize', updateMaxHeight)
    window.visualViewport?.addEventListener('resize', updateMaxHeight)
    return () => {
      window.removeEventListener('resize', updateMaxHeight)
      window.visualViewport?.removeEventListener('resize', updateMaxHeight)
    }
  }, [])

  return [ref, h, maxHeight]
}

export function GlobalPalette(props: GlobalPaletteNavActions) {
  const { isOpen, query, close } = useGlobalPalette()
  const [measureRef, contentHeight, maxHeight] = useContentHeight([isOpen, query])
  const listMaxHeight = Math.max(160, maxHeight - 48)

  // Close palette before invoking nav actions so the route change happens
  // against a clean DOM.
  const wrap = <T,>(fn: (arg: T) => void) => (arg: T) => { close(); fn(arg) }

  const navProps = {
    activeWorkspaceId: props.activeWorkspaceId,
    onNavigatePage: wrap(props.onNavigatePage),
    onNavigateSettings: wrap(props.onNavigateSettings),
    onNavigateWorkspace: wrap(props.onNavigateWorkspace),
    onSelectChat: wrap(props.onSelectChat),
    onSelectFile: wrap(props.onSelectFile),
  }

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(o) => { if (!o) close() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
        />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-4 sm:top-32 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-xl rounded-lg border bg-popover shadow-lg outline-none overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95"
          aria-describedby={undefined}
        >
          <VisuallyHidden.Root>
            <DialogPrimitive.Title>Search</DialogPrimitive.Title>
          </VisuallyHidden.Root>

          <motion.div
            animate={{ height: contentHeight || 'auto' }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            style={{ maxHeight }}
            className="relative overflow-hidden"
          >
            <div ref={measureRef}>
              <div className="flex min-h-0 flex-col" style={{ maxHeight }}>
                <GlobalPaletteSearch {...navProps} listMaxHeight={listMaxHeight} />
              </div>
            </div>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
