import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createGlobalChat, sendGlobalChatMessage } from './globalChatStore'

export type GlobalPaletteView = 'search' | 'chat'

interface GlobalPaletteContextValue {
  isOpen: boolean
  view: GlobalPaletteView
  query: string
  chatId: string | null
  open: (initial?: { query?: string }) => void
  close: () => void
  setQuery: (q: string) => void
  /** Creates a new global chat and switches to chat view, sending the typed
   * text as the first message. */
  startNewChat: (firstMessage: string) => void
  /** Sends a follow-up message in the active chat. */
  sendMessage: (content: string) => void
  /** Open an existing global chat by id (selected from the search view). */
  openChat: (chatId: string) => void
  /** Return to the search view (e.g. from the chat back button). */
  showSearch: () => void
}

const GlobalPaletteContext = createContext<GlobalPaletteContextValue | null>(null)

export function GlobalPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [view, setView] = useState<GlobalPaletteView>('search')
  const [query, setQuery] = useState('')
  const [chatId, setChatId] = useState<string | null>(null)

  const open = useCallback((initial?: { query?: string }) => {
    setView('search')
    setQuery(initial?.query ?? '')
    setChatId(null)
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  // Reset internal state once the close animation has had a chance to play.
  useEffect(() => {
    if (isOpen) return
    const t = setTimeout(() => {
      setView('search')
      setQuery('')
      setChatId(null)
    }, 200)
    return () => clearTimeout(t)
  }, [isOpen])

  const startNewChat = useCallback((firstMessage: string) => {
    const trimmed = firstMessage.trim()
    if (!trimmed) return
    const { id } = createGlobalChat(trimmed)
    setChatId(id)
    setView('chat')
    setQuery('')
  }, [])

  const sendMessage = useCallback((content: string) => {
    if (!chatId) return
    const trimmed = content.trim()
    if (!trimmed) return
    sendGlobalChatMessage(chatId, trimmed)
  }, [chatId])

  const openChat = useCallback((id: string) => {
    setChatId(id)
    setView('chat')
  }, [])

  const showSearch = useCallback(() => {
    setView('search')
    setChatId(null)
    setQuery('')
  }, [])

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
    isOpen, view, query, chatId,
    open, close, setQuery,
    startNewChat, sendMessage, openChat, showSearch,
  }), [isOpen, view, query, chatId, open, close, startNewChat, sendMessage, openChat, showSearch])

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
