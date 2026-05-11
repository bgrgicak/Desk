import { useEffect, useState } from 'react'

const COMPACT_VIEWPORT_WIDTH = 700

function getViewportWidth(): number {
  if (typeof window === 'undefined') return Number.POSITIVE_INFINITY
  return window.visualViewport?.width ?? window.innerWidth
}

export function useCompactViewport(): boolean {
  const [isCompact, setIsCompact] = useState(() => getViewportWidth() <= COMPACT_VIEWPORT_WIDTH)

  useEffect(() => {
    const update = () => setIsCompact(getViewportWidth() <= COMPACT_VIEWPORT_WIDTH)

    update()
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)

    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
  }, [])

  return isCompact
}
