import { useMemo } from 'react'
import type { Chat as UiChat } from '@/data/ui-types'
import type { ServerMessage } from '@/store/types'
import { useGetMessagesQuery } from '@/store/api'

/**
 * Resolved parent/child link for one chat in a workspace.
 *
 * `parentChatId` and `anchorMessageId` mirror the optional fields the
 * server will eventually carry on `Chat` itself (see
 * `packages/server/docs/plans/threads-nesting.md`). Until that lands,
 * `useChatHierarchy` derives them from the existing
 * `message.threadChatId` back-ref so the UI can be built against the
 * target shape today.
 */
export interface ThreadLink {
  parentChatId: string
  anchorMessageId: string
}

export interface ChatHierarchy {
  /** Top-level chats — every chat that is NOT a thread. Order preserved
   *  from the input. */
  topLevel: UiChat[]
  /** Child threads bucketed under their parent chat id, in input order.
   *  Each entry's value is the array of thread chats (top-level chats
   *  that are themselves parents would not appear here as values, only
   *  as keys). */
  childrenByParent: Map<string, UiChat[]>
  /** parentChatId / anchorMessageId for every thread chat, keyed by the
   *  child (thread) chat id. */
  linkByChild: Map<string, ThreadLink>
  /** Convenience: number of threads anchored in a given parent chat. */
  threadCountOf: (parentChatId: string) => number
  /** Convenience: the parent of a given chat, if it is a thread. */
  parentOf: (chatId: string) => UiChat | undefined
}

/**
 * Derive the parent → child thread relationships for every chat in
 * `chats`. Two sources are merged, in priority order:
 *
 * 1. **Authoritative**: `chat.parentChatId` / `chat.anchorMessageId`
 *    when the server populates them. This is the target shape after
 *    the backend migration in
 *    `packages/server/docs/plans/threads-nesting.md`.
 * 2. **Stub fallback**: reverse-walk the existing
 *    `message.threadChatId` back-refs. Any message that points to a
 *    thread chat is its anchor, and the message's own `chatId` is the
 *    parent. This branch goes away once the backend writes the
 *    columns directly.
 *
 * The hook is workspace-scoped because the underlying message query
 * is. Pass `undefined` to skip the fetch entirely (during boot before
 * a workspace is selected).
 */
export function useChatHierarchy(
  chats: UiChat[] | undefined,
  workspaceId: string | undefined,
): ChatHierarchy {
  // Stub-only query: fetch the workspace's chat-kind messages so we
  // can reverse-walk `threadChatId`. Only `chat` messages can anchor a
  // thread, so the kind filter keeps the payload reasonable. Once the
  // backend populates `chat.parentChatId` directly, this query can be
  // deleted along with the message-walk branch below.
  const { data: msgResp } = useGetMessagesQuery(
    { workspaceId: workspaceId ?? '', kind: ['chat'] },
    { skip: !workspaceId },
  )

  return useMemo(() => {
    const linkByChild = new Map<string, ThreadLink>()

    // Authoritative pass — server-populated fields win.
    for (const c of chats ?? []) {
      if (c.parentChatId && c.anchorMessageId) {
        linkByChild.set(c.id, {
          parentChatId: c.parentChatId,
          anchorMessageId: c.anchorMessageId,
        })
      }
    }

    // Stub fallback — fill in any chat we don't already have a link
    // for by walking anchor messages.
    if (msgResp?.items) {
      for (const m of msgResp.items as ServerMessage[]) {
        if (!m.threadChatId || linkByChild.has(m.threadChatId)) continue
        linkByChild.set(m.threadChatId, {
          parentChatId: m.chatId,
          anchorMessageId: m.id,
        })
      }
    }

    // Bucket children under their parents, preserving the chats array
    // order so the sidebar's recency sort flows through unchanged.
    const childrenByParent = new Map<string, UiChat[]>()
    const topLevel: UiChat[] = []
    const knownChatIds = new Set((chats ?? []).map(c => c.id))

    for (const c of chats ?? []) {
      const link = linkByChild.get(c.id)
      // Only treat the chat as a child when its parent is also in the
      // current list. An orphaned thread (parent loaded later / never)
      // surfaces at the top level so it isn't lost.
      if (link && knownChatIds.has(link.parentChatId)) {
        const bucket = childrenByParent.get(link.parentChatId) ?? []
        bucket.push(c)
        childrenByParent.set(link.parentChatId, bucket)
      } else {
        topLevel.push(c)
      }
    }

    const byId = new Map((chats ?? []).map(c => [c.id, c]))

    return {
      topLevel,
      childrenByParent,
      linkByChild,
      threadCountOf: (parentChatId: string) =>
        childrenByParent.get(parentChatId)?.length ?? 0,
      parentOf: (chatId: string) => {
        const link = linkByChild.get(chatId)
        return link ? byId.get(link.parentChatId) : undefined
      },
    }
  }, [chats, msgResp])
}

