import { useEffect, useRef, useState } from 'react'

export function useScrolledUnder() {
  const ref = useRef<HTMLDivElement>(null)
  const [scrolledUnder, setScrolledUnder] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      setScrolledUnder(el.scrollHeight > el.clientHeight + el.scrollTop + 1)
    }
    update()
    el.addEventListener('scroll', update)
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', update); ro.disconnect() }
  }, [])
  return { ref, scrolledUnder }
}
