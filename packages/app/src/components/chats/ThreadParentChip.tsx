import { Link } from 'react-router-dom'
import { CornerUpLeft } from 'lucide-react'
import { useGetChatQuery } from '@/store/api'
import { buildPath } from '@/router/nav'
import { useChatNav } from './ChatNavContext'

interface ThreadParentChipProps {
  /** The thread chat currently being viewed. */
  chatId: string
}

/**
 * "↩ From {parent chat title}" — back-link rendered above the
 * messages in a thread chat. Returns null when the chat has no
 * parent or the metadata hasn't loaded yet.
 *
 * The parent pointer is derived server-side from the message rows
 * (the anchor's `thread_chat_id` column) and exposed on the chat's
 * own GET response as `parentChatId` / `anchorMessageId` — see
 * `routes/chats.ts#getChat`. The chip doesn't try to find the
 * anchor by scanning loaded messages, so it works regardless of how
 * long the thread is or how far the user has scrolled.
 */
export function ThreadParentChip({ chatId }: ThreadParentChipProps) {
  const { data: chat } = useGetChatQuery(chatId, { skip: !chatId })
  const { data: parentChat } = useGetChatQuery(chat?.parentChatId ?? '', {
    skip: !chat?.parentChatId,
  })
  const chatNav = useChatNav()

  const parentChatId = chat?.parentChatId
  const anchorMessageId = chat?.anchorMessageId
  if (!parentChatId || !parentChat?.workspaceId) return null

  const href =
    chatNav.buildParentHref?.(parentChatId, anchorMessageId ?? undefined, parentChat.workspaceId) ??
    buildPath(parentChat.workspaceId, 'pinned', {
      chat: parentChatId,
      message: anchorMessageId ?? undefined,
    })
  const label = parentChat.title?.trim() || 'parent chat'

  return (
    <div className="flex justify-center px-6 pt-4">
      <Link
        to={href}
        title={`Open parent chat: ${label}`}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/50 bg-background/80 px-3 py-1 text-xs text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground"
      >
        <CornerUpLeft className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">From {label}</span>
      </Link>
    </div>
  )
}
