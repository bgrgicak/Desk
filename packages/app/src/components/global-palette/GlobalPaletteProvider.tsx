import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

interface GlobalPaletteContextValue {
  isOpen: boolean
  query: string
  open: (initial?: { query?: string }) => void
  close: () => void
  setQuery: (q: string) => void
}

const GlobalPaletteContext = createContext<GlobalPaletteContextValue | null>(null)

export function GlobalPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')

  const open = useCallback((initial?: { query?: string }) => {
    setQuery(initial?.query ?? '')
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  // Reset internal state once the close animation has had a chance to play.
  useEffect(() => {
    if (isOpen) return
    const t = setTimeout(() => {
      setQuery('')
    }, 200)
    return () => clearTimeout(t)
  }, [isOpen])

  // Global Cmd/Ctrl+K toggle.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setIsOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const value = useMemo<GlobalPaletteContextValue>(() => ({
    isOpen, query,
    open, close, setQuery,
  }), [isOpen, query, open, close])

  return (
    <GlobalPaletteContext.Provider value={value}>
      {children}
    </GlobalPaletteContext.Provider>
  )
}

export function useGlobalPalette(): GlobalPaletteContextValue {
  const ctx = useContext(GlobalPaletteContext)
  if (!ctx) throw new Error('useGlobalPalette must be used inside <GlobalPaletteProvider>')
  return ctx
}
