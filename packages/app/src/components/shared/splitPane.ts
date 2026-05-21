import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Shared hooks for the two resizable "split" surfaces in the app:
 *
 *  - Chat view with the artifact **preview** open (AppShell): the chat
 *    column is the growing left pane, the preview is the fixed right.
 *  - Library **file detail** (ContextDetail): the file card is the
 *    growing left pane, the chat panel is the fixed right.
 *
 * They're mirror images of the same idea, so the drag math is
 * parameterised here rather than duplicated. The visible grab bar
 * lives in `SplitResizeHandle.tsx`. The avatar-overlay inset hook
 * (below) keeps the single global stack centred over whichever
 * column is "the conversation".
 */

// ── Avatar-overlay insets ────────────────────────────────────────────────

/**
 * Publishes the content-area insets the global avatar overlay
 * (AppShell, fixed at the top-bar row) reads, so the stack stays
 * centred over the conversation column:
 *
 *  - Chat view: left = sidebar width, right = preview width.
 *  - Library detail: left = file-card width, right = 0 (centred over
 *    the chat panel). IMPORTANT: callers should pass the *eventual*
 *    left even while the panel is closed, so showing it only fades /
 *    slides it down in place — it never travels horizontally.
 *
 * The optional `avatar` arg owns visibility + entrance via three CSS
 * vars: `--content-avatar-opacity` (0/1), `--content-avatar-ty`
 * (translateY — slides down from the top when it appears) and
 * `--content-avatar-delay` (a small show delay; 0 on hide). Views
 * that don't pass `avatar` leave the stack simply always present.
 */
export function useContentAreaInsets(
  left: string,
  right: string,
  avatar?: { hidden: boolean },
) {
  const hidden = avatar?.hidden
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--content-area-left-offset', left)
    root.style.setProperty('--content-area-right-offset', right)
    if (avatar) {
      if (hidden) {
        root.style.setProperty('--content-avatar-opacity', '0')
        root.style.setProperty('--content-avatar-ty', '-6px')
        root.style.setProperty('--content-avatar-delay', '0ms')
      } else {
        root.style.setProperty('--content-avatar-opacity', '1')
        root.style.setProperty('--content-avatar-ty', '0px')
        // Hold until the panel's 250 ms open animation has finished
        // (+ a small buffer) so the stack eases in *after* the
        // sidebar is open, not while it's still sliding.
        root.style.setProperty('--content-avatar-delay', '280ms')
      }
    }
    return () => {
      root.style.removeProperty('--content-area-left-offset')
      root.style.removeProperty('--content-area-right-offset')
      if (avatar) {
        root.style.removeProperty('--content-avatar-opacity')
        root.style.removeProperty('--content-avatar-ty')
        root.style.removeProperty('--content-avatar-delay')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, right, hidden, !!avatar])
}

// ── Drag-to-resize ───────────────────────────────────────────────────────

interface SplitResizeOptions {
  /** Reads the current split ratio at drag start (fraction of the
   *  viewport given to the growing LEFT pane, 0..1). */
  getStartRatio: () => number
  /** Live updates while dragging (clamped ratio). */
  onRatio: (ratio: number) => void
  /** Final ratio on mouse-up — persist it here. */
  onCommit: (ratio: number) => void
  /** Minimum px width of the growing left pane. */
  minLeftPx: number
  /** Minimum px width of the fixed right pane. */
  minRightPx: number
}

/**
 * Generalised version of AppShell's old `handleResizeStart`. The left
 * pane width is `ratio * viewportWidth`; dragging right grows it. The
 * ratio is clamped so neither pane drops below its min width. Pointer
 * listeners are document-level because the cursor leaves the thin hit
 * area within the first few px of motion.
 */
export function useSplitResize(opts: SplitResizeOptions) {
  const [isResizing, setIsResizing] = useState(false)
  // Keep the latest opts in a ref so the `onMouseDown` identity is
  // stable (no listener churn) while still calling the freshest
  // handlers. Synced via an effect rather than during render.
  const ref = useRef(opts)
  useEffect(() => {
    ref.current = opts
  })

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (typeof window === 'undefined') return
    e.preventDefault()
    const { getStartRatio, minLeftPx, minRightPx } = ref.current
    const startX = e.clientX
    const startRatio = getStartRatio()
    const viewportWidth = window.innerWidth
    if (viewportWidth <= minLeftPx + minRightPx) return
    const minRatio = minLeftPx / viewportWidth
    const maxRatio = (viewportWidth - minRightPx) / viewportWidth
    let lastRatio = startRatio
    setIsResizing(true)
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      const newLeftWidth = startRatio * viewportWidth + (ev.clientX - startX)
      const proposed = newLeftWidth / viewportWidth
      lastRatio = Math.min(maxRatio, Math.max(minRatio, proposed))
      ref.current.onRatio(lastRatio)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setIsResizing(false)
      ref.current.onCommit(lastRatio)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  return { isResizing, onMouseDown }
}
