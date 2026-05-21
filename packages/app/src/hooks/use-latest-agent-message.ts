import { useGetChatMessagesQuery } from '@/store/api'

export interface LatestAgentMessage {
  /** Plain-text preview shown in the card body. */
  text: string
  /** When the message was sent — used as the card's "last update" time. */
  createdAt: Date
}

/**
 * Returns the most recent agent text message in a chat — used by
 * `TaskCard` to surface "what's happening" on the card body and as
 * the card's last-update timestamp, instead of statically echoing the
 * user's original task description and creation date.
 *
 * Returns `undefined` when:
 *   • `chatId` is omitted (e.g. mock-data cards with no backing chat),
 *   • the chat has no agent messages yet (the user just created the
 *     task and the agent hasn't replied), or
 *   • the latest agent message isn't plain text (the card preview only
 *     handles `content.type === 'text'`).
 *
 * Callers fall back to the user's task body + creation date.
 *
 * `useGetChatMessagesQuery` is cached per chatId by RTK Query, so
 * multiple `TaskCard`s pointing at the same chat share a single fetch.
 */
export function useLatestAgentMessage(chatId?: string): LatestAgentMessage | undefined {
  const { data } = useGetChatMessagesQuery(
    { chatId: chatId ?? '' },
    { skip: !chatId },
  )
  if (!data?.items?.length) return undefined
  for (let i = data.items.length - 1; i >= 0; i--) {
    const m = data.items[i]
    if (m.role !== 'agent') continue
    if (m.content.type !== 'text') continue
    const text = m.content.text.trim()
    if (text.length > 0) {
      return { text, createdAt: new Date(m.createdAt) }
    }
  }
  return undefined
}
