import { useSyncExternalStore } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────

export interface GlobalChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  createdAt: number
  /** While streaming, the assistant message keeps growing. UI uses this to
   * show a typing indicator on the latest message. */
  streaming?: boolean
}

export interface GlobalChat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: GlobalChatMessage[]
}

interface State {
  chats: Record<string, GlobalChat>
  order: string[] // most-recent first
}

// ── Persistence ───────────────────────────────────────────────────────────

const STORAGE_KEY = 'roomy.globalChats.v1'

function loadState(): State {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (!raw) return { chats: {}, order: [] }
    const parsed = JSON.parse(raw) as Partial<State>
    return {
      chats: parsed.chats ?? {},
      order: parsed.order ?? [],
    }
  } catch {
    return { chats: {}, order: [] }
  }
}

function persist(state: State) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    }
  } catch {
    // localStorage may be unavailable (private mode, quota) — silently skip.
  }
}

// ── Store ─────────────────────────────────────────────────────────────────

let state: State = loadState()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

function setState(updater: (s: State) => State) {
  state = updater(state)
  persist(state)
  emit()
}

// ── Public API ────────────────────────────────────────────────────────────

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function deriveTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim().replace(/\s+/g, ' ')
  return trimmed.length > 50 ? trimmed.slice(0, 50) + '…' : (trimmed || 'New chat')
}

/** Mock AI response. Streams characters into the assistant message so the
 * chat UX feels alive while the backend is being built. Replace with a real
 * server call when wiring up. */
async function streamMockReply(chatId: string, _userMessage: string): Promise<void> {
  const reply =
    'This is a placeholder response from Roomy AI. The backend is not wired up yet — when it is, your conversation will be saved to your account and available across every workspace.'
  const messageId = uid('msg')
  setState(s => {
    const chat = s.chats[chatId]
    if (!chat) return s
    return {
      ...s,
      chats: {
        ...s.chats,
        [chatId]: {
          ...chat,
          messages: [...chat.messages, { id: messageId, role: 'agent', content: '', createdAt: Date.now(), streaming: true }],
          updatedAt: Date.now(),
        },
      },
    }
  })
  // Stream a few characters at a time.
  const chunkSize = 4
  for (let i = 0; i < reply.length; i += chunkSize) {
    await new Promise(r => setTimeout(r, 18))
    setState(s => {
      const chat = s.chats[chatId]
      if (!chat) return s
      const messages = chat.messages.map(m =>
        m.id === messageId ? { ...m, content: reply.slice(0, i + chunkSize) } : m,
      )
      return { ...s, chats: { ...s.chats, [chatId]: { ...chat, messages, updatedAt: Date.now() } } }
    })
  }
  setState(s => {
    const chat = s.chats[chatId]
    if (!chat) return s
    const messages = chat.messages.map(m =>
      m.id === messageId ? { ...m, content: reply, streaming: false } : m,
    )
    return { ...s, chats: { ...s.chats, [chatId]: { ...chat, messages, updatedAt: Date.now() } } }
  })
}

export function createGlobalChat(firstMessage: string): { id: string } {
  const id = uid('gchat')
  const now = Date.now()
  const userMsg: GlobalChatMessage = {
    id: uid('msg'),
    role: 'user',
    content: firstMessage,
    createdAt: now,
  }
  setState(s => ({
    chats: { ...s.chats, [id]: {
      id,
      title: deriveTitle(firstMessage),
      createdAt: now,
      updatedAt: now,
      messages: [userMsg],
    } },
    order: [id, ...s.order.filter(x => x !== id)],
  }))
  void streamMockReply(id, firstMessage)
  return { id }
}

export function sendGlobalChatMessage(chatId: string, content: string): void {
  const userMsg: GlobalChatMessage = {
    id: uid('msg'),
    role: 'user',
    content,
    createdAt: Date.now(),
  }
  setState(s => {
    const chat = s.chats[chatId]
    if (!chat) return s
    return {
      ...s,
      chats: { ...s.chats, [chatId]: {
        ...chat,
        messages: [...chat.messages, userMsg],
        updatedAt: Date.now(),
      } },
      order: [chatId, ...s.order.filter(x => x !== chatId)],
    }
  })
  void streamMockReply(chatId, content)
}

export function deleteGlobalChat(chatId: string): void {
  setState(s => {
    const { [chatId]: _, ...rest } = s.chats
    return { chats: rest, order: s.order.filter(x => x !== chatId) }
  })
}

// ── Hooks ─────────────────────────────────────────────────────────────────

const getSnapshot = () => state

export function useGlobalChats(): GlobalChat[] {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return s.order.map(id => s.chats[id]).filter(Boolean)
}

export function useGlobalChat(id: string | null): GlobalChat | null {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return id ? s.chats[id] ?? null : null
}
