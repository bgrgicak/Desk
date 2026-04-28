import { useLayoutEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { VisuallyHidden } from 'radix-ui'
import { useGlobalPalette } from './GlobalPaletteProvider'
import { GlobalPaletteSearch } from './GlobalPaletteSearch'
import { GlobalPaletteChat } from './GlobalPaletteChat'
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

/**
 * Measures its child's natural height. Used by the dialog shell to animate
 * height between view swaps. Capped at MAX_HEIGHT — when content is taller,
 * the inner area scrolls.
 */
function useContentHeight(deps: unknown[]): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const next = Math.min(el.scrollHeight, MAX_HEIGHT)
      setH(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return [ref, h]
}

const slideFade = {
  initial: { opacity: 0, x: 8 },
  animate: { opacity: 1, x: 0 },
  exit:    { opacity: 0, x: -8 },
  transition: { duration: 0.15 },
}

export function GlobalPalette(props: GlobalPaletteNavActions) {
  const { isOpen, view, close } = useGlobalPalette()
  const [measureRef, contentHeight] = useContentHeight([view])

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
          className="fixed left-1/2 top-32 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-xl rounded-lg border bg-popover shadow-lg outline-none overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95"
          aria-describedby={undefined}
        >
          <VisuallyHidden.Root>
            <DialogPrimitive.Title>Search and Ask AI</DialogPrimitive.Title>
          </VisuallyHidden.Root>

          <motion.div
            animate={{ height: contentHeight || 'auto' }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            style={{ maxHeight: MAX_HEIGHT }}
            className="relative"
          >
            <div ref={measureRef}>
              <AnimatePresence mode="wait" initial={false}>
                {view === 'search' && (
                  <motion.div key="search" {...slideFade} className="flex flex-col" style={{ maxHeight: MAX_HEIGHT }}>
                    <GlobalPaletteSearch {...navProps} />
                  </motion.div>
                )}
                {view === 'chat' && (
                  <motion.div key="chat" {...slideFade} className="flex flex-col" style={{ height: MAX_HEIGHT }}>
                    <GlobalPaletteChat />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

