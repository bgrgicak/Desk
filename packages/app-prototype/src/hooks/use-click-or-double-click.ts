import { useCallback, useEffect, useRef } from 'react'

const DEFAULT_DELAY_MS = 250

/**
 * Builds an onClick handler that distinguishes single from double clicks
 * by deferring the single-click action by `delayMs`. A second click
 * within that window cancels the pending single-click and fires the
 * double-click action instead.
 *
 * Native `dblclick` runs both `click` handlers first, so it can't be
 * used to suppress them — hence the manual debounce.
 */
export function useClickOrDoubleClick<T>(
  onSingle: (value: T) => void,
  onDouble: (value: T) => void,
  delayMs: number = DEFAULT_DELAY_MS,
) {
  const pendingRef = useRef<{ timer: number; value: T } | null>(null)

  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timer)
        pendingRef.current = null
      }
    }
  }, [])

  return useCallback(
    (value: T) => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timer)
        pendingRef.current = null
        onDouble(value)
        return
      }
      const timer = window.setTimeout(() => {
        pendingRef.current = null
        onSingle(value)
      }, delayMs)
      pendingRef.current = { timer, value }
    },
    [onSingle, onDouble, delayMs],
  )
}
