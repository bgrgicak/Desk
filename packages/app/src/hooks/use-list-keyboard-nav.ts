import { useCallback, useEffect, useRef, useState } from 'react'

export function useListKeyboardNav<T>({
  items,
  enabled,
  onSelect,
}: {
  items: readonly T[]
  enabled: boolean
  onSelect: (item: T, index: number) => void
}) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const itemRefs = useRef<(HTMLElement | null)[]>([])

  useEffect(() => {
    setSelectedIndex(0)
  }, [items.length, enabled])

  useEffect(() => {
    if (!enabled) return
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, enabled])

  const handleKeyDown = useCallback(
    (e: { key: string; preventDefault: () => void }): boolean => {
      if (!enabled) return false
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (items.length > 0) setSelectedIndex(i => (i + 1) % items.length)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (items.length > 0) setSelectedIndex(i => (i - 1 + items.length) % items.length)
        return true
      }
      if (e.key === 'Enter') {
        const item = items[selectedIndex]
        if (item !== undefined) {
          e.preventDefault()
          onSelect(item, selectedIndex)
          return true
        }
      }
      return false
    },
    [enabled, items, selectedIndex, onSelect]
  )

  const itemRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      itemRefs.current[index] = el
    },
    []
  )

  return { selectedIndex, handleKeyDown, itemRef }
}
