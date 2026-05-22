import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@agent-desk/ui'
import {
  useGetChatQuery,
  useGetChatMessagesQuery,
  useGetMeQuery,
  useGetWorkspacesQuery,
} from '@/store/api'
import { useAvatarUrl } from '@/hooks/use-avatar'
import { useWorkspaceIconUrl } from '@/hooks/use-workspace-icon'
import { initialsOf } from '@/lib/initials'
import { roomColor } from '@/components/rooms/roomColor'
import { buildPath } from '@/router/nav'

interface MessageThreadButtonProps {
  /** The thread chat anchored at this message — `message.threadChatId`. */
  threadChatId: string
  /** Workspace the parent chat (and therefore the thread) lives in.
   *  Needed both for navigation and for resolving the workspace avatar. */
  workspaceId: string
}

/**
 * Always-visible "X replies" affordance shown under a message that
 * anchors a thread. Click navigates to the thread chat.
 *
 * Resolves its own data via RTK Query: the thread chat (for `unread`
 * and `title`) plus the chat's message list (for the reply count).
 * Both queries are cached + deduped — opening N anchor messages in
 * one viewport pays N _logical_ queries but the cache layer collapses
 * duplicates and serves cached entries instantly on revisits.
 *
 * Once the backend ships `chat.replyCount` (see
 * `packages/server/docs/plans/threads-nesting.md`), the per-thread
 * message query here goes away.
 */
export function MessageThreadButton({ threadChatId, workspaceId }: MessageThreadButtonProps) {
  const { data: threadChat } = useGetChatQuery(threadChatId)
  const { data: messagesResp } = useGetChatMessagesQuery({ chatId: threadChatId })
  const { data: me } = useGetMeQuery()
  const { data: workspaces } = useGetWorkspacesQuery()
  const userAvatar = useAvatarUrl(me?.id)
  const workspaceIcon = useWorkspaceIconUrl(workspaceId)

  const workspace = workspaces?.find(w => w.id === workspaceId)
  // Reply count: the thread's user/agent messages minus the seed one
  // the user typed to start it. We can't cheaply discriminate that
  // seed here, so the stub treats every message as a reply — the
  // count is "messages in the thread", which lines up with how Slack
  // / Linear surfaces threads. Backend can tighten this later.
  const replyCount = messagesResp?.items?.length ?? 0
  const unread = !!threadChat?.unread

  const href = buildPath(workspaceId, 'tasks', { chat: threadChatId })

  return (
    <Link
      to={href}
      title={threadChat?.title ?? 'Open thread'}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 rounded-md border border-border bg-background',
        'pl-1.5 pr-2.5 shadow-xs',
        'text-xs font-medium text-foreground',
        'transition-colors hover:bg-foreground/[0.04]',
      )}
    >
      {/* Avatar stack — user + workspace, 20 px each with a 6 px
          overlap. Mirrors the Figma `Avatar Stack` shape but tuned to
          the smaller button size. */}
      <span className="flex items-center -space-x-1.5 shrink-0">
        <AvatarPip
          label={me?.username ? initialsOf(me.username) : '?'}
          src={userAvatar}
          title={me?.username}
        />
        <AvatarPip
          label={workspace ? initialsOf(workspace.name) : '?'}
          src={workspaceIcon}
          tint={workspace ? roomColor({ bg: workspace.color }) : undefined}
          title={workspace?.name}
        />
      </span>
      <span className="whitespace-nowrap">
        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
      </span>
      {unread && (
        // Same blue dot the chat-sidebar row uses for unread state.
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" aria-label="Unread replies" />
      )}
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    </Link>
  )
}

function AvatarPip({
  label,
  src,
  tint,
  title,
}: {
  label: string
  src?: string | null
  tint?: string
  title?: string
}) {
  if (src) {
    return (
      <img
        src={src}
        alt={title ?? label}
        title={title}
        className="h-5 w-5 rounded-full ring-2 ring-background object-cover"
      />
    )
  }
  return (
    <span
      title={title}
      style={tint ? { backgroundColor: tint, color: 'white' } : undefined}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold ring-2 ring-background select-none',
        !tint && 'bg-muted text-foreground',
      )}
    >
      {label}
    </span>
  )
}
