import { useGetChatMessagesQuery } from '@/store/api'
import { appAttachmentToPreview } from '@/components/context/AppPreview'
import { isRegularMessageVisible } from '@/components/compose/messageVisibility'
import type { ServerMessage } from '@/store/types'

interface LatestAgentTextMessage {
  kind: 'text'
  text: string
  createdAt: Date
}

interface LatestAgentFragmentMessage {
  kind: 'fragment'
  artifact: {
    path: string
    name?: string
    mime?: string
    workspaceId?: string
    params?: Record<string, string>
  }
  createdAt: Date
}

export type LatestAgentMessage = LatestAgentTextMessage | LatestAgentFragmentMessage

/**
 * Returns the most recent supported agent output in a chat — used by
 * Home cards to surface "what's happening" on the card body and as
 * the card's last-update timestamp, instead of statically echoing the
 * user's original task description and creation date.
 *
 * Returns `undefined` when:
 *   • `chatId` is omitted (e.g. mock-data cards with no backing chat),
 *   • the chat has no agent messages yet (the user just created the
 *     task and the agent hasn't replied), or
 *   • the latest visible message is not a supported agent preview
 *     shape. Text and app fragments are supported; user replies and
 *     other artifact refs deliberately do not fall back to older agent
 *     output because that would misrepresent the current action
 *     surface.
 *
 * Callers fall back to the user's task body + creation date.
 *
 * `useGetChatMessagesQuery` is cached per chatId by RTK Query, so
 * multiple `TaskCard`s pointing at the same chat share a single fetch.
 */
export function useLatestAgentMessage(chatId?: string): LatestAgentMessage | undefined {
  const { data } = useGetChatMessagesQuery(
    { chatId: chatId ?? '', full: true },
    { skip: !chatId },
  )
  return latestAgentMessageFromItems(data?.items)
}

export function latestAgentMessageFromItems(
  items: ServerMessage[] | undefined,
): LatestAgentMessage | undefined {
  if (!items?.length) return undefined
  let skippedFragmentAttachmentEvent = false
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]
    if (!isRegularMessageVisible(m)) continue
    if (m.role !== 'agent') return undefined

    if (m.content.type === 'events' && valueContainsAppFragmentRef(m.content.log)) {
      skippedFragmentAttachmentEvent = true
      continue
    }

    if (m.content.type === 'artifactRef') {
      const appPreview = appAttachmentToPreview(m.content.path)
      if (!appPreview?.fragment) return undefined
      return {
        kind: 'fragment',
        createdAt: new Date(m.createdAt),
        artifact: {
          path: m.content.path,
          ...(m.content.name ? { name: m.content.name } : {}),
          ...(m.content.mime ? { mime: m.content.mime } : {}),
          ...(m.content.workspaceId ? { workspaceId: m.content.workspaceId } : {}),
          ...(m.content.params ? { params: m.content.params } : {}),
        },
      }
    }

    if (skippedFragmentAttachmentEvent) return undefined

    if (m.content.type === 'text') {
      const text = m.content.text.trim()
      return text.length > 0
        ? { kind: 'text', text, createdAt: new Date(m.createdAt) }
        : undefined
    }

    return undefined
  }
  return undefined
}

function valueContainsAppFragmentRef(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\.app\/dist\/fragments\//.test(value)
  }
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(valueContainsAppFragmentRef)

  const record = value as Record<string, unknown>
  if (typeof record.path === 'string' && appAttachmentToPreview(record.path)?.fragment) {
    return true
  }
  return Object.values(record).some(valueContainsAppFragmentRef)
}
